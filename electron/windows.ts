import { app, BrowserWindow, screen } from 'electron'
import { ipcMain } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  boundsFromHudAnchor,
  HUD_MIN_WINDOW_SIZE,
  type HudPoint,
  type HudRect,
  type HudSize,
  hudAnchorOf,
} from '../src/hooks/useHudLayout'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const APP_ROOT = path.join(__dirname, '..')
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
const RENDERER_DIST = path.join(APP_ROOT, 'dist')
const LINUX_SESSION_TYPE = (process.env['XDG_SESSION_TYPE'] || '').toLowerCase()
/**
 * e2e / CI (F7): create every window but never show, raise or bounce it.
 * `HEADLESS=1` or `HEADLESS=true`; Playwright still attaches to hidden windows.
 */
export const HEADLESS = process.env['HEADLESS'] === '1' || process.env['HEADLESS'] === 'true'

let hudOverlayWindow: BrowserWindow | null = null
let permissionCheckerWindow: BrowserWindow | null = null

export function getHudOverlayWindow(): BrowserWindow | null {
  return hudOverlayWindow && !hudOverlayWindow.isDestroyed() ? hudOverlayWindow : null
}

/**
 * Where the HUD was last left. The bar hangs from the bottom-centre of its
 * window and the window is resized around that point to fit its content, so
 * the anchor (plus the last content-fit size, to avoid a clamp on a window
 * that starts larger than it ends) is what survives a relaunch.
 */
type HudOverlayPlacement = { anchor: HudPoint; size: HudSize }

const HUD_PLACEMENT_FILE = 'hud-overlay-placement.json'
const HUD_PLACEMENT_WRITE_DELAY_MS = 300

function hudPlacementPath(): string {
  return path.join(app.getPath('userData'), HUD_PLACEMENT_FILE)
}

function isFinitePair(value: unknown, a: string, b: string): boolean {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return Number.isFinite(record[a]) && Number.isFinite(record[b])
}

function readHudPlacement(): HudOverlayPlacement | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(hudPlacementPath(), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const { anchor, size } = parsed as Record<string, unknown>
    if (!isFinitePair(anchor, 'x', 'y') || !isFinitePair(size, 'width', 'height')) return null
    const placement = { anchor: anchor as HudPoint, size: size as HudSize }
    // Ignore an anchor that no display contains any more (monitor unplugged).
    const display = screen.getDisplayNearestPoint(placement.anchor)
    const { bounds } = display
    const inside =
      placement.anchor.x >= bounds.x &&
      placement.anchor.x <= bounds.x + bounds.width &&
      placement.anchor.y >= bounds.y &&
      placement.anchor.y <= bounds.y + bounds.height
    return inside ? placement : null
  } catch {
    return null
  }
}

function writeHudPlacement(bounds: HudRect): void {
  try {
    const file = hudPlacementPath()
    mkdirSync(path.dirname(file), { recursive: true })
    const placement: HudOverlayPlacement = {
      anchor: hudAnchorOf(bounds),
      size: { width: bounds.width, height: bounds.height },
    }
    writeFileSync(file, JSON.stringify(placement))
  } catch (error) {
    console.warn('[hud] failed to persist the HUD placement:', error)
  }
}

/** Debounced: `move` fires for every frame of a drag and `resize` for every content change. */
function trackHudPlacement(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (!win.isDestroyed() && !win.isMinimized()) writeHudPlacement(win.getBounds())
    }, HUD_PLACEMENT_WRITE_DELAY_MS)
  }
  win.on('move', schedule)
  win.on('resize', schedule)
  win.on('closed', () => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * C-1: the editor's caption worker loads the Whisper model over file:// and a
 * Web Worker cannot call IPC, so the model root (and the resources dir, for
 * future bundled assets) travel to the preload as `additionalArguments`.
 * Trailing separator so `new URL(relative, base)` resolves inside the directory.
 */
function fileUrlArg(prefix: string, dir: string): string {
  return `${prefix}${pathToFileURL(`${dir}${path.sep}`).toString()}`
}

function editorAdditionalArguments(): string[] {
  const assetBaseDir = app.isPackaged ? process.resourcesPath : path.join(APP_ROOT, 'public')
  const captionModelsDir = path.join(app.getPath('userData'), 'caption-models')
  return [
    fileUrlArg('--asset-base-url=', assetBaseDir),
    fileUrlArg('--caption-model-dir=', captionModelsDir),
  ]
}

// macOS 26 (Darwin 25) never paints a content-protected window: the Notes window
// would exist but stay invisible. Skip protection there unless forced back on.
const CONTENT_PROTECTION_DISABLED = process.env['CAPTURIA_DISABLE_CONTENT_PROTECTION'] === '1'
const CONTENT_PROTECTION_FORCED = process.env['CAPTURIA_FORCE_CONTENT_PROTECTION'] === '1'
const CONTENT_PROTECTION_BREAKS_DISPLAY =
  process.platform === 'darwin' &&
  Number.parseInt(process.getSystemVersion().split('.')[0] ?? '0', 10) >= 26

/**
 * Keep a window out of screen captures (including Capturia's own recording)
 * where the OS supports it. Linux has no equivalent; callers hide the feature
 * there instead of calling this.
 */
export function applyContentProtection(win: BrowserWindow, label: string): void {
  if (CONTENT_PROTECTION_DISABLED) {
    console.warn(
      `[content-protection] OFF for the ${label} window (CAPTURIA_DISABLE_CONTENT_PROTECTION=1) - it will appear in screen captures, including recordings. Unset it for anything but automated testing.`,
    )
    return
  }
  if (CONTENT_PROTECTION_BREAKS_DISPLAY && !CONTENT_PROTECTION_FORCED) {
    console.warn(
      `[content-protection] OFF for the ${label} window - macOS ${process.getSystemVersion()} never displays a content-protected window, so enabling it would make this window permanently invisible. It may therefore appear in screen captures. Set CAPTURIA_FORCE_CONTENT_PROTECTION=1 to re-test.`,
    )
    return
  }
  win.setContentProtection(true)
}

/**
 * Always-on-top scratchpad for notes while recording. Content-protected so it
 * stays out of the capture (see `applyContentProtection`).
 */
export function createNotesWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 400,
    height: 540,
    minWidth: 360,
    minHeight: 400,
    maxWidth: 640,
    maxHeight: 720,
    title: 'Capturia - Notes',
    backgroundColor: '#ffffff',
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })

  attachDevWindowLogging(win, 'notes')

  // Match the editor: no native OS menu bar on Windows/Linux (reachable via Alt).
  if (process.platform !== 'darwin') {
    win.setAutoHideMenuBar(true)
  }

  applyContentProtection(win, 'Notes')
  win.once('ready-to-show', () => {
    applyContentProtection(win, 'Notes')
    if (!HEADLESS) win.show()
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL + '?showNotes=true')
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'), {
      query: { showNotes: 'true' },
    })
  }

  return win
}

/**
 * Transparent, non-focusable countdown overlay centred on the primary display.
 * The HUD drives it over IPC (`countdown-overlay-show/set-value/hide`) from its
 * own countdown timer; the window is created once and hidden between runs.
 */
export function createCountdownOverlayWindow(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()
  const overlayWidth = 420
  const overlayHeight = 260

  const win = new BrowserWindow({
    width: overlayWidth,
    height: overlayHeight,
    minWidth: overlayWidth,
    maxWidth: overlayWidth,
    minHeight: overlayHeight,
    maxHeight: overlayHeight,
    x: Math.round(workArea.x + (workArea.width - overlayWidth) / 2),
    y: Math.round(workArea.y + (workArea.height - overlayHeight) / 2),
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    show: false,
    title: 'Capturia Countdown',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })

  attachDevWindowLogging(win, 'countdown-overlay')

  // Purely decorative: clicks fall through to whatever is underneath.
  win.setIgnoreMouseEvents(true)

  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL + '?windowType=countdown-overlay')
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'), {
      query: { windowType: 'countdown-overlay' },
    })
  }

  return win
}

function attachDevWindowLogging(win: BrowserWindow, label: string): void {
  if (!VITE_DEV_SERVER_URL) return

  // Electron 39 deprecates the positional `(event, level, message, line, sourceId)`
  // listener; the details now ride on the event object itself.
  win.webContents.on('console-message', (details) => {
    const tags: Record<string, string> = {
      info: 'LOG',
      debug: 'LOG',
      warning: 'WARN',
      error: 'ERR',
    }
    const tag = tags[details.level] ?? 'LOG'
    const shortSource = details.sourceId ? details.sourceId.replace(/.*\//, '') : ''
    console.log(`[${label}:${tag}] ${details.message} (${shortSource}:${details.lineNumber})`)
  })

  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      console.error(
        `[${label}:LOAD_FAIL] code=${errorCode} description=${errorDescription} url=${validatedURL}`,
      )
    },
  )
}

ipcMain.on('hud-overlay-hide', () => {
  if (hudOverlayWindow && !hudOverlayWindow.isDestroyed()) {
    hudOverlayWindow.minimize()
  }
})

// Recording mode: the renderer switches to its compact bar and the window
// follows the content through `hud-overlay-set-size` (see hudWindowsHandlers).
// This channel only re-asserts always-on-top: resizing/repositioning is
// unreliable on Wayland (the compositor ignores setBounds) and can place the
// window off-centre or in the top-left corner.

ipcMain.on('hud-overlay-resize', () => {
  if (!hudOverlayWindow || hudOverlayWindow.isDestroyed()) return
  // Re-apply always-on-top so the recording bar stays visible over other apps
  hudOverlayWindow.setAlwaysOnTop(true, 'screen-saver')
  hudOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
})

ipcMain.on('hud-overlay-restore', () => {
  if (!hudOverlayWindow || hudOverlayWindow.isDestroyed()) return
  // Un-minimize if the window was hidden during recording
  if (hudOverlayWindow.isMinimized()) {
    hudOverlayWindow.restore()
  }
  if (!HEADLESS) hudOverlayWindow.showInactive()
  hudOverlayWindow.setAlwaysOnTop(true, 'screen-saver')
  hudOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
})

export function createHudOverlayWindow(): BrowserWindow {
  const isLinux = process.platform === 'linux'
  const isLinuxWayland = isLinux && LINUX_SESSION_TYPE === 'wayland'
  const primaryDisplay = screen.getPrimaryDisplay()
  const { workArea } = primaryDisplay

  // First launch (or Wayland, where the window never resizes itself): a wide,
  // fairly tall transparent reserve so the bar and its popovers fit. Once the
  // renderer reports its content size the window shrinks to it, anchored at
  // its bottom-centre, and the reserve becomes click-through in the meantime.
  const horizontalMargin = 12
  const maxWindowWidth = 2200
  const availableWidth = Math.max(760, workArea.width - horizontalMargin)
  const defaultSize: HudSize = {
    width: Math.min(maxWindowWidth, availableWidth),
    height: Math.min(420, Math.max(300, Math.round(workArea.height * 0.38))),
  }
  const defaultAnchor: HudPoint = {
    x: Math.floor(workArea.x + workArea.width / 2),
    y: workArea.y + workArea.height - 8,
  }

  // Wayland ignores client-side positioning, so the remembered placement is moot there.
  const placement = isLinuxWayland ? null : readHudPlacement()
  const placementWorkArea = placement
    ? screen.getDisplayNearestPoint(placement.anchor).workArea
    : workArea
  const { x, y, width, height } = boundsFromHudAnchor(
    placement?.anchor ?? defaultAnchor,
    placement?.size ?? defaultSize,
    placementWorkArea,
  )

  const win = new BrowserWindow({
    width,
    height,
    // Loose on purpose: `hud-overlay-set-size` fits the window to its content.
    minWidth: HUD_MIN_WINDOW_SIZE.width,
    minHeight: HUD_MIN_WINDOW_SIZE.height,
    x,
    y,
    frame: false,
    transparent: true,
    // Fully transparent backing: without it macOS paints the window as a glass
    // panel, and the OS rounding would clip the bar's own corners.
    backgroundColor: '#00000000',
    roundedCorners: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: !isLinuxWayland,
    hasShadow: false,
    title: 'Capturia',
    show: !HEADLESS,
    // On Linux/X11:
    //   focusable: false — stops WM from managing stacking, buttons still receive clicks
    //   type: 'dock' — maps to _NET_WM_WINDOW_TYPE_DOCK (highest X11 stacking level)
    // On Linux/Wayland these hints can make the launcher effectively invisible
    // from normal desktop UX, so fall back to a normal focusable window.
    ...(isLinux && !isLinuxWayland && { focusable: false, type: 'dock' as const }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })

  attachDevWindowLogging(win, 'launch')

  // Re-apply always-on-top after creation and after show — some Linux X11 WMs
  // ignore the constructor option and need a post-show re-apply.
  // `visibleOnFullScreen` (macOS) lets the HUD follow the user across Spaces and
  // stay visible over a fullscreen app instead of staying pinned to the Space it
  // was first opened on. Wayland compositors reject the workspace hint entirely.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(!isLinuxWayland, { visibleOnFullScreen: true })
  win.once('show', () => {
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(!isLinuxWayland, { visibleOnFullScreen: true })
  })

  // Safety net: if the WM drops always-on-top, re-apply immediately.
  win.on('always-on-top-changed', (_event, isAlwaysOnTop) => {
    if (!isAlwaysOnTop && !win.isDestroyed()) {
      win.setAlwaysOnTop(true, 'screen-saver')
    }
  })

  // Fallback for Linux: periodically toggle always-on-top to force WM re-evaluation.
  // Some compositors (especially Wayland/Mutter) silently drop the state.
  if (isLinux) {
    const alwaysOnTopTimer = setInterval(() => {
      if (win.isDestroyed()) {
        clearInterval(alwaysOnTopTimer)
        return
      }
      if (!win.isMinimized() && !isLinuxWayland) {
        win.setAlwaysOnTop(false)
        win.setAlwaysOnTop(true, 'screen-saver')
      }
    }, 3000)
    win.on('closed', () => clearInterval(alwaysOnTopTimer))
  }

  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString())
  })

  hudOverlayWindow = win
  if (!isLinuxWayland) trackHudPlacement(win)

  win.on('closed', () => {
    if (hudOverlayWindow === win) {
      hudOverlayWindow = null
    }
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL + '?windowType=hud-overlay')
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'), {
      query: { windowType: 'hud-overlay' },
    })
  }

  return win
}

export function createEditorWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    ...(isMac && {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 12 },
    }),
    transparent: false,
    resizable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    title: 'Capturia',
    backgroundColor: '#09090b',
    show: false, // shown via ready-to-show to avoid a white flash on first load
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      backgroundThrottling: false,
      additionalArguments: editorAdditionalArguments(),
    },
  })

  attachDevWindowLogging(win, 'editor')

  // Maximize the window by default
  win.maximize()

  // The editor renders its own File/Edit/View menu bar in the custom titlebar,
  // so hide the native OS menu bar on Windows/Linux (it stays reachable via Alt).
  // macOS keeps its global menu bar.
  if (!isMac) {
    win.setAutoHideMenuBar(true)
  }

  // Show only once painted to avoid a white flash on cold Vite start.
  win.once('ready-to-show', () => {
    if (!HEADLESS) win.show()
  })

  // Inject the dark background before any React paint so the sub-titlebar area
  // never flashes white on a cold Vite load.
  win.webContents.on('dom-ready', () => {
    win.webContents.insertCSS('html, body, #root { background: #09090b !important; }').catch(() => {
      // Best-effort cosmetic; ignore if the page is mid-teardown.
    })
  })

  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString())
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL + '?windowType=editor')
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'), {
      query: { windowType: 'editor' },
    })
  }

  return win
}

export function createSourceSelectorWindow(): BrowserWindow {
  const isLinuxWayland = process.platform === 'linux' && LINUX_SESSION_TYPE === 'wayland'
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  const win = new BrowserWindow({
    width: 620,
    height: 420,
    minHeight: 350,
    maxHeight: 500,
    x: Math.round((width - 620) / 2),
    y: Math.round((height - 420) / 2),
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    transparent: true,
    skipTaskbar: !isLinuxWayland,
    title: 'Capturia Source Selector',
    backgroundColor: '#00000000',
    show: !HEADLESS,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  attachDevWindowLogging(win, 'source-selector')

  // Follow the user across macOS Spaces so the picker appears on the active
  // desktop (or over a fullscreen app) regardless of where the HUD was opened.
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL + '?windowType=source-selector')
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'), {
      query: { windowType: 'source-selector' },
    })
  }

  return win
}

export function getPermissionCheckerWindow(): BrowserWindow | null {
  if (permissionCheckerWindow && !permissionCheckerWindow.isDestroyed()) {
    return permissionCheckerWindow
  }
  permissionCheckerWindow = null
  return null
}

export function createPermissionCheckerWindow(): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const win = new BrowserWindow({
    width: Math.min(980, Math.max(840, width - 80)),
    height: Math.min(760, Math.max(620, height - 120)),
    minWidth: 840,
    minHeight: 620,
    x: Math.round((width - Math.min(980, Math.max(840, width - 80))) / 2),
    y: Math.round((height - Math.min(760, Math.max(620, height - 120))) / 2),
    title: 'Capturia Permission Check',
    frame: true,
    resizable: true,
    alwaysOnTop: true,
    backgroundColor: '#1c1c22',
    show: !HEADLESS,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  attachDevWindowLogging(win, 'permission-checker')

  // Same Spaces behaviour as the HUD and the source selector: the checker is
  // opened from the HUD and must show up where the user currently is.
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  permissionCheckerWindow = win
  win.on('closed', () => {
    if (permissionCheckerWindow === win) {
      permissionCheckerWindow = null
    }
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL + '?windowType=permission-checker')
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'), {
      query: { windowType: 'permission-checker' },
    })
  }

  return win
}
