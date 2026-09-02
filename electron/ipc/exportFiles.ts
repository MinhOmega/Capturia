import { app, type BrowserWindow, dialog, shell } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { mainT, resolveMainLocale } from '../i18n'
import type { IpcContext } from './context'
import {
  approvedExportPaths,
  approveFilePath,
  hasAllowedImportVideoExtension,
  isAllowedExportPath,
  isAllowedRevealPath,
  normalizeExternalUrl,
  resolveOutputPathInDir,
} from './paths'

/**
 * Native dialogs (save / open / folder pickers), export writes, reveal-in-folder
 * and the external-URL allowlist. Path guards and dialog parents are exactly as
 * W0-b left them; moved verbatim from `handlers.ts`.
 */

type SaveExportedVideoOptions = {
  directoryPath?: string | null
  targetFilePath?: string | null
}

// Dialog strings live in src/i18n/locales/<locale>/common.json under `electron.*`.
// `localeInput` is the renderer's locale when the call carries one; otherwise the
// locale announced through the `set-locale` IPC is used.
function normalizeLocale(input?: string): string {
  return resolveMainLocale(input)
}

function tt(locale: string, key: string): string {
  return mainT(locale, `common.electron.${key}`)
}

// Attach the parent window only when valid, to avoid passing a destroyed BrowserWindow
// to dialogs. A parent is required on Wayland compositors (e.g. Hyprland) or the
// dialog can open detached / behind the app.
function buildDialogOptions<T extends Electron.OpenDialogOptions | Electron.SaveDialogOptions>(
  baseOptions: T,
  parentWindow: BrowserWindow | null,
): T & { parent?: BrowserWindow } {
  if (parentWindow && !parentWindow.isDestroyed()) {
    return { ...baseOptions, parent: parentWindow }
  }
  return baseOptions
}

/** Save dialogs on GTK do not append the filter extension; make sure exports keep theirs. */
function ensureExportExtension(filePath: string, isGif: boolean): string {
  const expected = isGif ? '.gif' : '.mp4'
  return path.extname(filePath).toLowerCase() === expected ? filePath : `${filePath}${expected}`
}

export function registerExportFilesHandlers(ctx: IpcContext): void {
  const { ipcMain, recordingsDir, getMainWindow } = ctx

  ipcMain.handle('open-external-url', async (_, url: string) => {
    try {
      const externalUrl = normalizeExternalUrl(url)
      if (!externalUrl) {
        console.warn('Refused to open external URL:', url)
        return { success: false, error: 'Unsupported URL protocol' }
      }
      await shell.openExternal(externalUrl)
      return { success: true }
    } catch (error) {
      console.error('Failed to open URL:', error)
      return { success: false, error: String(error) }
    }
  })

  // Return base path for assets so renderer can resolve file:// paths in production
  ipcMain.handle('get-asset-base-path', () => {
    try {
      if (app.isPackaged) {
        return path.join(process.resourcesPath, 'assets')
      }
      return path.join(app.getAppPath(), 'public', 'assets')
    } catch (err) {
      console.error('Failed to resolve asset base path:', err)
      return null
    }
  })

  ipcMain.handle('reveal-in-folder', async (_, rawFilePath: string) => {
    const filePath = typeof rawFilePath === 'string' ? path.normalize(rawFilePath.trim()) : ''
    if (!isAllowedRevealPath(filePath, { recordingsDir: recordingsDir })) {
      console.warn('Refused to reveal path outside approved locations:', rawFilePath)
      return { success: false, error: 'Path is not an app-managed file' }
    }
    try {
      shell.showItemInFolder(filePath)
      return { success: true }
    } catch (error) {
      console.error(`Error revealing item in folder: ${filePath}`, error)
      try {
        const openResult = await shell.openPath(path.dirname(filePath))
        if (openResult) {
          return { success: false, error: openResult }
        }
        return { success: true, message: 'Opened directory instead.' }
      } catch (openError) {
        console.error(`Error opening directory: ${path.dirname(filePath)}`, openError)
        return { success: false, error: String(error) }
      }
    }
  })

  ipcMain.handle('save-exported-video', async (_, videoData: ArrayBuffer, fileName: string, localeInput?: string, options?: SaveExportedVideoOptions) => {
    try {
      const locale = normalizeLocale(localeInput)
      // Determine file type from extension
      const isGif = fileName.toLowerCase().endsWith('.gif');
      const filters = isGif 
        ? [{ name: 'GIF', extensions: ['gif'] }]
        : [{ name: 'MP4', extensions: ['mp4'] }];
      const targetFilePath = typeof options?.targetFilePath === 'string' && options.targetFilePath.trim().length > 0
        ? path.normalize(options.targetFilePath.trim())
        : null
      const directoryPath = typeof options?.directoryPath === 'string' && options.directoryPath.trim().length > 0
        ? path.normalize(options.directoryPath.trim())
        : null

      let targetPath: string
      if (targetFilePath) {
        // Path was pre-selected by the user via `pick-save-file-path`; the renderer
        // only echoes it back, so anything else is refused.
        if (!isAllowedExportPath(targetFilePath)) {
          console.warn('Refused export to unapproved target path:', targetFilePath)
          return { success: false, message: tt(locale, 'exportPathRejected') }
        }
        await fs.mkdir(path.dirname(targetFilePath), { recursive: true })
        targetPath = targetFilePath
      } else if (directoryPath) {
        // Directory came from `pick-export-directory`; fileName must be a bare name.
        if (!approvedExportPaths.isApprovedDirectory(directoryPath)) {
          console.warn('Refused export to unapproved directory:', directoryPath)
          return { success: false, message: tt(locale, 'exportPathRejected') }
        }
        targetPath = resolveOutputPathInDir(directoryPath, fileName)
        if (!isAllowedExportPath(targetPath)) {
          console.warn('Refused export with unsupported file name:', fileName)
          return { success: false, message: tt(locale, 'exportPathRejected') }
        }
        await fs.mkdir(directoryPath, { recursive: true })
      } else {
        const result = await dialog.showSaveDialog(buildDialogOptions({
          title: isGif ? tt(locale, 'saveGif') : tt(locale, 'saveVideo'),
          defaultPath: path.join(app.getPath('downloads'), fileName),
          filters,
          properties: ['createDirectory', 'showOverwriteConfirmation']
        }, getMainWindow()));

        if (result.canceled || !result.filePath) {
          return {
            success: false,
            cancelled: true,
            message: tt(locale, 'exportCancelled')
          };
        }
        targetPath = ensureExportExtension(path.normalize(result.filePath), isGif)
        approvedExportPaths.approveFile(targetPath)
      }

      await fs.writeFile(targetPath, Buffer.from(videoData));

      return {
        success: true,
        path: targetPath,
        message: tt(locale, 'exportSaved')
      };
    } catch (error) {
      console.error('Failed to save exported video:', error)
      return {
        success: false,
        message: tt(normalizeLocale(), 'exportSaveFailed'),
        error: String(error)
      }
    }
  })

  // Prefer the user's last export folder if it still exists, else ~/Downloads.
  // Validated here because the renderer cannot stat the filesystem.
  const resolveDefaultExportDir = async (exportFolder?: unknown): Promise<string> => {
    if (typeof exportFolder !== 'string' || exportFolder.trim().length === 0) {
      return app.getPath('downloads')
    }
    try {
      const stats = await fs.stat(exportFolder)
      if (stats.isDirectory()) {
        return exportFolder
      }
    } catch (err) {
      console.warn(`Could not access remembered export folder "${exportFolder}", falling back to Downloads:`, err)
    }
    return app.getPath('downloads')
  }

  ipcMain.handle('pick-save-file-path', async (_, fileName: string, localeInput?: string, exportFolder?: string) => {
    try {
      const locale = normalizeLocale(localeInput)
      const isGif = fileName.toLowerCase().endsWith('.gif')
      const filters = isGif
        ? [{ name: 'GIF', extensions: ['gif'] }]
        : [{ name: 'MP4', extensions: ['mp4'] }]
      const defaultDir = await resolveDefaultExportDir(exportFolder)

      const result = await dialog.showSaveDialog(buildDialogOptions({
        title: isGif ? tt(locale, 'saveGif') : tt(locale, 'saveVideo'),
        defaultPath: path.join(defaultDir, fileName),
        filters,
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      }, getMainWindow()))

      if (result.canceled || !result.filePath) {
        return { success: false, cancelled: true, message: tt(locale, 'exportCancelled') }
      }

      const chosenPath = ensureExportExtension(path.normalize(result.filePath), isGif)
      approvedExportPaths.approveFile(chosenPath)
      return { success: true, path: chosenPath }
    } catch (error) {
      console.error('Failed to pick save file path:', error)
      return { success: false, message: tt(normalizeLocale(), 'exportSaveFailed'), error: String(error) }
    }
  })

  ipcMain.handle('pick-export-directory', async (_, localeInput?: string, exportFolder?: string) => {
    try {
      const locale = normalizeLocale(localeInput)
      const result = await dialog.showOpenDialog(buildDialogOptions({
        title: tt(locale, 'chooseExportFolder'),
        defaultPath: await resolveDefaultExportDir(exportFolder),
        properties: ['openDirectory', 'createDirectory'],
      }, getMainWindow()))

      if (result.canceled || result.filePaths.length === 0) {
        return {
          success: false,
          cancelled: true,
          message: tt(locale, 'exportCancelled'),
        }
      }

      const chosenDirectory = path.normalize(result.filePaths[0])
      approvedExportPaths.approveDirectory(chosenDirectory)
      return {
        success: true,
        path: chosenDirectory,
      }
    } catch (error) {
      console.error('Failed to pick export directory:', error)
      return {
        success: false,
        message: tt(normalizeLocale(), 'exportSaveFailed'),
        error: String(error),
      }
    }
  })

  ipcMain.handle('open-video-file-picker', async (_, localeInput?: string) => {
    try {
      const locale = normalizeLocale(localeInput)
      const result = await dialog.showOpenDialog(buildDialogOptions({
        title: tt(locale, 'selectVideoFile'),
        defaultPath: recordingsDir,
        filters: [
          { name: tt(locale, 'videoFiles'), extensions: ['webm', 'mp4', 'mov', 'avi', 'mkv', 'm4v', 'wmv', 'flv', 'ts'] },
          { name: tt(locale, 'allFiles'), extensions: ['*'] }
        ],
        properties: ['openFile']
      }, getMainWindow()));

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, cancelled: true };
      }

      const chosenPath = path.normalize(result.filePaths[0])
      if (!hasAllowedImportVideoExtension(chosenPath)) {
        return { success: false, message: tt(locale, 'unsupportedVideoFile') }
      }
      // User explicitly picked this file: allow `local-media://` + sidecar reads for it.
      approveFilePath(chosenPath)

      return {
        success: true,
        path: chosenPath
      };
    } catch (error) {
      console.error('Failed to open file picker:', error);
      return {
        success: false,
        message: tt(normalizeLocale(), 'filePickerFailed'),
        error: String(error)
      };
    }
  });
}
