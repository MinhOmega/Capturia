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
import { scheduleRecordingsCleanup } from './recordingsCleanup'
import { buildIssueReportUrl } from '../src/lib/supportLinks'


const __dirname = path.dirname(fileURLToPath(import.meta.url))

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

// Tray Icons
const defaultTrayIcon = getTrayIcon('cursorlens.png');
const recordingTrayIcon = getTrayIcon('rec-button.png');

function createWindow() {
  mainWindow = createHudOverlayWindow()
}

function createTray() {
  tray = new Tray(defaultTrayIcon);
}

function getTrayIcon(filename: string) {
  return nativeImage.createFromPath(path.join(process.env.VITE_PUBLIC || RENDERER_DIST, filename)).resize({
    width: 24,
    height: 24,
    quality: 'best'
  });
}

function currentLocale(): 'en' | 'zh-CN' {
  return app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

function runtimeErrorText(
  locale: 'en' | 'zh-CN',
  key: 'message' | 'detailPrefix' | 'report' | 'close',
): string {
  const zh: Record<'message' | 'detailPrefix' | 'report' | 'close', string> = {
    message: '程序发生了内部错误，建议反馈问题以便排查。',
    detailPrefix: '错误编号',
    report: '反馈问题',
    close: '关闭',
  }
  const en: Record<'message' | 'detailPrefix' | 'report' | 'close', string> = {
    message: 'CursorLens hit an internal error. Please report this issue so we can fix it.',
    detailPrefix: 'Reference',
    report: 'Report Bug',
    close: 'Close',
  }
  return (locale === 'zh-CN' ? zh : en)[key]
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
      title: 'CursorLens',
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
  console.error(`[runtime-error] ${context}`, error)
  void showRuntimeErrorDialog(context, error)
}

function trayText(locale: 'en' | 'zh-CN', key: 'app' | 'recording' | 'stop' | 'open' | 'quit', source?: string): string {
  const dict = locale === 'zh-CN'
    ? {
        app: 'CursorLens',
        recording: `录制中：${source ?? ''}`,
        stop: '停止录制',
        open: '打开',
        quit: '退出',
      }
    : {
        app: 'CursorLens',
        recording: `Recording: ${source ?? ''}`,
        stop: 'Stop Recording',
        open: 'Open',
        quit: 'Quit',
      }
  return dict[key]
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
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.isMinimized() && mainWindow.restore();
            } else {
              createWindow();
            }
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
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
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



// Register all IPC handlers when app is ready
app.whenReady().then(async () => {
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
  protocol.handle('local-media', async (request) => {
    try {
      const url = new URL(request.url)
      const filePath = decodeURIComponent(url.pathname)
      const stat = statSync(filePath)
      const ext = path.extname(filePath).toLowerCase()
      const mimeMap: Record<string, string> = {
        '.webm': 'video/webm',
        '.mp4': 'video/mp4',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
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
    createWindow()
  })

  ipcMain.handle('set-stop-recording-shortcut', (_, accelerator: string) => {
    return registerStopRecordingShortcut(accelerator)
  })
  ipcMain.handle('get-stop-recording-shortcut', () => {
    return { success: true, accelerator: stopRecordingShortcut }
  })
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
