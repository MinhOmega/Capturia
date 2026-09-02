import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const getPath = vi.fn((name: string) => `/fake/${name}`)
vi.mock('electron', () => ({ app: { getPath: (name: string) => getPath(name) } }))

describe('electron/paths', () => {
  it('does not touch app at import time', async () => {
    await import('./paths')
    expect(getPath).not.toHaveBeenCalled()
  })

  it('resolves the recordings and projects dirs under userData on demand', async () => {
    const { getRecordingsDir, getProjectsDir, getUserDataDir } = await import('./paths')
    expect(getRecordingsDir()).toBe(path.join('/fake/userData', 'recordings'))
    expect(getProjectsDir()).toBe(path.join('/fake/userData', 'projects'))
    expect(getUserDataDir()).toBe('/fake/userData')
    expect(getPath).toHaveBeenCalledWith('userData')
  })

  it('exposes the pure form used by tests', async () => {
    const { resolveRecordingsDir } = await import('./paths')
    expect(resolveRecordingsDir('/data')).toBe(path.join('/data', 'recordings'))
  })
})
