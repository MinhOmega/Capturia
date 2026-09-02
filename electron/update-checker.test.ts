import { describe, expect, it, vi } from 'vitest'
import { checkLatestRelease, compareVersions, LATEST_RELEASE_API } from './update-checker'

const RELEASE_PAGE = 'https://github.com/MinhOmega/Capturia/releases/tag'

function releaseResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(payload),
  }
}

describe('compareVersions', () => {
  it('implements semantic version ordering for stable and prerelease builds', () => {
    expect(compareVersions('v2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.9.0', '1.9.0-rc.2')).toBeGreaterThan(0)
    expect(compareVersions('1.9.0-rc.10', '1.9.0-rc.2')).toBeGreaterThan(0)
    expect(compareVersions('1.9.0+build.2', 'v1.9.0+build.1')).toBe(0)
  })

  it('preserves precision for oversized core identifiers', () => {
    expect(compareVersions('9007199254740993.0.0', '9007199254740992.0.0')).toBeGreaterThan(0)
  })

  it.each(['01.0.0', '1.02.0', '1.0.03', '1.0.0-rc.01'])('rejects leading-zero numeric identifiers in %s', (version) => {
    expect(() => compareVersions(version, '1.0.0')).toThrow('invalid semantic version')
  })
})

describe('checkLatestRelease', () => {
  it('points at the Capturia repository', () => {
    expect(LATEST_RELEASE_API).toBe('https://api.github.com/repos/MinhOmega/Capturia/releases/latest')
  })

  it('reports a newer official stable release', async () => {
    const fetchLatest = vi.fn().mockResolvedValue(
      releaseResponse({
        tag_name: 'v1.6.0',
        html_url: `${RELEASE_PAGE}/v1.6.0`,
        draft: false,
        prerelease: false,
      }),
    )

    await expect(checkLatestRelease({ currentVersion: '1.5.4', fetchLatest })).resolves.toEqual({
      kind: 'available',
      currentVersion: '1.5.4',
      latestVersion: '1.6.0',
      releaseUrl: `${RELEASE_PAGE}/v1.6.0`,
    })
    expect(fetchLatest).toHaveBeenCalledWith(
      LATEST_RELEASE_API,
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/vnd.github+json' }),
      }),
    )
  })

  it('reports current when the installed version is equal or newer', async () => {
    const fetchLatest = vi.fn().mockResolvedValue(
      releaseResponse({
        tag_name: 'v1.5.4',
        html_url: `${RELEASE_PAGE}/v1.5.4`,
        draft: false,
        prerelease: false,
      }),
    )

    await expect(checkLatestRelease({ currentVersion: '1.5.5', fetchLatest })).resolves.toEqual({
      kind: 'current',
      currentVersion: '1.5.5',
      latestVersion: '1.5.4',
    })
    await expect(checkLatestRelease({ currentVersion: '1.5.4', fetchLatest })).resolves.toEqual({
      kind: 'current',
      currentVersion: '1.5.4',
      latestVersion: '1.5.4',
    })
  })

  it('forwards the cancellation signal', async () => {
    const fetchLatest = vi.fn().mockResolvedValue(
      releaseResponse({
        tag_name: 'v1.5.4',
        html_url: `${RELEASE_PAGE}/v1.5.4`,
        draft: false,
        prerelease: false,
      }),
    )
    const controller = new AbortController()

    await checkLatestRelease({ currentVersion: '1.5.4', fetchLatest, signal: controller.signal })

    expect(fetchLatest).toHaveBeenCalledWith(LATEST_RELEASE_API, expect.objectContaining({ signal: controller.signal }))
  })

  it.each([
    { draft: true, prerelease: false },
    { draft: false, prerelease: true },
  ])('rejects draft and prerelease payloads: %o', async ({ draft, prerelease }) => {
    const fetchLatest = vi.fn().mockResolvedValue(
      releaseResponse({
        tag_name: 'v2.0.0',
        html_url: `${RELEASE_PAGE}/v2.0.0`,
        draft,
        prerelease,
      }),
    )

    await expect(checkLatestRelease({ currentVersion: '1.5.4', fetchLatest })).rejects.toThrow(
      'invalid GitHub release response',
    )
  })

  it('rejects a release URL outside the official repository', async () => {
    const fetchLatest = vi.fn().mockResolvedValue(
      releaseResponse({
        tag_name: 'v9.9.9',
        html_url: 'https://example.com/capturia-9.9.9.exe',
        draft: false,
        prerelease: false,
      }),
    )

    await expect(checkLatestRelease({ currentVersion: '1.5.4', fetchLatest })).rejects.toThrow('untrusted release URL')
  })

  it.each([
    'https://github.com/MinhOmega/Capturia/releases/download/v9.9.9/app.zip',
    'https://github.com/getopenscreen/openscreen/releases/tag/v9.9.9',
    `${RELEASE_PAGE}/v9.9.8`,
    `${RELEASE_PAGE}/v9.9.9?download=1`,
    `${RELEASE_PAGE}/v9.9.9#notes`,
    'http://github.com/MinhOmega/Capturia/releases/tag/v9.9.9',
  ])('rejects an invalid official-repository URL: %s', async (htmlUrl) => {
    const fetchLatest = vi.fn().mockResolvedValue(
      releaseResponse({
        tag_name: 'v9.9.9',
        html_url: htmlUrl,
        draft: false,
        prerelease: false,
      }),
    )

    await expect(checkLatestRelease({ currentVersion: '1.5.4', fetchLatest })).rejects.toThrow('untrusted release URL')
  })

  it('rejects unsuccessful or malformed GitHub responses', async () => {
    const unavailable = vi.fn().mockResolvedValue(releaseResponse({}, 503))
    await expect(checkLatestRelease({ currentVersion: '1.5.4', fetchLatest: unavailable })).rejects.toThrow(
      'GitHub release check failed (503)',
    )

    const malformed = vi.fn().mockResolvedValue(releaseResponse({ tag_name: 'v2.0.0' }))
    await expect(checkLatestRelease({ currentVersion: '1.5.4', fetchLatest: malformed })).rejects.toThrow(
      'invalid GitHub release response',
    )
  })
})
