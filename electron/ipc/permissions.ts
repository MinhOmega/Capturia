import { desktopCapturer, screen, shell, systemPreferences } from 'electron'
import type { IpcContext } from './context'

/**
 * Capture permissions (macOS TCC probing, System Settings deep links) and the
 * `get-sources` picker feed. Moved verbatim from `handlers.ts`.
 */

const SOURCE_PERMISSION_GUIDANCE =
  'Screen Recording permission is not granted. Open System Settings > Privacy & Security > Screen & System Audio, allow Capturia, then relaunch the app.'
const SCREEN_CAPTURE_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

export type CapturePermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown'
  | 'manual-check'
export type CapturePermissionKey =
  | 'screen'
  | 'camera'
  | 'microphone'
  | 'accessibility'
  | 'input-monitoring'
export type PermissionSettingsTarget =
  | 'screen-capture'
  | 'camera'
  | 'microphone'
  | 'accessibility'
  | 'input-monitoring'

export type CapturePermissionItem = {
  key: CapturePermissionKey
  status: CapturePermissionStatus
  requiredForRecording: boolean
  canOpenSettings: boolean
  settingsTarget?: PermissionSettingsTarget
}

export type CapturePermissionSnapshot = {
  platform: NodeJS.Platform
  checkedAtMs: number
  canOpenSystemSettings: boolean
  items: CapturePermissionItem[]
}

export type CapturePermissionActionResult = {
  success: boolean
  status?: CapturePermissionStatus
  openedSettings?: boolean
  message?: string
}

export const CAMERA_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera'
export const MICROPHONE_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
export const ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
export const INPUT_MONITORING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'

const PERMISSION_SETTINGS_URLS: Record<PermissionSettingsTarget, string> = {
  'screen-capture': SCREEN_CAPTURE_SETTINGS_URL,
  camera: CAMERA_SETTINGS_URL,
  microphone: MICROPHONE_SETTINGS_URL,
  accessibility: ACCESSIBILITY_SETTINGS_URL,
  'input-monitoring': INPUT_MONITORING_SETTINGS_URL,
}

export type ScreenCaptureAccessStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown'

export function normalizeScreenCaptureAccessStatus(input: unknown): ScreenCaptureAccessStatus {
  const normalized = String(input ?? '')
    .trim()
    .toLowerCase()
  switch (normalized) {
    case 'granted':
      return 'granted'
    case 'denied':
      return 'denied'
    case 'restricted':
      return 'restricted'
    case 'not-determined':
      return 'not-determined'
    default:
      return 'unknown'
  }
}

export function getScreenCaptureAccessStatusSync(): ScreenCaptureAccessStatus {
  if (process.platform !== 'darwin') {
    return 'granted'
  }
  try {
    return normalizeScreenCaptureAccessStatus(systemPreferences.getMediaAccessStatus('screen'))
  } catch {
    return 'unknown'
  }
}

export async function getScreenCaptureAccessStatus(): Promise<ScreenCaptureAccessStatus> {
  const reported = getScreenCaptureAccessStatusSync()
  if (reported === 'granted') {
    return 'granted'
  }

  // macOS TCC status can be stale after a restart. Probe with desktopCapturer
  // to detect whether the permission was actually granted.
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    })
    if (sources.length > 0) {
      return 'granted'
    }
  } catch {
    // probe failed – fall through to reported status
  }

  return reported
}

export function isScreenCaptureAccessBlocked(status: ScreenCaptureAccessStatus): boolean {
  return status === 'denied' || status === 'restricted'
}

export function getMediaPermissionStatus(
  mediaType: 'camera' | 'microphone',
): CapturePermissionStatus {
  if (process.platform !== 'darwin') {
    return 'granted'
  }
  try {
    return normalizeScreenCaptureAccessStatus(systemPreferences.getMediaAccessStatus(mediaType))
  } catch {
    return 'unknown'
  }
}

export function getAccessibilityPermissionStatus(): CapturePermissionStatus {
  if (process.platform !== 'darwin') {
    return 'granted'
  }
  try {
    return systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied'
  } catch {
    return 'unknown'
  }
}

export async function getCapturePermissionSnapshot(): Promise<CapturePermissionSnapshot> {
  const checkedAtMs = Date.now()
  const canOpenSystemSettings = process.platform === 'darwin'
  if (process.platform !== 'darwin') {
    return {
      platform: process.platform,
      checkedAtMs,
      canOpenSystemSettings: false,
      items: [
        {
          key: 'screen',
          status: 'granted',
          requiredForRecording: true,
          canOpenSettings: false,
          settingsTarget: 'screen-capture',
        },
        {
          key: 'camera',
          status: 'granted',
          requiredForRecording: false,
          canOpenSettings: false,
          settingsTarget: 'camera',
        },
        {
          key: 'microphone',
          status: 'granted',
          requiredForRecording: false,
          canOpenSettings: false,
          settingsTarget: 'microphone',
        },
        {
          key: 'accessibility',
          status: 'granted',
          requiredForRecording: false,
          canOpenSettings: false,
          settingsTarget: 'accessibility',
        },
        {
          key: 'input-monitoring',
          status: 'granted',
          requiredForRecording: false,
          canOpenSettings: false,
          settingsTarget: 'input-monitoring',
        },
      ],
    }
  }

  return {
    platform: process.platform,
    checkedAtMs,
    canOpenSystemSettings,
    items: [
      {
        key: 'screen',
        status: await getScreenCaptureAccessStatus(),
        requiredForRecording: true,
        canOpenSettings: canOpenSystemSettings,
        settingsTarget: 'screen-capture',
      },
      {
        key: 'camera',
        status: getMediaPermissionStatus('camera'),
        requiredForRecording: false,
        canOpenSettings: canOpenSystemSettings,
        settingsTarget: 'camera',
      },
      {
        key: 'microphone',
        status: getMediaPermissionStatus('microphone'),
        requiredForRecording: false,
        canOpenSettings: canOpenSystemSettings,
        settingsTarget: 'microphone',
      },
      {
        key: 'accessibility',
        status: getAccessibilityPermissionStatus(),
        requiredForRecording: false,
        canOpenSettings: canOpenSystemSettings,
        settingsTarget: 'accessibility',
      },
      {
        key: 'input-monitoring',
        status: 'manual-check',
        requiredForRecording: false,
        canOpenSettings: canOpenSystemSettings,
        settingsTarget: 'input-monitoring',
      },
    ],
  }
}

export function isBlockedPermissionStatus(status: CapturePermissionStatus): boolean {
  return status === 'denied' || status === 'restricted'
}

export async function openPermissionSettingsByTarget(
  target: PermissionSettingsTarget,
): Promise<void> {
  await shell.openExternal(PERMISSION_SETTINGS_URLS[target])
}

export async function requestScreenPermissionAccess(): Promise<CapturePermissionActionResult> {
  const initialStatus = await getScreenCaptureAccessStatus()
  if (initialStatus === 'granted') {
    return { success: true, status: initialStatus }
  }

  if (isScreenCaptureAccessBlocked(initialStatus)) {
    await openPermissionSettingsByTarget('screen-capture')
    return { success: true, status: initialStatus, openedSettings: true }
  }

  try {
    await getSourcesWithFallback({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    })
  } catch {
    // Permission probing may fail before the system status settles.
  }

  const latestStatus = await getScreenCaptureAccessStatus()
  if (latestStatus === 'granted') {
    return { success: true, status: latestStatus }
  }

  await openPermissionSettingsByTarget('screen-capture')
  return { success: true, status: latestStatus, openedSettings: true }
}

export async function requestMediaPermissionAccess(
  mediaType: 'camera' | 'microphone',
  target: 'camera' | 'microphone',
): Promise<CapturePermissionActionResult> {
  const initialStatus = getMediaPermissionStatus(mediaType)
  if (initialStatus === 'granted') {
    return { success: true, status: initialStatus }
  }

  if (isBlockedPermissionStatus(initialStatus)) {
    await openPermissionSettingsByTarget(target)
    return { success: true, status: initialStatus, openedSettings: true }
  }

  await systemPreferences.askForMediaAccess(mediaType)
  const latestStatus = getMediaPermissionStatus(mediaType)
  if (latestStatus === 'granted') {
    return { success: true, status: latestStatus }
  }

  await openPermissionSettingsByTarget(target)
  return { success: true, status: latestStatus, openedSettings: true }
}

export async function requestAccessibilityPermissionAccess(): Promise<CapturePermissionActionResult> {
  const granted = systemPreferences.isTrustedAccessibilityClient(true)
  if (granted) {
    return { success: true, status: 'granted' }
  }
  await openPermissionSettingsByTarget('accessibility')
  return { success: true, status: 'denied', openedSettings: true }
}

export async function requestCapturePermissionAccess(
  target: CapturePermissionKey,
): Promise<CapturePermissionActionResult> {
  if (process.platform !== 'darwin') {
    return { success: false, message: 'Permission request flow is only supported on macOS.' }
  }

  switch (target) {
    case 'screen':
      return requestScreenPermissionAccess()
    case 'camera':
      return requestMediaPermissionAccess('camera', 'camera')
    case 'microphone':
      return requestMediaPermissionAccess('microphone', 'microphone')
    case 'accessibility':
      return requestAccessibilityPermissionAccess()
    case 'input-monitoring':
      await openPermissionSettingsByTarget('input-monitoring')
      return { success: true, status: 'manual-check', openedSettings: true }
    default:
      return { success: false, message: `Unknown permission target: ${String(target)}` }
  }
}

export function normalizeGetSourcesOptions(
  input?: Partial<Electron.SourcesOptions>,
): Electron.SourcesOptions {
  const requestedTypes = Array.isArray(input?.types) ? input?.types : []
  const types: Array<'screen' | 'window'> = []
  for (const type of requestedTypes) {
    if (type === 'screen' || type === 'window') {
      types.push(type)
    }
  }

  const normalizedTypes: Array<'screen' | 'window'> =
    types.length > 0 ? types : ['screen', 'window']
  const width = Number(input?.thumbnailSize?.width)
  const height = Number(input?.thumbnailSize?.height)

  return {
    types: normalizedTypes,
    thumbnailSize: {
      width: Number.isFinite(width) && width > 0 ? Math.floor(width) : 320,
      height: Number.isFinite(height) && height > 0 ? Math.floor(height) : 180,
    },
    fetchWindowIcons: input?.fetchWindowIcons !== false,
  }
}

export function clampRecorderDimension(value: number): number {
  const rounded = Math.max(2, Math.round(value))
  return rounded % 2 === 0 ? rounded : rounded - 1
}

export function resolveSourceDisplaySize(source: Electron.DesktopCapturerSource): {
  width?: number
  height?: number
} {
  if (!source.id.startsWith('screen:')) {
    return {}
  }

  const displayId = Number(source.display_id)
  if (!Number.isFinite(displayId)) {
    return {}
  }

  const display = screen.getAllDisplays().find((row) => row.id === displayId)
  if (!display || display.size.width <= 1 || display.size.height <= 1) {
    return {}
  }

  const scaleFactor = Math.max(1, Number(display.scaleFactor) || 1)
  const nativeWidth = clampRecorderDimension(display.size.width * scaleFactor)
  const nativeHeight = clampRecorderDimension(display.size.height * scaleFactor)

  return {
    width: nativeWidth,
    height: nativeHeight,
  }
}

export function applyLongEdgeLimit(
  width: number,
  height: number,
  maxLongEdge: number,
): { width: number; height: number } {
  if (!Number.isFinite(maxLongEdge) || maxLongEdge <= 0) {
    return {
      width: clampRecorderDimension(width),
      height: clampRecorderDimension(height),
    }
  }

  const longEdge = Math.max(width, height)
  if (longEdge <= maxLongEdge) {
    return {
      width: clampRecorderDimension(width),
      height: clampRecorderDimension(height),
    }
  }

  const scale = maxLongEdge / longEdge
  return {
    width: clampRecorderDimension(width * scale),
    height: clampRecorderDimension(height * scale),
  }
}

export function isGetSourcesPermissionError(error: unknown): boolean {
  const message = String(
    (error as { message?: unknown } | undefined)?.message ?? error ?? '',
  ).toLowerCase()
  return (
    message.includes('permission') ||
    message.includes('not authorized') ||
    message.includes('denied') ||
    message.includes('tcc')
  )
}

export function formatGetSourcesError(error: unknown): string {
  const raw = String(
    (error as { message?: unknown } | undefined)?.message ?? error ?? 'Failed to get sources.',
  )
  if (isGetSourcesPermissionError(error)) {
    return `${raw} ${SOURCE_PERMISSION_GUIDANCE}`
  }
  return raw
}

export async function getSourcesWithFallback(
  opts: Electron.SourcesOptions,
): Promise<Electron.DesktopCapturerSource[]> {
  const attempts: Electron.SourcesOptions[] = [opts]

  if (opts.fetchWindowIcons) {
    attempts.push({
      ...opts,
      fetchWindowIcons: false,
    })
  }

  if (opts.types.includes('screen') && opts.types.includes('window')) {
    const noIcons = {
      ...opts,
      fetchWindowIcons: false,
    }
    attempts.push(
      {
        ...noIcons,
        types: ['screen'],
      },
      {
        ...noIcons,
        types: ['window'],
      },
    )
  }

  let lastError: unknown = null
  const collected = new Map<string, Electron.DesktopCapturerSource>()

  for (const attempt of attempts) {
    try {
      const sources = await desktopCapturer.getSources(attempt)
      for (const source of sources) {
        if (!collected.has(source.id)) {
          collected.set(source.id, source)
        }
      }
      if (attempt.types.length === 1) {
        continue
      }
      if (sources.length > 0) {
        return Array.from(collected.values())
      }
    } catch (error) {
      lastError = error
    }
  }

  if (collected.size > 0) {
    return Array.from(collected.values())
  }
  throw lastError ?? new Error('Failed to get sources.')
}

export function registerPermissionHandlers(ctx: IpcContext): void {
  const { ipcMain, getPermissionCheckerWindow, createPermissionCheckerWindow } = ctx

  ipcMain.handle('get-sources', async (_, opts) => {
    const normalized = normalizeGetSourcesOptions(opts)
    const accessStatus = await getScreenCaptureAccessStatus()
    if (isScreenCaptureAccessBlocked(accessStatus)) {
      throw new Error(`${SOURCE_PERMISSION_GUIDANCE} (status: ${accessStatus})`)
    }

    try {
      const sources = await getSourcesWithFallback(normalized)
      return sources.map((source) => ({
        id: source.id,
        name: source.name,
        display_id: source.display_id,
        ...resolveSourceDisplaySize(source),
        thumbnail: source.thumbnail ? source.thumbnail.toDataURL() : null,
        appIcon: source.appIcon ? source.appIcon.toDataURL() : null,
      }))
    } catch (error) {
      const latestStatus = await getScreenCaptureAccessStatus()
      if (isScreenCaptureAccessBlocked(latestStatus)) {
        throw new Error(`${SOURCE_PERMISSION_GUIDANCE} (status: ${latestStatus})`)
      }
      const message = formatGetSourcesError(error)
      console.error('Failed to get sources:', error)
      throw new Error(message)
    }
  })

  ipcMain.handle('get-screen-capture-access-status', async () => {
    const status = await getScreenCaptureAccessStatus()
    return {
      status,
      canOpenSystemSettings: process.platform === 'darwin',
    }
  })

  ipcMain.handle('get-capture-permission-snapshot', async () => {
    return await getCapturePermissionSnapshot()
  })

  ipcMain.handle(
    'request-capture-permission-access',
    async (_, target: CapturePermissionKey | string) => {
      if (process.platform !== 'darwin') {
        return { success: false, message: 'Permission request flow is only supported on macOS.' }
      }

      const normalizedTarget = typeof target === 'string' ? target.trim() : ''
      if (
        normalizedTarget !== 'screen' &&
        normalizedTarget !== 'camera' &&
        normalizedTarget !== 'microphone' &&
        normalizedTarget !== 'accessibility' &&
        normalizedTarget !== 'input-monitoring'
      ) {
        return { success: false, message: `Unknown permission target: ${String(target)}` }
      }

      try {
        return await requestCapturePermissionAccess(normalizedTarget)
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
  )

  ipcMain.handle(
    'open-permission-settings',
    async (_, target: PermissionSettingsTarget | string) => {
      if (process.platform !== 'darwin') {
        return { success: false, message: 'Opening Privacy settings is only supported on macOS.' }
      }

      const normalizedTarget = typeof target === 'string' ? target.trim() : ''
      const url = PERMISSION_SETTINGS_URLS[normalizedTarget as PermissionSettingsTarget]
      if (!url) {
        return { success: false, message: `Unknown permission settings target: ${String(target)}` }
      }

      try {
        await shell.openExternal(url)
        return { success: true }
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
  )

  ipcMain.handle('open-screen-capture-settings', async () => {
    if (process.platform !== 'darwin') {
      return {
        success: false,
        message: 'Opening Screen Capture settings is only supported on macOS.',
      }
    }
    try {
      await shell.openExternal(PERMISSION_SETTINGS_URLS['screen-capture'])
      return { success: true }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })

  ipcMain.handle('open-permission-checker', () => {
    const permissionWindow = getPermissionCheckerWindow()
    if (permissionWindow) {
      permissionWindow.focus()
      return { success: true }
    }
    createPermissionCheckerWindow()
    return { success: true }
  })
}
