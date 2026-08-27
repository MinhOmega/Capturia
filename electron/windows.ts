import { BrowserWindow, screen } from 'electron'
import { ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const APP_ROOT = path.join(__dirname, '..')
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
const RENDERER_DIST = path.join(APP_ROOT, 'dist')
const LINUX_SESSION_TYPE = (process.env['XDG_SESSION_TYPE'] || '').toLowerCase()

let hudOverlayWindow: BrowserWindow | null = null;
let permissionCheckerWindow: BrowserWindow | null = null;

function attachDevWindowLogging(win: BrowserWindow, label: string): void {
  if (!VITE_DEV_SERVER_URL) return

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levelNames = ['LOG', 'WARN', 'ERR']
    const tag = levelNames[level] ?? 'LOG'
    const shortSource = sourceId ? sourceId.replace(/.*\//, '') : ''
    console.log(`[${label}:${tag}] ${message} (${shortSource}:${line})`)
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    console.error(`[${label}:LOAD_FAIL] code=${errorCode} description=${errorDescription} url=${validatedURL}`)
  })
}

ipcMain.on('hud-overlay-hide', () => {
  if (hudOverlayWindow && !hudOverlayWindow.isDestroyed()) {
    hudOverlayWindow.minimize();
  }
});

// Recording mode: keep the full-size transparent overlay window — the renderer
// handles compact-bar layout via CSS.  Resizing/repositioning is unreliable on
// Wayland (compositor ignores setBounds) and can place the window off-center
// or in the top-left corner.  Instead we just ensure always-on-top is enforced.

ipcMain.on('hud-overlay-resize', () => {
  if (!hudOverlayWindow || hudOverlayWindow.isDestroyed()) return;
  // Re-apply always-on-top so the recording bar stays visible over other apps
  hudOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
  hudOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
});

ipcMain.on('hud-overlay-restore', () => {
  if (!hudOverlayWindow || hudOverlayWindow.isDestroyed()) return;
  // Un-minimize if the window was hidden during recording
  if (hudOverlayWindow.isMinimized()) {
    hudOverlayWindow.restore();
  }
  hudOverlayWindow.showInactive();
  hudOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
  hudOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
});

export function createHudOverlayWindow(): BrowserWindow {
  const isLinux = process.platform === 'linux';
  const isLinuxWayland = isLinux && LINUX_SESSION_TYPE === 'wayland';
  const primaryDisplay = screen.getPrimaryDisplay();
  const { workArea } = primaryDisplay;

  const horizontalMargin = 12;
  const maxWindowWidth = 2200;
  const availableWidth = Math.max(760, workArea.width - horizontalMargin);
  const windowWidth = Math.min(maxWindowWidth, availableWidth);
  const windowHeight = Math.min(420, Math.max(300, Math.round(workArea.height * 0.38)));

  const x = Math.floor(workArea.x + (workArea.width - windowWidth) / 2);
  const y = Math.floor(workArea.y + workArea.height - windowHeight - 8);

  const win = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: windowWidth,
    maxWidth: windowWidth,
    minHeight: windowHeight,
    maxHeight: windowHeight,
    x: x,
    y: y,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: !isLinuxWayland,
    hasShadow: false,
    title: 'Capturia',
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
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(!isLinuxWayland, { visibleOnFullScreen: true });
  win.once('show', () => {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(!isLinuxWayland, { visibleOnFullScreen: true });
  });

  // Safety net: if the WM drops always-on-top, re-apply immediately.
  win.on('always-on-top-changed', (_event, isAlwaysOnTop) => {
    if (!isAlwaysOnTop && !win.isDestroyed()) {
      win.setAlwaysOnTop(true, 'screen-saver');
    }
  });

  // Fallback for Linux: periodically toggle always-on-top to force WM re-evaluation.
  // Some compositors (especially Wayland/Mutter) silently drop the state.
  if (isLinux) {
    const alwaysOnTopTimer = setInterval(() => {
      if (win.isDestroyed()) {
        clearInterval(alwaysOnTopTimer);
        return;
      }
      if (!win.isMinimized() && !isLinuxWayland) {
        win.setAlwaysOnTop(false);
        win.setAlwaysOnTop(true, 'screen-saver');
      }
    }, 3000);
    win.on('closed', () => clearInterval(alwaysOnTopTimer));
  }

  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  hudOverlayWindow = win;

  win.on('closed', () => {
    if (hudOverlayWindow === win) {
      hudOverlayWindow = null;
    }
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL + '?windowType=hud-overlay')
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'), {
      query: { windowType: 'hud-overlay' }
    })
  }

  return win
}

export function createEditorWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';

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
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      backgroundThrottling: false,
    },
  })

  attachDevWindowLogging(win, 'editor')

  // Maximize the window by default
  win.maximize();

  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL + '?windowType=editor')
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'), {
      query: { windowType: 'editor' }
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
      query: { windowType: 'source-selector' } 
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
