import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  session,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  dialog,
  shell,
  protocol,
  clipboard,
  net,
} from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { createReadStream, statSync, openSync, readSync, closeSync } from 'node:fs'
import { Readable } from 'node:stream'
import {
  createHudOverlayWindow,
  createEditorWindow,
  createSourceSelectorWindow,
  createPermissionCheckerWindow,
  getPermissionCheckerWindow,
  createCountdownOverlayWindow,
  createNotesWindow,
  getHudOverlayWindow,
  HEADLESS,
} from './windows'
import { atomicWriteFile } from './ipc/atomicSave'
import { registerIpcHandlers } from './ipc/handlers'
import { getRecordingsDir, getUserDataDir } from './paths'
import {
  approveFilePath,
  isReadablePathAllowed,
  localMediaUrlToPath,
  normalizeExternalUrl,
} from './ipc/paths'
import { shouldSwallowMainProcessError } from './main-process-errors'
import { attachNavigationPolicy } from './navigationPolicy'
import {
  contentRangeHeader,
  parseRangeHeader,
  unsatisfiableContentRangeHeader,
} from './media/rangeRequests'
import { isPermissionAllowed, windowTypeForContents } from './windowPermissions'
import { checkLatestRelease } from './update-checker'
import {
  type AutoUpdaterController,
  availableDialogAction,
  createAutoUpdater,
  downloadedDialogAction,
  getUpdaterEligibility,
  parseUpdatePreferences,
  serializeUpdatePreferences,
  shouldRunLaunchCheck,
  UPDATE_PREFERENCES_FILE_NAME,
  type UpdateErrorKind,
  type UpdateProgressEvent,
} from './auto-updater'
import { scheduleRecordingsCleanup } from './recordingsCleanup'
import { buildIssueReportUrl, GITHUB_ISSUES_URL } from '../src/lib/supportLinks'
import { getMainLocale, mainT, setMainLocale } from './i18n'
import { mainLogBuffer } from './diagnostics/main-log-buffer'
import { getInstallChannel, offersUpdateCheck } from './install-channel'
import { buildTrayMenuTemplate } from './tray-menu'
import {
  type AboutFacts,
  COPYRIGHT,
  formatAboutDetail,
  PRODUCT_NAME,
  usesNativeAboutPanel,
} from './about'
import { buildEditMenuSubmenu, type EditorUndoRedoChannel, routeEditorUndoRedo } from './edit-menu'
import {
  acceleratorToBinding,
  GLOBAL_SHORTCUT_ACTIONS,
  type GlobalShortcutAction,
  GlobalShortcutManager,
  isGlobalBindingAllowed,
  persistStoredGlobalBinding,
  readStoredGlobalBindings,
  SHORTCUTS_FILE_NAME,
} from './globalShortcut'
import type { ShortcutBinding } from '../src/lib/shortcuts'

// Capture main-process console output from the very first line so a runtime
// error dialog / "Save diagnostics" report can include what led up to it.
mainLogBuffer.install()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LINUX_SESSION_TYPE = (process.env['XDG_SESSION_TYPE'] || '').toLowerCase()
const IS_LINUX_WAYLAND = process.platform === 'linux' && LINUX_SESSION_TYPE === 'wayland'

if (IS_LINUX_WAYLAND) {
  // Electron 39 can hard-crash on some Ubuntu Wayland GPU stacks during
  // startup. Use software rendering so the app launches reliably.
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
}

if (process.platform === 'darwin') {
  // A `getDisplayMedia({ audio: true })` request on macOS otherwise goes through the
  // CoreAudio tap API, which needs an audio-capture usage string in the *host*
  // process's Info.plist: absent when running from a terminal or IDE in dev, the
  // renderer crashes. Route the request through the Screen & System Audio
  // Recording permission instead (system audio on macOS is the native helper's job).
  app.commandLine.appendSwitch('disable-features', 'MacCatapLoopbackAudioForScreenShare')
}

// Resolved once at startup; `electron/paths.ts` owns the layout (lazy, testable).
const RECORDINGS_DIR = getRecordingsDir()

async function ensureRecordingsDir() {
  try {
    await fs.mkdir(RECORDINGS_DIR, { recursive: true })
    console.log('RECORDINGS_DIR:', RECORDINGS_DIR)
    console.log('User Data Path:', app.getPath('userData'))
  } catch (error) {
    console.error('Failed to create recordings directory:', error)
  }
}

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

// Window references
let mainWindow: BrowserWindow | null = null
let sourceSelectorWindow: BrowserWindow | null = null
let permissionCheckerWindow: BrowserWindow | null = null
let countdownOverlayWindow: BrowserWindow | null = null
let notesWindow: BrowserWindow | null = null
let tray: Tray | null = null
let selectedSourceName = ''
let selectedDesktopSourceId: string | null = null
let recordingActive = false
let shutdownInProgress = false
let shutdownFinished = false
let ipcRuntime: { shutdown: () => Promise<void> } | null = null
let runtimeErrorDialogOpen = false

// Register custom protocol for serving local media files to the renderer.
// In dev mode the renderer runs on http://localhost, which makes file:// URLs
// cross-origin. Electron 39 blocks cross-origin media loads even with
// webSecurity: false, so we serve files through a custom scheme instead.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-media',
    privileges: {
      stream: true,
      bypassCSP: true,
      supportFetchAPI: true,
      standard: true,
      secure: true,
      // The exporter's decoder loads a recording in CORS mode so the frames it
      // reads are not tainted; without this the scheme refuses such a request
      // outright and the media element reports a format error.
      corsEnabled: true,
    },
  },
])

const isMac = process.platform === 'darwin'
// macOS menu bar icons are 16pt; other trays expect 24px.
const trayIconSize = isMac ? 16 : 24

// Tray Icons
const defaultTrayIcon = getTrayIcon('capturia.png', trayIconSize)
const recordingTrayIcon = getTrayIcon('rec-button.png', trayIconSize)

function createWindow() {
  // Guard against duplicate HUDs (activate + tray + second-instance can race).
  if (mainWindow && !mainWindow.isDestroyed()) {
    return
  }
  mainWindow = createHudOverlayWindow()
}

/**
 * Test-only startup hook. `CAPTURIA_E2E_VIDEO` names a recording the app should
 * open the editor on directly, so an end-to-end spec never has to drive a real
 * capture to reach the export UI.
 *
 * Honoured only in unpackaged builds, and only for a file that exists. The path
 * is registered as readable so `local-media://` and `set-current-video-path`
 * accept a fixture that lives outside the recordings directory; the renderer
 * still has to ask for it, nothing here loads it behind the editor's back.
 */
function e2eStartupVideoPath(): string | null {
  if (app.isPackaged) return null
  const raw = process.env['CAPTURIA_E2E_VIDEO']?.trim()
  if (!raw) return null
  const resolved = path.resolve(raw)
  try {
    if (!statSync(resolved).isFile()) {
      console.warn(`CAPTURIA_E2E_VIDEO is not a file: ${resolved}`)
      return null
    }
  } catch (error) {
    console.warn(`CAPTURIA_E2E_VIDEO cannot be read: ${resolved}`, error)
    return null
  }
  approveFilePath(resolved)
  console.log(`[e2e] editor start-up video approved: ${resolved}`)
  return resolved
}

// Restore + show + focus the current main window (HUD or editor), or create the HUD.
function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    if (!HEADLESS) {
      mainWindow.show()
      mainWindow.focus()
    }
    return
  }
  createWindow()
}

// Only `app.requestSingleInstanceLock()`: an earlier PID-file lock was removed
// because a recycled PID made the app exit silently. Dev and packaged builds use
// different userData dirs, so they still run side by side.
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    showMainWindow()
  })
} else {
  app.quit()
}

function createTray() {
  tray = new Tray(defaultTrayIcon)
  // Left click (Windows) / click without context menu: bring the HUD back.
  tray.on('click', () => {
    showMainWindow()
  })
  tray.on('double-click', () => {
    showMainWindow()
  })
}

function getTrayIcon(filename: string, size: number) {
  return nativeImage
    .createFromPath(path.join(process.env.VITE_PUBLIC || RENDERER_DIST, filename))
    .resize({
      width: size,
      height: size,
      quality: 'best',
    })
}

// Main follows the renderer's language via the `set-locale` IPC; until the
// renderer announces one, fall back to the OS locale.
function currentLocale(): string {
  return getMainLocale()
}

function runtimeErrorText(
  locale: string,
  key: 'message' | 'detailPrefix' | 'report' | 'close',
): string {
  return mainT(locale, `common.electron.runtimeError.${key}`)
}

function normalizeRuntimeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim()
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error.trim()
  }
  if (error === null || error === undefined) {
    return 'Unknown error'
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function normalizeRuntimeErrorStack(error: unknown): string | null {
  if (error instanceof Error && typeof error.stack === 'string' && error.stack.trim().length > 0) {
    return error.stack
  }
  return null
}

async function showRuntimeErrorDialog(context: string, error: unknown): Promise<void> {
  if (runtimeErrorDialogOpen || !app.isReady()) {
    return
  }
  runtimeErrorDialogOpen = true

  const locale = currentLocale()
  const now = Date.now()
  const errorId = `CL-MAIN-${now.toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  const message = normalizeRuntimeErrorMessage(error)
  const stack = normalizeRuntimeErrorStack(error)
  const details = [
    `${runtimeErrorText(locale, 'detailPrefix')}: ${errorId}`,
    `Context: ${context}`,
    `Time: ${new Date(now).toISOString()}`,
    `Message: ${message}`,
    stack ? `Stack:\n${stack}` : null,
  ].filter((line): line is string => Boolean(line))

  const issueUrl = buildIssueReportUrl({
    title: `[Bug] Runtime error (${context})`,
    bodyLines: [
      '## Summary',
      runtimeErrorText(locale, 'message'),
      '',
      '## Reference',
      `- Error ID: ${errorId}`,
      `- Context: ${context}`,
      `- Time: ${new Date(now).toISOString()}`,
      `- Platform: ${process.platform} ${process.arch}`,
      `- Version: ${app.getVersion()} (${installChannel()})`,
      '',
      '## Error Message',
      message,
      ...(stack ? ['', '## Stack', '```', stack, '```'] : []),
      // buildIssueReportUrl truncates the body to keep the URL openable, so the
      // tail goes last and the parts above always survive.
      ...mainLogTailSection(),
    ],
  })

  try {
    const messageBoxOptions: Electron.MessageBoxOptions = {
      type: 'error',
      title: 'Capturia',
      message: runtimeErrorText(locale, 'message'),
      detail: details.join('\n\n'),
      buttons: [runtimeErrorText(locale, 'report'), runtimeErrorText(locale, 'close')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }
    const focusedWindow = BrowserWindow.getFocusedWindow()
    const result = focusedWindow
      ? await dialog.showMessageBox(focusedWindow, messageBoxOptions)
      : await dialog.showMessageBox(messageBoxOptions)
    if (result.response === 0) {
      await shell.openExternal(issueUrl)
    }
  } catch (dialogError) {
    console.error('Failed to display runtime error dialog:', dialogError)
  } finally {
    runtimeErrorDialogOpen = false
  }
}

function reportRuntimeError(context: string, error: unknown): void {
  if (shouldSwallowMainProcessError(error)) {
    // EPIPE / ECONNRESET / ERR_STREAM_DESTROYED from renderer reloads and DevTools
    // detaches are churn, not bugs: log and skip the dialog.
    const code = (error as NodeJS.ErrnoException).code
    console.warn(`[runtime-error] swallowed ${context}: ${code} ${(error as Error).message}`)
    return
  }
  console.error(`[runtime-error] ${context}`, error)
  void showRuntimeErrorDialog(context, error)
}

function trayText(
  locale: string,
  key: 'app' | 'recording' | 'stop' | 'open' | 'quit',
  source?: string,
): string {
  const keys = {
    app: 'common.electron.tray.openScreen',
    recording: 'common.electron.tray.recording',
    stop: 'common.electron.tray.stopRecording',
    open: 'common.electron.tray.open',
    quit: 'common.electron.tray.quit',
  } as const
  return mainT(locale, keys[key], { source: source ?? '' })
}

/**
 * The one rule every update affordance keys off: not on a package-manager
 * channel (Store, Flatpak, Snap, Nix) and not mid-recording. Recording is part
 * of the answer because a download would compete with the encoder, so the
 * tray and the app menu are rebuilt whenever the recording flag flips.
 */
function canOfferUpdateCheck(): boolean {
  return offersUpdateCheck(installChannel(), { recording: recordingActive })
}

function updateTrayMenu(recording: boolean = false) {
  if (!tray) return
  const locale = currentLocale()
  const trayIcon = recording ? recordingTrayIcon : defaultTrayIcon
  const trayToolTip = recording
    ? trayText(locale, 'recording', selectedSourceName)
    : trayText(locale, 'app')
  const menuTemplate = buildTrayMenuTemplate({
    recording,
    offersUpdateCheck: offersUpdateCheck(installChannel(), { recording }),
    nativeAboutPanel: usesNativeAboutPanel(process.platform),
    labels: {
      stopRecording: trayText(locale, 'stop'),
      open: trayText(locale, 'open'),
      checkForUpdates: menuLabel('actions.checkForUpdates', 'Check for Updates…'),
      about: menuLabel('actions.about', 'About Capturia'),
      saveDiagnostics: menuLabel('actions.saveDiagnostics', 'Save Diagnostics…'),
      quit: trayText(locale, 'quit'),
    },
    actions: {
      stopRecording: () => emitStopRecordingRequest(),
      open: () => showMainWindow(),
      checkForUpdates: () => {
        void checkForUpdates()
      },
      about: () => {
        void showAboutDialog()
      },
      saveDiagnostics: () => {
        void runSaveDiagnostics()
      },
      quit: () => app.quit(),
    },
  })
  tray.setImage(trayIcon)
  tray.setToolTip(trayToolTip)
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate))
}

function emitStopRecordingRequest(): void {
  if (!recordingActive) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('stop-recording-from-tray')
}

// ── Global (OS-level) shortcuts ─────────────────────────────────────────────
// `openApp` and `stopRecording` share one manager and are persisted in the same
// shortcuts.json the editor's ShortcutsConfigDialog writes (see globalShortcut.ts).
const SHORTCUTS_FILE = path.join(app.getPath('userData'), SHORTCUTS_FILE_NAME)
const globalShortcuts = new GlobalShortcutManager(globalShortcut, {
  openApp: () => showMainWindow(),
  stopRecording: () => emitStopRecordingRequest(),
})

async function loadAndRegisterGlobalShortcuts(): Promise<void> {
  const stored = await readStoredGlobalBindings(SHORTCUTS_FILE)
  globalShortcuts.registerAll(stored)
}

function isGlobalShortcutAction(value: unknown): value is GlobalShortcutAction {
  return typeof value === 'string' && (GLOBAL_SHORTCUT_ACTIONS as readonly string[]).includes(value)
}

function shortcutErrorMessage(
  error: 'empty' | 'conflict' | 'unavailable' | undefined,
): string | undefined {
  if (!error) return undefined
  return mainT(currentLocale(), `common.electron.shortcut.${error}`)
}

// ── Editor window helpers ──────────────────────────────────────────────────
function isEditorWindow(win: BrowserWindow | null | undefined): boolean {
  if (!win || win.isDestroyed()) return false
  try {
    return win.webContents.getURL().includes('windowType=editor')
  } catch {
    return false
  }
}

/** The editor renderer, when it is the focused window or the current main window. */
function editorTarget(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (isEditorWindow(focused)) return focused
  if (isEditorWindow(mainWindow)) return mainWindow
  return null
}

type EditorMenuChannel =
  | 'menu-import-video'
  | 'menu-export'
  | 'menu-return-to-recorder'
  | 'menu-toggle-timeline'
  | 'menu-toggle-settings'
  | 'menu-open-shortcuts'

/** Forward a menu action to the editor renderer; a no-op when no editor is open. */
function sendEditorMenuAction(channel: EditorMenuChannel): void {
  const target = editorTarget()
  if (!target) return
  target.webContents.send(channel)
}

function dispatchUndoRedo(channel: EditorUndoRedoChannel): void {
  const target = BrowserWindow.getFocusedWindow() ?? mainWindow
  routeEditorUndoRedo(channel, target, () => isEditorWindow(target))
}

// ── Flush-on-close (P3) ────────────────────────────────────────────────────
// The editor auto-saves on a 2 s debounce, so closing the window inside that
// window would drop the last edit. Main asks the renderer to flush first
// (`request-save-before-close` -> `save-before-close-done`) and waits at most
// EDITOR_FLUSH_TIMEOUT_MS before letting the close proceed.
const EDITOR_FLUSH_TIMEOUT_MS = 2000
type FlushState = { state: 'idle' | 'pending' | 'done' }
const editorFlushStates = new WeakMap<BrowserWindow, FlushState>()

function requestEditorFlush(win: BrowserWindow): Promise<void> {
  if (!isEditorWindow(win) || win.webContents.isLoading()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ipcMain.removeListener('save-before-close-done', onDone)
      resolve()
    }
    const onDone = (event: Electron.IpcMainEvent) => {
      if (event.sender === win.webContents) finish()
    }
    const timer = setTimeout(finish, EDITOR_FLUSH_TIMEOUT_MS)
    ipcMain.on('save-before-close-done', onDone)
    try {
      win.webContents.send('request-save-before-close')
    } catch {
      finish()
    }
  })
}

/** Flush the current editor (if any) and mark it so its close no longer waits. */
async function flushEditorBeforeQuit(): Promise<void> {
  const win = mainWindow
  if (!win || !isEditorWindow(win)) return
  const flush = editorFlushStates.get(win)
  if (flush?.state === 'done') return
  if (flush) flush.state = 'pending'
  try {
    await requestEditorFlush(win)
  } finally {
    if (flush) flush.state = 'done'
  }
}

function createEditorWindowWrapper() {
  if (mainWindow) {
    mainWindow.close()
    mainWindow = null
  }
  const win = createEditorWindow()
  mainWindow = win

  const flush: FlushState = { state: 'idle' }
  editorFlushStates.set(win, flush)
  win.on('close', (event) => {
    if (flush.state === 'done') return
    event.preventDefault()
    if (flush.state === 'pending') return
    flush.state = 'pending'
    void requestEditorFlush(win).finally(() => {
      flush.state = 'done'
      if (!win.isDestroyed()) win.close()
    })
  })
}

// ── Application menu (P6 / M10) ────────────────────────────────────────────
function menuLabel(key: string, fallback: string): string {
  const value = mainT(currentLocale(), `common.${key}`)
  return value === `common.${key}` ? fallback : value
}

/** "Check for Updates…" only where this install may offer one (see `canOfferUpdateCheck`). */
function checkForUpdatesMenuItems(): Electron.MenuItemConstructorOptions[] {
  if (!canOfferUpdateCheck()) return []
  return [
    {
      label: menuLabel('actions.checkForUpdates', 'Check for Updates…'),
      click: () => {
        void checkForUpdates()
      },
    },
  ]
}

function setupApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about', label: menuLabel('actions.about', 'About Capturia') },
        ...checkForUpdatesMenuItems(),
        { type: 'separator' },
        { role: 'services', label: menuLabel('actions.services', 'Services') },
        { type: 'separator' },
        { role: 'hide', label: menuLabel('actions.hide', 'Hide Capturia') },
        { role: 'hideOthers', label: menuLabel('actions.hideOthers', 'Hide Others') },
        { role: 'unhide', label: menuLabel('actions.unhide', 'Show All') },
        { type: 'separator' },
        { role: 'quit', label: menuLabel('actions.quit', 'Quit') },
      ],
    })
  }

  template.push(
    {
      label: menuLabel('actions.file', 'File'),
      submenu: [
        {
          label: menuLabel('actions.importVideo', 'Import Video…'),
          accelerator: 'CmdOrCtrl+O',
          click: () => sendEditorMenuAction('menu-import-video'),
        },
        {
          label: menuLabel('actions.export', 'Export…'),
          accelerator: 'CmdOrCtrl+E',
          click: () => sendEditorMenuAction('menu-export'),
        },
        { type: 'separator' },
        {
          label: menuLabel('actions.returnToRecorder', 'Return to Recorder'),
          click: () => sendEditorMenuAction('menu-return-to-recorder'),
        },
        ...(isMac
          ? []
          : [
              { type: 'separator' as const },
              { role: 'quit' as const, label: menuLabel('actions.quit', 'Quit') },
            ]),
      ],
    },
    {
      label: menuLabel('actions.edit', 'Edit'),
      submenu: [
        ...buildEditMenuSubmenu({ label: menuLabel, dispatch: dispatchUndoRedo }),
        { type: 'separator' },
        {
          label: menuLabel('actions.keyboardShortcuts', 'Keyboard Shortcuts…'),
          click: () => sendEditorMenuAction('menu-open-shortcuts'),
        },
      ],
    },
    {
      label: menuLabel('actions.view', 'View'),
      submenu: [
        {
          label: menuLabel('actions.toggleTimeline', 'Toggle Timeline'),
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => sendEditorMenuAction('menu-toggle-timeline'),
        },
        {
          label: menuLabel('actions.toggleSettings', 'Toggle Settings Panel'),
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => sendEditorMenuAction('menu-toggle-settings'),
        },
        { type: 'separator' },
        { role: 'reload', label: menuLabel('actions.reload', 'Reload') },
        { role: 'forceReload', label: menuLabel('actions.forceReload', 'Force Reload') },
        {
          role: 'toggleDevTools',
          label: menuLabel('actions.toggleDevTools', 'Toggle Developer Tools'),
        },
        { type: 'separator' },
        { role: 'resetZoom', label: menuLabel('actions.actualSize', 'Actual Size') },
        { role: 'zoomIn', label: menuLabel('actions.zoomIn', 'Zoom In') },
        { role: 'zoomOut', label: menuLabel('actions.zoomOut', 'Zoom Out') },
        { type: 'separator' },
        {
          role: 'togglefullscreen',
          label: menuLabel('actions.toggleFullScreen', 'Toggle Full Screen'),
        },
      ],
    },
    {
      label: menuLabel('actions.window', 'Window'),
      submenu: isMac
        ? [
            { role: 'minimize', label: menuLabel('actions.minimize', 'Minimize') },
            { role: 'zoom' },
            { type: 'separator' },
            { role: 'front' },
          ]
        : [
            { role: 'minimize', label: menuLabel('actions.minimize', 'Minimize') },
            { role: 'close', label: menuLabel('actions.close', 'Close') },
          ],
    },
    {
      label: menuLabel('actions.help', 'Help'),
      submenu: [
        {
          label: menuLabel('actions.reportIssue', 'Report an Issue…'),
          click: () => {
            void shell.openExternal(`${GITHUB_ISSUES_URL}/new`)
          },
        },
        {
          label: menuLabel('actions.saveDiagnostics', 'Save Diagnostics…'),
          click: () => {
            void runSaveDiagnostics()
          },
        },
        ...checkForUpdatesMenuItems(),
        // macOS keeps About in the app menu; Windows/Linux look for it under Help.
        ...(isMac
          ? []
          : [
              { type: 'separator' as const },
              {
                label: menuLabel('actions.about', 'About Capturia'),
                click: () => {
                  void showAboutDialog()
                },
              },
            ]),
      ],
    },
  )

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── Check for updates (F10 / M12) ──────────────────────────────────────────
// Two flows share the menu item. When this copy can update itself (packaged
// dmg / nsis / AppImage, see `auto-updater.ts`) electron-updater drives a
// download-then-restart flow with progress forwarded to the renderer. Every
// other install keeps the release-page flow below: one GitHub API call, a
// verdict dialog, and at most an "open release page" through the external-URL
// allowlist. The updater also falls back to it when the build is unsigned or
// the release carries no update feed.
let updateCheckInFlight = false
const UPDATE_CHECK_TIMEOUT_MS = 10_000
const LAUNCH_UPDATE_CHECK_DELAY_MS = 10_000
// Upper bound on a manual check. The updater's own probe takes no signal, so a
// stalled feed (corporate proxy, CDN blackhole) would otherwise hang the check
// forever and leave the in-flight latch set for the rest of the session.
const MANUAL_UPDATE_CHECK_TIMEOUT_MS = 30_000

type UpdatesTextKey =
  | 'available'
  | 'current'
  | 'failed'
  | 'openRelease'
  | 'downloadPrompt'
  | 'downloadNow'
  | 'later'
  | 'downloaded'
  | 'restartNow'
  | 'onNextQuit'
  | 'offline'

function updatesText(key: UpdatesTextKey, vars?: Record<string, string>): string {
  return mainT(currentLocale(), `common.electron.updates.${key}`, vars)
}

let autoUpdaterController: AutoUpdaterController | null | undefined

/**
 * Lazily builds the electron-updater controller; `null` when this install
 * cannot update itself. The module is imported only on eligible channels so
 * dev runs and package-manager installs never pay for it.
 */
async function getAutoUpdater(): Promise<AutoUpdaterController | null> {
  if (autoUpdaterController !== undefined) return autoUpdaterController
  const eligibility = getUpdaterEligibility(installChannel(), app.isPackaged)
  if (!eligibility.eligible) {
    autoUpdaterController = null
    return null
  }
  try {
    const { autoUpdater } = await import('electron-updater')
    autoUpdaterController = createAutoUpdater({
      updater: autoUpdater,
      currentVersion: app.getVersion(),
      isRecording: () => recordingActive,
      emit: broadcastUpdateProgress,
      prompts: {
        available: async (version) => {
          const choice = await showMessageBox({
            type: 'info',
            title: PRODUCT_NAME,
            message: updatesText('downloadPrompt', {
              latestVersion: version,
              currentVersion: app.getVersion(),
            }),
            buttons: [updatesText('downloadNow'), updatesText('later')],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
          })
          return availableDialogAction(choice.response)
        },
        downloaded: async (version) => {
          const choice = await showMessageBox({
            type: 'info',
            title: PRODUCT_NAME,
            message: updatesText('downloaded', { latestVersion: version }),
            buttons: [updatesText('restartNow'), updatesText('onNextQuit')],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
          })
          return downloadedDialogAction(choice.response)
        },
        current: async (version) => {
          await showMessageBox({
            type: 'info',
            title: PRODUCT_NAME,
            message: updatesText('current', { currentVersion: version }),
            buttons: [menuLabel('actions.close', 'Close')],
            noLink: true,
          })
        },
        failed: async (kind: UpdateErrorKind, message: string) => {
          await showMessageBox({
            type: 'warning',
            title: PRODUCT_NAME,
            message: updatesText(kind === 'offline' ? 'offline' : 'failed'),
            detail: message,
            buttons: [menuLabel('actions.close', 'Close')],
            noLink: true,
          })
        },
      },
      fallbackToReleasePage: checkForUpdatesViaReleasePage,
      log: (message, ...detail) => console.warn(message, ...detail),
    })
  } catch (error) {
    console.warn('[updates] electron-updater unavailable; using the release page flow:', error)
    autoUpdaterController = null
  }
  return autoUpdaterController
}

function broadcastUpdateProgress(event: UpdateProgressEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('update-progress', event)
  }
}

const UPDATE_PREFERENCES_FILE = path.join(app.getPath('userData'), UPDATE_PREFERENCES_FILE_NAME)

async function readAutoUpdateCheckPreference(): Promise<boolean> {
  try {
    return parseUpdatePreferences(await fs.readFile(UPDATE_PREFERENCES_FILE, 'utf-8'))
      .autoUpdateCheck
  } catch {
    return parseUpdatePreferences(null).autoUpdateCheck
  }
}

async function writeAutoUpdateCheckPreference(enabled: boolean): Promise<void> {
  await atomicWriteFile(
    UPDATE_PREFERENCES_FILE,
    serializeUpdatePreferences({ autoUpdateCheck: enabled }),
  )
}

/** Launch check: 10 s after the first window, only when enabled and this copy can act on it. */
function scheduleLaunchUpdateCheck(): void {
  if (HEADLESS) return
  globalThis.setTimeout(() => {
    void (async () => {
      const controller = await getAutoUpdater()
      const autoUpdateCheck = await readAutoUpdateCheckPreference()
      if (
        !shouldRunLaunchCheck({
          eligible: controller !== null,
          autoUpdateCheck,
          recording: recordingActive,
        })
      ) {
        return
      }
      await controller?.check('launch')
    })().catch((error) => {
      console.warn('[updates] launch check failed:', error)
    })
  }, LAUNCH_UPDATE_CHECK_DELAY_MS)
}

/**
 * Menu / tray entry point: the updater when it can act, the release-page flow
 * otherwise. Enforces `canOfferUpdateCheck` itself (the menus hide the entry,
 * but the IPC and a stale tray menu must not be able to bypass it) and bounds
 * the updater probe by `MANUAL_UPDATE_CHECK_TIMEOUT_MS`; on timeout the
 * release-page flow (which carries its own 10 s bound) answers instead.
 */
async function checkForUpdates(): Promise<void> {
  if (!canOfferUpdateCheck()) return
  const controller = await getAutoUpdater()
  if (controller) {
    const outcome = await Promise.race([
      controller.check('menu').then(() => 'done' as const),
      new Promise<'timeout'>((resolve) => {
        const timer = globalThis.setTimeout(
          () => resolve('timeout'),
          MANUAL_UPDATE_CHECK_TIMEOUT_MS,
        )
        timer.unref?.()
      }),
    ])
    if (outcome === 'done') return
    console.warn(
      `[updates] updater probe exceeded ${MANUAL_UPDATE_CHECK_TIMEOUT_MS} ms; falling back to the release page`,
    )
  }
  await checkForUpdatesViaReleasePage()
}

async function checkForUpdatesViaReleasePage(): Promise<void> {
  if (updateCheckInFlight) return
  updateCheckInFlight = true
  try {
    const result = await checkLatestRelease({
      currentVersion: app.getVersion(),
      fetchLatest: (url, init) => net.fetch(url, init),
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    })

    if (result.kind === 'current') {
      await showMessageBox({
        type: 'info',
        title: PRODUCT_NAME,
        message: updatesText('current', { currentVersion: result.currentVersion }),
        buttons: [menuLabel('actions.close', 'Close')],
        noLink: true,
      })
      return
    }

    const choice = await showMessageBox({
      type: 'info',
      title: PRODUCT_NAME,
      message: updatesText('available', {
        latestVersion: result.latestVersion,
        currentVersion: result.currentVersion,
      }),
      buttons: [updatesText('openRelease'), menuLabel('actions.close', 'Close')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (choice.response !== 0) return
    // Same policy as the `open-external-url` IPC: http(s)/mailto only.
    const releaseUrl = normalizeExternalUrl(result.releaseUrl)
    if (!releaseUrl) {
      console.warn('[updates] refused to open release URL:', result.releaseUrl)
      return
    }
    await shell.openExternal(releaseUrl)
  } catch (error) {
    console.warn('[updates] check failed:', error)
    await showMessageBox({
      type: 'warning',
      title: PRODUCT_NAME,
      message: updatesText('failed'),
      detail: error instanceof Error ? error.message : String(error),
      buttons: [menuLabel('actions.close', 'Close')],
      noLink: true,
    })
  } finally {
    updateCheckInFlight = false
  }
}

// ── About (M11) ────────────────────────────────────────────────────────────
function installChannel() {
  return getInstallChannel({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath })
}

function aboutFacts(): AboutFacts {
  return {
    version: app.getVersion(),
    channel: installChannel(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }
}

/** macOS gets its native About panel (the app menu's `role: "about"` opens it). */
function configureAboutPanel(): void {
  if (!usesNativeAboutPanel(process.platform)) return
  const facts = aboutFacts()
  app.setAboutPanelOptions({
    applicationName: PRODUCT_NAME,
    applicationVersion: facts.version,
    version: facts.channel,
    copyright: COPYRIGHT,
    credits: formatAboutDetail(facts),
  })
}

/** Message boxes must be owned by a visible window or they open behind the always-on-top HUD. */
function showMessageBox(options: Electron.MessageBoxOptions) {
  const visible = (win: BrowserWindow | null) =>
    win && !win.isDestroyed() && win.isVisible() ? win : null
  const parent = visible(BrowserWindow.getFocusedWindow()) ?? visible(mainWindow)
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
}

let aboutDialogOpen = false

/** The About box for the platforms with no native panel; "Copy" puts the facts on the clipboard. */
async function showAboutDialog(): Promise<void> {
  if (aboutDialogOpen) return
  aboutDialogOpen = true
  try {
    const facts = aboutFacts()
    const detail = `${formatAboutDetail(facts)}\n${COPYRIGHT}`
    const heading = `${PRODUCT_NAME} ${facts.version}`
    const choice = await showMessageBox({
      type: 'info',
      title: menuLabel('actions.about', 'About Capturia'),
      message: heading,
      detail,
      buttons: [menuLabel('actions.close', 'Close'), menuLabel('actions.copy', 'Copy')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (choice.response === 1) clipboard.writeText(`${heading}\n${detail}`)
  } finally {
    aboutDialogOpen = false
  }
}

// ── Diagnostics (M2) ───────────────────────────────────────────────────────
const ISSUE_LOG_TAIL_LINES = 40

function mainLogTailSection(): string[] {
  const tail = mainLogBuffer.tail(ISSUE_LOG_TAIL_LINES)
  if (tail.length === 0) return []
  return ['', '## Main process log (tail)', '```', ...tail, '```']
}

type DiagnosticPayload = {
  error?: string
  stack?: string
  projectState?: unknown
  logs?: string[]
  locale?: string
}

function buildDiagnosticReport(payload: DiagnosticPayload): string {
  const now = new Date()
  const lines: string[] = [
    `${PRODUCT_NAME} diagnostic report`,
    `Generated: ${now.toISOString()}`,
    '',
    '## App',
    `Version: ${app.getVersion()}`,
    `Install channel: ${installChannel()}`,
    `Locale: ${payload.locale ?? currentLocale()}`,
    `Packaged: ${app.isPackaged}`,
    '',
    '## Platform',
    `OS: ${process.platform} ${process.arch} (${os.release()})`,
    `Session: ${process.platform === 'linux' ? LINUX_SESSION_TYPE || 'unknown' : 'n/a'}`,
    `Electron: ${process.versions.electron}`,
    `Chromium: ${process.versions.chrome}`,
    `Node: ${process.versions.node}`,
    `Memory: ${Math.round(os.totalmem() / 1024 / 1024)} MB total, ${Math.round(os.freemem() / 1024 / 1024)} MB free`,
    `Recording active: ${recordingActive}`,
  ]
  if (payload.error) {
    lines.push('', '## Error', payload.error)
    if (payload.stack) lines.push('', payload.stack)
  }
  if (payload.projectState !== undefined) {
    let serialized: string
    try {
      serialized = JSON.stringify(payload.projectState, null, 2)
    } catch {
      serialized = String(payload.projectState)
    }
    lines.push('', '## Project state', serialized)
  }
  if (payload.logs && payload.logs.length > 0) {
    lines.push('', '## Renderer log (tail)', ...payload.logs.slice(-200))
  }
  const mainLog = mainLogBuffer.snapshot()
  lines.push('', `## Main process log (${mainLog.length} lines)`)
  for (const entry of mainLog) {
    lines.push(
      `${new Date(entry.timestampMs).toISOString()} ${entry.level.toUpperCase().padEnd(5)} ${entry.text}`,
    )
  }
  return `${lines.join('\n')}\n`
}

async function exportDiagnosticFile(
  payload: DiagnosticPayload,
): Promise<{ success: boolean; path?: string; cancelled?: boolean; error?: string }> {
  const locale = payload.locale ?? currentLocale()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const defaultName = `capturia-diagnostic-${stamp}.txt`
  let defaultDir = app.getPath('downloads')
  try {
    await fs.access(defaultDir)
  } catch {
    defaultDir = app.getPath('home')
  }
  const parent = BrowserWindow.getFocusedWindow() ?? mainWindow
  const options: Electron.SaveDialogOptions = {
    title: mainT(locale, 'common.electron.diagnostics.saveTitle'),
    defaultPath: path.join(defaultDir, defaultName),
    filters: [
      { name: mainT(locale, 'common.electron.diagnostics.fileType'), extensions: ['txt'] },
      { name: mainT(locale, 'common.electron.allFiles'), extensions: ['*'] },
    ],
  }
  const result =
    parent && !parent.isDestroyed()
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) {
    return { success: false, cancelled: true }
  }
  try {
    await fs.writeFile(result.filePath, buildDiagnosticReport(payload), 'utf-8')
    return { success: true, path: result.filePath }
  } catch (error) {
    console.error('Failed to write diagnostic file:', error)
    return { success: false, error: String(error) }
  }
}

/** Help menu entry: save the report, then offer to reveal it. */
async function runSaveDiagnostics(): Promise<void> {
  const result = await exportDiagnosticFile({})
  if (result.cancelled) return
  const locale = currentLocale()
  if (!result.success || !result.path) {
    await showMessageBox({
      type: 'error',
      title: mainT(locale, 'common.electron.diagnostics.failedTitle'),
      message: mainT(locale, 'common.electron.diagnostics.failedTitle'),
      detail: result.error ?? '',
      buttons: [menuLabel('actions.close', 'Close')],
      noLink: true,
    })
    return
  }
  const choice = await showMessageBox({
    type: 'info',
    title: mainT(locale, 'common.electron.diagnostics.savedTitle'),
    message: mainT(locale, 'common.electron.diagnostics.savedTitle'),
    detail: mainT(locale, 'common.electron.diagnostics.savedMessage', { path: result.path }),
    buttons: [
      mainT(locale, 'common.electron.diagnostics.reveal'),
      menuLabel('actions.close', 'Close'),
    ],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (choice.response === 0) shell.showItemInFolder(result.path)
}

function createSourceSelectorWindowWrapper() {
  sourceSelectorWindow = createSourceSelectorWindow()
  sourceSelectorWindow.on('closed', () => {
    sourceSelectorWindow = null
    // Lets the HUD drop a pending "record after selection" intent when the
    // picker is dismissed without choosing a source.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('source-selector-closed')
    }
  })
  return sourceSelectorWindow
}

function createPermissionCheckerWindowWrapper() {
  permissionCheckerWindow = createPermissionCheckerWindow()
  permissionCheckerWindow.on('closed', () => {
    permissionCheckerWindow = null
  })
  return permissionCheckerWindow
}

function createCountdownOverlayWindowWrapper() {
  if (countdownOverlayWindow && !countdownOverlayWindow.isDestroyed()) {
    return countdownOverlayWindow
  }
  countdownOverlayWindow = createCountdownOverlayWindow()
  countdownOverlayWindow.on('closed', () => {
    countdownOverlayWindow = null
  })
  return countdownOverlayWindow
}

function createNotesWindowWrapper() {
  if (notesWindow && !notesWindow.isDestroyed()) {
    return notesWindow
  }
  notesWindow = createNotesWindow()
  notesWindow.on('closed', () => {
    notesWindow = null
    // Lets the HUD drop its "notes open" indicator.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('notes-window-closed')
    }
  })
  return notesWindow
}

// On macOS, applications and their menu bar stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  // Keep app running (macOS behavior)
})

app.on('activate', () => {
  // On macOS, re-open/raise the main window when the dock icon is clicked and no
  // window is visible. While recording the HUD is minimized on purpose
  // (`hud-overlay-hide`), so leave it alone until the recording ends.
  if (recordingActive) return
  // The countdown overlay is decoration, not a window the user can interact with.
  const hasVisibleWindow = BrowserWindow.getAllWindows().some(
    (window) => !window.isDestroyed() && window.isVisible() && window !== countdownOverlayWindow,
  )
  if (!hasVisibleWindow) {
    showMainWindow()
  }
})

app.on('will-quit', () => {
  globalShortcuts.unregisterAll()
})

process.on('uncaughtException', (error) => {
  reportRuntimeError('main.uncaughtException', error)
})

process.on('unhandledRejection', (reason) => {
  reportRuntimeError('main.unhandledRejection', reason)
})

app.on('before-quit', (event) => {
  if (shutdownFinished) {
    return
  }

  event.preventDefault()
  if (shutdownInProgress) {
    return
  }

  shutdownInProgress = true

  void (async () => {
    try {
      // Let the editor write its pending auto-save before the windows go away.
      await flushEditorBeforeQuit()
    } catch (error) {
      console.warn('Failed to flush the editor before quit:', error)
    }
    try {
      if (ipcRuntime) {
        await Promise.race([
          ipcRuntime.shutdown(),
          new Promise<void>((resolve) => {
            globalThis.setTimeout(resolve, 12_000)
          }),
        ])
      }
    } catch (error) {
      console.warn('Failed to cleanly shutdown capture resources before quit:', error)
    } finally {
      shutdownFinished = true
      app.quit()
    }
  })()
})

/**
 * Bodies larger than this are streamed rather than buffered. 8 MiB is roughly
 * a second of a high-bitrate screen recording: below it the whole response is
 * a rounding error against the renderer's own decode buffers, above it the
 * main process would be holding a copy of something the renderer is already
 * holding.
 */
const LOCAL_MEDIA_STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024

const LOCAL_MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.json': 'application/json',
}

function localMediaContentType(filePath: string): string {
  return (
    LOCAL_MEDIA_CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  )
}

// Register all IPC handlers when app is ready
const appReady = hasSingleInstanceLock ? app.whenReady() : null

appReady?.then(async () => {
  // Force "regular" activation policy so the Dock icon appears. The HUD overlay
  // (transparent, frameless, skipTaskbar) is the first window, and AppKit would
  // otherwise classify us as an accessory app.
  // HEADLESS (e2e): no Dock icon either, so nothing bounces or steals focus.
  if (isMac && !HEADLESS) {
    app.dock?.show()
  }

  // Capture belongs to the recorder HUD; every other window only plays back.
  // See `./windowPermissions` for why the window's identity comes from what
  // the main process created rather than from the URL the page reports.
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    return isPermissionAllowed({
      permission,
      windowType: windowTypeForContents(webContents),
      isMainFrame: details?.isMainFrame !== false,
    })
  })

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(
        isPermissionAllowed({
          permission,
          windowType: windowTypeForContents(webContents),
          isMainFrame: details?.isMainFrame !== false,
        }),
      )
    },
  )

  // Capturia talks to no USB, HID or serial device. Chromium would otherwise
  // remember a grant made by any page that managed to ask.
  session.defaultSession.setDevicePermissionHandler(() => false)

  app.on('web-contents-created', (_event, contents) => {
    contents.on('render-process-gone', (_goneEvent, details) => {
      reportRuntimeError(
        'renderer.render-process-gone',
        new Error(`reason=${details.reason}; exitCode=${details.exitCode}`),
      )
    })

    // Every window is one document that never navigates. Anything that tries
    // is page-driven, and the editor window runs with `webSecurity: false`, so
    // a navigation it did not ask for is the most valuable thing an attacker
    // could get. See `./navigationPolicy`.
    attachNavigationPolicy(contents, {
      openExternal: (url) => shell.openExternal(url),
    })
  })

  // Serve `local-media://` from disk. Only files inside the recordings dir or
  // explicitly approved by the user (file picker) are served; the editor runs
  // with webSecurity off, so this gate is what keeps the scheme from being an
  // arbitrary file reader.
  //
  // Bodies above LOCAL_MEDIA_STREAM_THRESHOLD_BYTES are streamed. The old
  // handler read whole files with readFileSync and allocated the remainder of
  // the file for an open-ended range, which on a long recording meant hundreds
  // of megabytes resident in the main process for a request that only moved
  // the playhead. Smaller bodies stay on the Buffer path: for a few hundred KB
  // a stream is more moving parts than it is worth, and Electron's Response
  // has always accepted a Buffer.
  protocol.handle('local-media', async (request) => {
    const filePath = localMediaUrlToPath(request.url)
    if (!filePath || !isReadablePathAllowed(filePath, { recordingsDir: RECORDINGS_DIR })) {
      console.warn('[local-media] refused (not an approved readable path):', request.url)
      return new Response('Forbidden', { status: 403 })
    }
    try {
      const stat = statSync(filePath)
      const contentType = localMediaContentType(filePath)
      // `local-media://` is a different origin from the page that loads it, so
      // without this a <video> reading from it is CORS-tainted and every pixel
      // read fails: `new VideoFrame(video)` throws SecurityError and canvases
      // go opaque. The exporter's decoder asks for the file in CORS mode; the
      // request is already refused unless the path is approved, so the wildcard
      // adds no reach beyond what the gate above allows. No credentials are
      // involved, so `*` is the whole story.
      const baseHeaders = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
      }

      const range = parseRangeHeader(request.headers.get('range'), stat.size)

      if (range.kind === 'unsatisfiable') {
        console.warn('[local-media] range past the end of the file:', request.url)
        return new Response(null, {
          status: 416,
          headers: {
            ...baseHeaders,
            'Content-Range': unsatisfiableContentRangeHeader(stat.size),
          },
        })
      }

      const start = range.kind === 'partial' ? range.start : 0
      const end = range.kind === 'partial' ? range.end : Math.max(0, stat.size - 1)
      const length = range.kind === 'partial' ? range.length : stat.size
      const headers =
        range.kind === 'partial'
          ? {
              ...baseHeaders,
              'Content-Range': contentRangeHeader(start, end, stat.size),
              'Content-Length': String(length),
            }
          : { ...baseHeaders, 'Content-Length': String(length) }
      const status = range.kind === 'partial' ? 206 : 200

      if (length > LOCAL_MEDIA_STREAM_THRESHOLD_BYTES) {
        const stream = createReadStream(filePath, { start, end })
        return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
          status,
          headers,
        })
      }

      if (stat.size === 0) return new Response(null, { status, headers })

      const buffer = Buffer.alloc(length)
      const fd = openSync(filePath, 'r')
      try {
        // A single read is allowed to come up short; keep going until the
        // buffer is full or the file ends, or the response would declare more
        // bytes than it carries.
        let filled = 0
        while (filled < length) {
          const read = readSync(fd, buffer, filled, length - filled, start + filled)
          if (read <= 0) break
          filled += read
        }
      } finally {
        closeSync(fd)
      }
      return new Response(buffer, { status, headers })
    } catch (error) {
      console.error('[local-media] failed to serve file:', request.url, error)
      return new Response('Not Found', { status: 404 })
    }
  })

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    let callbackInvoked = false
    try {
      console.log(
        '[display-media] handler invoked, selectedDesktopSourceId:',
        selectedDesktopSourceId,
      )
      if (!selectedDesktopSourceId) {
        console.warn('[display-media] no selectedDesktopSourceId, rejecting request')
        callbackInvoked = true
        callback({})
        return
      }

      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 1, height: 1 },
        fetchWindowIcons: false,
      })
      console.log(
        '[display-media] desktopCapturer returned',
        sources.length,
        'sources:',
        sources.map((s) => s.id),
      )
      let selectedSource = sources.find((source) => source.id === selectedDesktopSourceId)
      // On Linux, window/screen IDs can change between source selection and recording.
      // Fall back to matching by type prefix (e.g. "window:" or "screen:").
      if (!selectedSource && selectedDesktopSourceId) {
        const typePrefix = selectedDesktopSourceId.split(':')[0] + ':'
        selectedSource = sources.find((source) => source.id.startsWith(typePrefix))
        if (selectedSource) {
          console.log(
            '[display-media] exact ID not found, matched by type prefix:',
            selectedSource.id,
          )
        }
      }
      if (!selectedSource) {
        console.warn('[display-media] no matching source found in sources, rejecting')
        callbackInvoked = true
        callback({})
        return
      }

      // System audio: Chromium only offers a loopback device on Windows. Linux gets
      // desktop audio through the renderer's legacy `chromeMediaSource: 'desktop'`
      // audio constraint (PulseAudio/PipeWire monitor), and macOS through the native
      // helper, so those platforms are handed video only here.
      const grantSystemAudio = request.audioRequested && process.platform === 'win32'
      console.log(
        '[display-media] providing source:',
        selectedSource.id,
        selectedSource.name,
        'audio:',
        grantSystemAudio ? 'loopback' : 'none',
      )
      callbackInvoked = true
      callback({
        video: selectedSource,
        ...(grantSystemAudio ? { audio: 'loopback' as const } : {}),
      })
    } catch (error) {
      console.error('[display-media] handler failed:', error)
      if (!callbackInvoked) {
        try {
          callback({})
        } catch {
          // callback was already consumed internally
        }
      }
    }
  })

  // Listen for HUD overlay quit event (macOS only)
  ipcMain.on('hud-overlay-close', () => {
    app.quit()
  })
  ipcMain.handle('switch-to-launch', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close()
      mainWindow = null
    }
    showMainWindow()
  })

  ipcMain.on('app-quit', () => {
    app.quit()
  })
  ipcMain.handle('show-about', async () => {
    if (usesNativeAboutPanel(process.platform)) {
      app.showAboutPanel()
      return
    }
    await showAboutDialog()
  })

  // Legacy HUD path: a raw accelerator string. Registered through the shared
  // manager and written through to shortcuts.json so the editor's dialog and
  // the HUD agree on the binding.
  ipcMain.handle('set-stop-recording-shortcut', async (_, accelerator: string) => {
    const result = globalShortcuts.register('stopRecording', String(accelerator || ''))
    if (result.ok) {
      const binding = acceleratorToBinding(result.accelerator)
      if (binding) {
        try {
          await persistStoredGlobalBinding(SHORTCUTS_FILE, 'stopRecording', binding)
        } catch (error) {
          console.warn('Failed to persist stop-recording shortcut:', error)
        }
      }
    }
    return {
      success: result.ok,
      accelerator: result.accelerator,
      message: shortcutErrorMessage(result.error),
    }
  })
  ipcMain.handle('get-stop-recording-shortcut', () => {
    return { success: true, accelerator: globalShortcuts.getAccelerator('stopRecording') ?? '' }
  })
  // Shortcuts dialog path: a ShortcutBinding for one of the global actions.
  // Persistence is the renderer's job (save-shortcuts) once every action registered.
  ipcMain.handle('update-global-shortcut', (_, action: unknown, binding: ShortcutBinding) => {
    if (!isGlobalShortcutAction(action)) {
      return { ok: false, accelerator: '', error: 'invalid' as const }
    }
    if (!binding || typeof binding.key !== 'string' || !isGlobalBindingAllowed(binding)) {
      return {
        ok: false,
        accelerator: globalShortcuts.getAccelerator(action) ?? '',
        error: 'needsModifier' as const,
      }
    }
    const result = globalShortcuts.register(action, binding)
    return { ok: result.ok, accelerator: result.accelerator, error: result.error }
  })
  ipcMain.handle('get-global-shortcuts', () => {
    const accelerators: Partial<Record<GlobalShortcutAction, string>> = {}
    for (const action of GLOBAL_SHORTCUT_ACTIONS) {
      const accelerator = globalShortcuts.getAccelerator(action)
      if (accelerator) accelerators[action] = accelerator
    }
    return accelerators
  })

  ipcMain.handle('save-diagnostic', (_, payload?: DiagnosticPayload) => {
    return exportDiagnosticFile(payload && typeof payload === 'object' ? payload : {})
  })
  ipcMain.handle('get-main-log-tail', (_, lines?: number) => {
    const count =
      Number.isFinite(lines) && (lines as number) > 0
        ? Math.min(500, Math.floor(lines as number))
        : ISSUE_LOG_TAIL_LINES
    return mainLogBuffer.tail(count)
  })

  // Renderer announces the user's language; rebuild the tray and menu so their labels follow.
  ipcMain.handle('set-locale', (_, locale: string) => {
    setMainLocale(locale)
    updateTrayMenu(recordingActive)
    setupApplicationMenu()
  })

  // Launch update check preference (main-owned so it is known before any
  // renderer loads); the renderer only reads and toggles it.
  ipcMain.handle('get-auto-update-check', async () => {
    return { success: true, enabled: await readAutoUpdateCheckPreference() }
  })
  ipcMain.handle('set-auto-update-check', async (_, enabled: unknown) => {
    try {
      await writeAutoUpdateCheckPreference(enabled === true)
      return { success: true, enabled: enabled === true }
    } catch (error) {
      console.warn('Failed to persist the auto-update preference:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('check-for-updates', async () => {
    // The renderer may hide its button on a package-manager channel or while
    // recording, but the rule is enforced here, not in the renderer.
    if (!canOfferUpdateCheck()) return { success: false, reason: 'unavailable' as const }
    void checkForUpdates()
    return { success: true }
  })
  setMainLocale(app.getLocale())
  configureAboutPanel()
  setupApplicationMenu()
  createTray()
  updateTrayMenu()
  await loadAndRegisterGlobalShortcuts()
  // Ensure recordings directory exists
  await ensureRecordingsDir()
  scheduleRecordingsCleanup({
    recordingsDir: RECORDINGS_DIR,
    userDataDir: getUserDataDir(),
    reason: 'startup',
  })

  ipcRuntime = registerIpcHandlers(
    createEditorWindowWrapper,
    createSourceSelectorWindowWrapper,
    createPermissionCheckerWindowWrapper,
    () => mainWindow,
    () => sourceSelectorWindow,
    () => permissionCheckerWindow || getPermissionCheckerWindow(),
    (recording: boolean, sourceName: string) => {
      recordingActive = recording
      selectedSourceName = sourceName
      if (!tray) createTray()
      updateTrayMenu(recording)
      // `canOfferUpdateCheck()` answers "not mid-take" too; the app menu is
      // built once at startup, so rebuild it or it keeps offering the check.
      setupApplicationMenu()
      if (!recording) {
        if (mainWindow) mainWindow.restore()
      }
    },
    (source) => {
      selectedDesktopSourceId = source?.id ?? null
    },
    {
      createCountdownOverlayWindow: createCountdownOverlayWindowWrapper,
      getCountdownOverlayWindow: () => countdownOverlayWindow,
      createNotesWindow: createNotesWindowWrapper,
      getNotesWindow: () => notesWindow,
      getHudOverlayWindow,
    },
  )
  if (e2eStartupVideoPath()) {
    // Straight into the editor; the spec hands the approved path to the
    // renderer through `set-current-video-path`.
    createEditorWindowWrapper()
  } else {
    createWindow()
  }
  scheduleLaunchUpdateCheck()
})
