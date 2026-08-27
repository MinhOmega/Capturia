import { app, BrowserWindow, Tray, Menu, nativeImage, session, desktopCapturer, globalShortcut, ipcMain, dialog, shell, protocol } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import {
  createHudOverlayWindow,
  createEditorWindow,
  createSourceSelectorWindow,
  createPermissionCheckerWindow,
  getPermissionCheckerWindow,
} from './windows'
import { registerIpcHandlers } from './ipc/handlers'
import { isReadablePathAllowed, localMediaUrlToPath } from './ipc/paths'
import { shouldSwallowMainProcessError } from './main-process-errors'
import { scheduleRecordingsCleanup } from './recordingsCleanup'
import { buildIssueReportUrl } from '../src/lib/supportLinks'
import { getMainLocale, mainT, setMainLocale } from './i18n'


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

export const RECORDINGS_DIR = path.join(app.getPath('userData'), 'recordings')


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

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

// Window references
let mainWindow: BrowserWindow | null = null
let sourceSelectorWindow: BrowserWindow | null = null
let permissionCheckerWindow: BrowserWindow | null = null
let tray: Tray | null = null
let selectedSourceName = ''
let selectedDesktopSourceId: string | null = null
let recordingActive = false
const DEFAULT_STOP_RECORDING_SHORTCUT = 'CommandOrControl+Shift+2'
let stopRecordingShortcut = DEFAULT_STOP_RECORDING_SHORTCUT
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
    },
  },
])

const isMac = process.platform === 'darwin'
// macOS menu bar icons are 16pt; other trays expect 24px.
const trayIconSize = isMac ? 16 : 24

// Tray Icons
const defaultTrayIcon = getTrayIcon('capturia.png', trayIconSize);
const recordingTrayIcon = getTrayIcon('rec-button.png', trayIconSize);

function createWindow() {
  // Guard against duplicate HUDs (activate + tray + second-instance can race).
  if (mainWindow && !mainWindow.isDestroyed()) {
    return
  }
  mainWindow = createHudOverlayWindow()
}

// Restore + show + focus the current main window (HUD or editor), or create the HUD.
function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.show()
    mainWindow.focus()
    return
  }
  createWindow()
}

// Only `app.requestSingleInstanceLock()`: upstream's PID-file lock was removed
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
  tray = new Tray(defaultTrayIcon);
  // Left click (Windows) / click without context menu: bring the HUD back.
  tray.on('click', () => {
    showMainWindow()
  })
  tray.on('double-click', () => {
    showMainWindow()
  })
}

function getTrayIcon(filename: string, size: number) {
  return nativeImage.createFromPath(path.join(process.env.VITE_PUBLIC || RENDERER_DIST, filename)).resize({
    width: size,
    height: size,
    quality: 'best'
  });
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
      `- Platform: ${process.platform}`,
      `- Version: ${app.getVersion()}`,
      '',
      '## Error Message',
      message,
      ...(stack ? ['', '## Stack', '```', stack, '```'] : []),
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

function trayText(locale: string, key: 'app' | 'recording' | 'stop' | 'open' | 'quit', source?: string): string {
  const keys = {
    app: 'common.electron.tray.openScreen',
    recording: 'common.electron.tray.recording',
    stop: 'common.electron.tray.stopRecording',
    open: 'common.electron.tray.open',
    quit: 'common.electron.tray.quit',
  } as const
  return mainT(locale, keys[key], { source: source ?? '' })
}


function updateTrayMenu(recording: boolean = false) {
  if (!tray) return;
  const locale = currentLocale();
  const trayIcon = recording ? recordingTrayIcon : defaultTrayIcon;
  const trayToolTip = recording ? trayText(locale, 'recording', selectedSourceName) : trayText(locale, 'app');
  const menuTemplate = recording
    ? [
        {
          label: trayText(locale, 'stop'),
          click: () => emitStopRecordingRequest(),
        },
      ]
    : [
        {
          label: trayText(locale, 'open'),
          click: () => {
            showMainWindow()
          },
        },
        {
          label: trayText(locale, 'quit'),
          click: () => {
            app.quit();
          },
        },
      ];
  tray.setImage(trayIcon);
  tray.setToolTip(trayToolTip);
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate));
}

function emitStopRecordingRequest(): void {
  if (!recordingActive) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('stop-recording-from-tray')
}

function registerStopRecordingShortcut(accelerator: string): { success: boolean; accelerator: string; message?: string } {
  const nextAccelerator = String(accelerator || '').trim()
  if (!nextAccelerator) {
    return {
      success: false,
      accelerator: stopRecordingShortcut,
      message: 'Shortcut cannot be empty.',
    }
  }

  const previousShortcut = stopRecordingShortcut
  try {
    if (previousShortcut) {
      globalShortcut.unregister(previousShortcut)
    }
  } catch {
    // ignore unregister errors
  }

  const didRegister = globalShortcut.register(nextAccelerator, () => {
    emitStopRecordingRequest()
  })

  if (!didRegister) {
    if (previousShortcut) {
      globalShortcut.register(previousShortcut, () => {
        emitStopRecordingRequest()
      })
    }
    return {
      success: false,
      accelerator: previousShortcut,
      message: 'Shortcut is unavailable. Try a different key combination.',
    }
  }

  stopRecordingShortcut = nextAccelerator
  return { success: true, accelerator: stopRecordingShortcut }
}

function createEditorWindowWrapper() {
  if (mainWindow) {
    mainWindow.close()
    mainWindow = null
  }
  mainWindow = createEditorWindow()
}

function createSourceSelectorWindowWrapper() {
  sourceSelectorWindow = createSourceSelectorWindow()
  sourceSelectorWindow.on('closed', () => {
    sourceSelectorWindow = null
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
  const hasVisibleWindow = BrowserWindow.getAllWindows().some(
    (window) => !window.isDestroyed() && window.isVisible(),
  )
  if (!hasVisibleWindow) {
    showMainWindow()
  }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
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



// Web permissions the renderer may hold/request. Everything else (notifications,
// geolocation, clipboard, ...) is denied. `fullscreen` is a Capturia addition for the
// editor's fullscreen preview (`requestFullscreen()`); the rest mirrors upstream.
const ALLOWED_WEB_PERMISSIONS: ReadonlySet<string> = new Set([
  'media',
  'audioCapture',
  'microphone',
  'videoCapture',
  'camera',
  'screen',
  'display-capture',
  'fullscreen',
])

// Register all IPC handlers when app is ready
const appReady = hasSingleInstanceLock ? app.whenReady() : null

appReady?.then(async () => {
  // Force "regular" activation policy so the Dock icon appears. The HUD overlay
  // (transparent, frameless, skipTaskbar) is the first window, and AppKit would
  // otherwise classify us as an accessory app.
  if (isMac) {
    app.dock?.show()
  }

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return ALLOWED_WEB_PERMISSIONS.has(permission)
  })

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_WEB_PERMISSIONS.has(permission))
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.on('render-process-gone', (_goneEvent, details) => {
      reportRuntimeError(
        'renderer.render-process-gone',
        new Error(`reason=${details.reason}; exitCode=${details.exitCode}`),
      )
    })
  })

  // Handle local-media:// requests by reading local files into Buffer.
  // Uses Buffer (not Node.js streams) because Electron's Response constructor
  // reliably accepts Buffer. Supports Range requests for video seeking.
  // Only files inside the recordings dir or explicitly approved by the user
  // (file picker) are served; the editor runs with webSecurity off, so this
  // gate is what keeps the scheme from being an arbitrary file reader.
  protocol.handle('local-media', async (request) => {
    const filePath = localMediaUrlToPath(request.url)
    if (!filePath || !isReadablePathAllowed(filePath, { recordingsDir: RECORDINGS_DIR })) {
      console.warn('[local-media] refused (not an approved readable path):', request.url)
      return new Response('Forbidden', { status: 403 })
    }
    try {
      const stat = statSync(filePath)
      const ext = path.extname(filePath).toLowerCase()
      const mimeMap: Record<string, string> = {
        '.webm': 'video/webm',
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.m4v': 'video/x-m4v',
        '.mkv': 'video/x-matroska',
        '.json': 'application/json',
      }
      const contentType = mimeMap[ext] || 'application/octet-stream'

      const rangeHeader = request.headers.get('range')
      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
        if (match) {
          const start = parseInt(match[1], 10)
          const end = match[2] ? parseInt(match[2], 10) : stat.size - 1
          const chunkSize = end - start + 1
          const buffer = Buffer.alloc(chunkSize)
          const fd = openSync(filePath, 'r')
          readSync(fd, buffer, 0, chunkSize, start)
          closeSync(fd)
          console.log('[local-media] range:', start, '-', end, '/', stat.size, filePath)
          return new Response(buffer, {
            status: 206,
            headers: {
              'Content-Type': contentType,
              'Content-Range': `bytes ${start}-${end}/${stat.size}`,
              'Content-Length': String(chunkSize),
              'Accept-Ranges': 'bytes',
            },
          })
        }
      }

      console.log('[local-media] full:', stat.size, 'bytes', contentType, filePath)
      const buffer = readFileSync(filePath)
      return new Response(buffer, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(stat.size),
          'Accept-Ranges': 'bytes',
        },
      })
    } catch (error) {
      console.error('[local-media] failed to serve file:', request.url, error)
      return new Response('Not Found', { status: 404 })
    }
  })

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    let callbackInvoked = false
    try {
      console.log('[display-media] handler invoked, selectedDesktopSourceId:', selectedDesktopSourceId)
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
      console.log('[display-media] desktopCapturer returned', sources.length, 'sources:', sources.map(s => s.id))
      let selectedSource = sources.find((source) => source.id === selectedDesktopSourceId)
      // On Linux, window/screen IDs can change between source selection and recording.
      // Fall back to matching by type prefix (e.g. "window:" or "screen:").
      if (!selectedSource && selectedDesktopSourceId) {
        const typePrefix = selectedDesktopSourceId.split(':')[0] + ':'
        selectedSource = sources.find((source) => source.id.startsWith(typePrefix))
        if (selectedSource) {
          console.log('[display-media] exact ID not found, matched by type prefix:', selectedSource.id)
        }
      }
      if (!selectedSource) {
        console.warn('[display-media] no matching source found in sources, rejecting')
        callbackInvoked = true
        callback({})
        return
      }

      console.log('[display-media] providing source:', selectedSource.id, selectedSource.name)
      callbackInvoked = true
      callback({ video: selectedSource })
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

  ipcMain.handle('set-stop-recording-shortcut', (_, accelerator: string) => {
    return registerStopRecordingShortcut(accelerator)
  })
  ipcMain.handle('get-stop-recording-shortcut', () => {
    return { success: true, accelerator: stopRecordingShortcut }
  })
  // Renderer announces the user's language; rebuild the tray so its labels follow.
  ipcMain.handle('set-locale', (_, locale: string) => {
    setMainLocale(locale)
    updateTrayMenu(recordingActive)
  })
  setMainLocale(app.getLocale())
  createTray()
  updateTrayMenu()
  registerStopRecordingShortcut(stopRecordingShortcut)
  // Ensure recordings directory exists
  await ensureRecordingsDir()
  scheduleRecordingsCleanup({
    recordingsDir: RECORDINGS_DIR,
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
      if (!recording) {
        if (mainWindow) mainWindow.restore()
      }
    },
    (source) => {
      selectedDesktopSourceId = source?.id ?? null
    }
  )
  createWindow()
})
