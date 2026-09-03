import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  type AutoUpdaterDeps,
  type AutoUpdaterPrompts,
  type UpdateProgressEvent,
  type UpdaterLike,
  availableDialogAction,
  classifyUpdateError,
  configureUpdater,
  createAutoUpdater,
  DEFAULT_UPDATE_PREFERENCES,
  downloadedDialogAction,
  getUpdaterEligibility,
  parseUpdatePreferences,
  resolveInstallAction,
  serializeUpdatePreferences,
  shouldFallBackToReleasePage,
  shouldRunLaunchCheck,
} from './auto-updater'
import type { InstallChannel } from './install-channel'

const ALL_CHANNELS: InstallChannel[] = [
  'nsis',
  'dmg',
  'appimage',
  'deb',
  'rpm',
  'pacman',
  'store',
  'flatpak',
  'snap',
  'nix',
  'dev',
  'unknown',
]

describe('getUpdaterEligibility', () => {
  it('serves only the installers we publish feeds for', () => {
    const eligible = ALL_CHANNELS.filter((c) => getUpdaterEligibility(c, true).eligible)
    expect(eligible).toEqual(['nsis', 'dmg', 'appimage'])
  })

  it('names the channel as the reason for package-manager and unknown installs', () => {
    for (const channel of ['deb', 'rpm', 'pacman', 'store', 'flatpak', 'snap', 'nix', 'unknown']) {
      expect(getUpdaterEligibility(channel as InstallChannel, true)).toEqual({
        eligible: false,
        reason: 'channel',
      })
    }
  })

  it('refuses an unpacked build even on an eligible channel', () => {
    expect(getUpdaterEligibility('dmg', false)).toEqual({ eligible: false, reason: 'unpacked' })
  })
})

describe('shouldRunLaunchCheck', () => {
  it('runs only when eligible, enabled and idle', () => {
    expect(shouldRunLaunchCheck({ eligible: true, autoUpdateCheck: true, recording: false })).toBe(
      true,
    )
    expect(shouldRunLaunchCheck({ eligible: false, autoUpdateCheck: true, recording: false })).toBe(
      false,
    )
    expect(shouldRunLaunchCheck({ eligible: true, autoUpdateCheck: false, recording: false })).toBe(
      false,
    )
    expect(shouldRunLaunchCheck({ eligible: true, autoUpdateCheck: true, recording: true })).toBe(
      false,
    )
  })
})

describe('update preferences', () => {
  it('defaults to checking on launch', () => {
    expect(DEFAULT_UPDATE_PREFERENCES).toEqual({ autoUpdateCheck: true })
    expect(parseUpdatePreferences(null)).toEqual({ autoUpdateCheck: true })
    expect(parseUpdatePreferences('')).toEqual({ autoUpdateCheck: true })
    expect(parseUpdatePreferences('{not json')).toEqual({ autoUpdateCheck: true })
    expect(parseUpdatePreferences('[]')).toEqual({ autoUpdateCheck: true })
    expect(parseUpdatePreferences('{"autoUpdateCheck":"no"}')).toEqual({ autoUpdateCheck: true })
  })

  it('honours only an explicit false', () => {
    expect(parseUpdatePreferences('{"autoUpdateCheck":false}')).toEqual({ autoUpdateCheck: false })
  })

  it('round-trips through serialize', () => {
    const text = serializeUpdatePreferences({ autoUpdateCheck: false })
    expect(parseUpdatePreferences(text)).toEqual({ autoUpdateCheck: false })
    expect(JSON.parse(text)).toEqual({ autoUpdateCheck: false })
  })
})

describe('classifyUpdateError', () => {
  it('recognises offline failures by code and by message', () => {
    expect(classifyUpdateError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe(
      'offline',
    )
    expect(classifyUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe('offline')
    expect(classifyUpdateError(new Error('getaddrinfo EAI_AGAIN github.com'))).toBe('offline')
    expect(classifyUpdateError(new Error('net::ERR_CONNECTION_RESET'))).toBe('offline')
  })

  it('recognises a release without update feeds', () => {
    expect(
      classifyUpdateError(
        Object.assign(new Error('x'), { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' }),
      ),
    ).toBe('no-release')
    expect(classifyUpdateError(Object.assign(new Error('x'), { statusCode: 404 }))).toBe(
      'no-release',
    )
    expect(
      classifyUpdateError(
        new Error('Cannot find latest-mac.yml in the latest release artifacts (HttpError: 404)'),
      ),
    ).toBe('no-release')
    expect(classifyUpdateError(new Error('Unable to find latest version on GitHub'))).toBe(
      'no-release',
    )
  })

  it('recognises signature refusals from both Squirrel and the Windows verifier', () => {
    expect(
      classifyUpdateError(new Error('Could not get code signature for running application')),
    ).toBe('unsigned')
    expect(
      classifyUpdateError(
        new Error(
          'New version 1.8.0 is not signed by the application owner: publisher name mismatch',
        ),
      ),
    ).toBe('unsigned')
  })

  it('falls through to unknown for anything else, including non-Error values', () => {
    expect(classifyUpdateError(new Error('boom'))).toBe('unknown')
    expect(classifyUpdateError('boom')).toBe('unknown')
    expect(classifyUpdateError(undefined)).toBe('unknown')
  })

  it('only signature and missing-feed failures fall back to the release page', () => {
    expect(shouldFallBackToReleasePage('unsigned')).toBe(true)
    expect(shouldFallBackToReleasePage('no-release')).toBe(true)
    expect(shouldFallBackToReleasePage('offline')).toBe(false)
    expect(shouldFallBackToReleasePage('unknown')).toBe(false)
  })
})

describe('dialog decisions', () => {
  it('treats only the first button as consent', () => {
    expect(availableDialogAction(0)).toBe('download')
    expect(availableDialogAction(1)).toBe('later')
    expect(availableDialogAction(-1)).toBe('later')
    expect(downloadedDialogAction(0)).toBe('restart')
    expect(downloadedDialogAction(1)).toBe('on-quit')
  })

  it('defers a restart requested mid-recording to quit', () => {
    expect(resolveInstallAction('restart', { recording: true })).toBe('on-quit')
    expect(resolveInstallAction('restart', { recording: false })).toBe('restart')
    expect(resolveInstallAction('on-quit', { recording: false })).toBe('on-quit')
  })
})

// ── Controller ────────────────────────────────────────────────────────────

class FakeUpdater extends EventEmitter implements UpdaterLike {
  // electron-updater's defaults, so a test asserting the safe values proves
  // configureUpdater ran rather than reading a value never touched.
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  logger: unknown = {}
  checkForUpdates = vi.fn<UpdaterLike['checkForUpdates']>()
  downloadUpdate = vi.fn<UpdaterLike['downloadUpdate']>()
  quitAndInstall = vi.fn<UpdaterLike['quitAndInstall']>()
}

function makePrompts(overrides: Partial<AutoUpdaterPrompts> = {}): AutoUpdaterPrompts {
  return {
    available: vi.fn(async () => 'later' as const),
    downloaded: vi.fn(async () => 'on-quit' as const),
    current: vi.fn(async () => undefined),
    failed: vi.fn(async () => undefined),
    ...overrides,
  }
}

function harness(overrides: Partial<AutoUpdaterDeps> = {}) {
  const updater = new FakeUpdater()
  const events: UpdateProgressEvent[] = []
  const prompts = makePrompts()
  const fallbackToReleasePage = vi.fn(async () => undefined)
  const deps: AutoUpdaterDeps = {
    updater,
    currentVersion: '1.7.0',
    isRecording: () => false,
    emit: (event) => events.push(event),
    prompts,
    fallbackToReleasePage,
    ...overrides,
  }
  const controller = createAutoUpdater(deps)
  return { updater, events, prompts, fallbackToReleasePage, controller, deps }
}

describe('createAutoUpdater', () => {
  it('applies the safe settings before the first check', async () => {
    const { updater, controller } = harness()
    const seen: boolean[] = []
    updater.checkForUpdates.mockImplementation(async () => {
      seen.push(updater.autoDownload, updater.autoInstallOnAppQuit, updater.allowPrerelease)
      return { isUpdateAvailable: false, updateInfo: { version: '1.7.0' } }
    })
    await controller.check('launch')
    expect(seen).toEqual([false, true, false])
    expect(updater.logger).toBeNull()
  })

  it('configureUpdater is idempotent', () => {
    const updater = new FakeUpdater()
    configureUpdater(updater)
    configureUpdater(updater)
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(updater.allowPrerelease).toBe(false)
  })

  it('stays silent on launch when already current, but tells the user from the menu', async () => {
    const { updater, controller, prompts, events } = harness()
    updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: { version: '1.7.0' },
    })
    await expect(controller.check('launch')).resolves.toEqual({ kind: 'current', version: '1.7.0' })
    expect(prompts.current).not.toHaveBeenCalled()
    await controller.check('menu')
    expect(prompts.current).toHaveBeenCalledWith('1.7.0')
    expect(events.map((e) => e.phase)).toEqual(['checking', 'current', 'checking', 'current'])
  })

  it('treats a null result and an equal version without the flag as current', async () => {
    const { updater, controller } = harness()
    updater.checkForUpdates.mockResolvedValueOnce(null)
    await expect(controller.check('launch')).resolves.toMatchObject({ kind: 'current' })
    updater.checkForUpdates.mockResolvedValueOnce({ updateInfo: { version: '1.7.0' } })
    await expect(controller.check('launch')).resolves.toMatchObject({ kind: 'current' })
  })

  it('offers the download and does nothing more on "Later"', async () => {
    const { updater, controller, prompts, events } = harness()
    updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.8.0' },
    })
    await expect(controller.check('launch')).resolves.toEqual({
      kind: 'available',
      version: '1.8.0',
      action: 'later',
    })
    expect(prompts.available).toHaveBeenCalledWith('1.8.0')
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(events).toContainEqual({ phase: 'available', version: '1.8.0' })
  })

  it('downloads on consent, forwards progress, then offers the restart', async () => {
    const { updater, controller, prompts, events } = harness()
    ;(prompts.available as ReturnType<typeof vi.fn>).mockResolvedValue('download')
    ;(prompts.downloaded as ReturnType<typeof vi.fn>).mockResolvedValue('restart')
    updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.8.0' },
    })
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit('download-progress', {
        percent: 50,
        transferred: 5,
        total: 10,
        bytesPerSecond: 1,
      })
      updater.emit('update-downloaded', { version: '1.8.0' })
      return ['/tmp/update']
    })

    await expect(controller.check('menu')).resolves.toEqual({
      kind: 'downloaded',
      version: '1.8.0',
      action: 'restart',
    })
    expect(events).toContainEqual({
      phase: 'downloading',
      version: '1.8.0',
      percent: 50,
      transferred: 5,
      total: 10,
      bytesPerSecond: 1,
    })
    expect(events).toContainEqual({ phase: 'downloaded', version: '1.8.0' })
    expect(prompts.downloaded).toHaveBeenCalledWith('1.8.0')
    // Non-silent (Windows elevation prompt) and force-run so the app returns.
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(controller.downloadedVersion()).toBe('1.8.0')
  })

  it('never restarts while a recording is running; the install waits for quit', async () => {
    const { updater, controller, prompts } = harness({ isRecording: () => true })
    ;(prompts.available as ReturnType<typeof vi.fn>).mockResolvedValue('download')
    ;(prompts.downloaded as ReturnType<typeof vi.fn>).mockResolvedValue('restart')
    updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.8.0' },
    })
    updater.downloadUpdate.mockResolvedValue([])
    await expect(controller.check('menu')).resolves.toMatchObject({ action: 'on-quit' })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('re-offers a downloaded update from the menu without checking again', async () => {
    const { updater, controller, prompts } = harness()
    ;(prompts.available as ReturnType<typeof vi.fn>).mockResolvedValue('download')
    updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.8.0' },
    })
    updater.downloadUpdate.mockResolvedValue([])
    await controller.check('launch')
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)

    await expect(controller.check('menu')).resolves.toEqual({
      kind: 'downloaded',
      version: '1.8.0',
      action: 'on-quit',
    })
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(prompts.downloaded).toHaveBeenCalledTimes(2)
  })

  it('reports a second check as busy while one is in flight', async () => {
    const { updater, controller } = harness()
    const gate: { release: (() => void) | null } = { release: null }
    updater.checkForUpdates.mockImplementation(
      () =>
        new Promise((resolve) => {
          gate.release = () =>
            resolve({ isUpdateAvailable: false, updateInfo: { version: '1.7.0' } })
        }),
    )
    const first = controller.check('launch')
    await expect(controller.check('menu')).resolves.toEqual({ kind: 'busy' })
    gate.release?.()
    await expect(first).resolves.toMatchObject({ kind: 'current' })
  })

  it('falls back to the release page when the build is unsigned or the feed is missing', async () => {
    const { updater, controller, prompts, fallbackToReleasePage } = harness()
    updater.checkForUpdates.mockRejectedValueOnce(
      Object.assign(new Error('HttpError: 404'), { statusCode: 404 }),
    )
    await expect(controller.check('menu')).resolves.toMatchObject({
      kind: 'failed',
      errorKind: 'no-release',
      stage: 'check',
    })
    expect(fallbackToReleasePage).toHaveBeenCalledTimes(1)
    expect(prompts.failed).not.toHaveBeenCalled()

    updater.checkForUpdates.mockRejectedValueOnce(
      new Error('Could not get code signature for running application'),
    )
    await expect(controller.check('menu')).resolves.toMatchObject({ errorKind: 'unsigned' })
    expect(fallbackToReleasePage).toHaveBeenCalledTimes(2)
  })

  it('shows offline failures from the menu only; the launch check stays quiet', async () => {
    const { updater, controller, prompts, fallbackToReleasePage, events } = harness()
    updater.checkForUpdates.mockRejectedValue(
      Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' }),
    )
    await expect(controller.check('launch')).resolves.toMatchObject({ errorKind: 'offline' })
    expect(prompts.failed).not.toHaveBeenCalled()
    expect(fallbackToReleasePage).not.toHaveBeenCalled()
    expect(events.at(-1)).toMatchObject({ phase: 'error', kind: 'offline' })

    await controller.check('menu')
    expect(prompts.failed).toHaveBeenCalledWith('offline', 'getaddrinfo ENOTFOUND github.com')
  })

  it('surfaces a failed download and a Squirrel error raised after the download resolved', async () => {
    const { updater, controller, prompts, fallbackToReleasePage } = harness()
    ;(prompts.available as ReturnType<typeof vi.fn>).mockResolvedValue('download')
    updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.8.0' },
    })

    updater.downloadUpdate.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
    await expect(controller.check('launch')).resolves.toMatchObject({
      kind: 'failed',
      errorKind: 'offline',
      stage: 'download',
    })
    expect(prompts.failed).toHaveBeenCalledWith('offline', 'net::ERR_CONNECTION_RESET')
    expect(controller.downloadedVersion()).toBeNull()

    updater.downloadUpdate.mockImplementationOnce(async () => {
      updater.emit('error', new Error('Could not get code signature for running application'))
      return []
    })
    await expect(controller.check('launch')).resolves.toMatchObject({
      kind: 'failed',
      errorKind: 'unsigned',
      stage: 'download',
    })
    expect(fallbackToReleasePage).toHaveBeenCalledTimes(1)
    expect(prompts.downloaded).not.toHaveBeenCalled()
  })
})
