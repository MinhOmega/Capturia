import { describe, expect, it, vi } from 'vitest'
import { demuxMonoPcm, type MonoPcmExtractor } from './extractMono16k'
import type { DecodedMonoPcm } from './extractMono16kWebDemuxer'

const file = new File([new Uint8Array(4)], 'clip.webm')

function pcm(tag: number): DecodedMonoPcm {
  return { mono: new Float32Array([tag]), sampleRate: 48_000, durationSec: 1, capped: false }
}

describe('demuxMonoPcm fallback chain', () => {
  it('returns the web-demuxer result without touching mediabunny', async () => {
    const primary = vi.fn<MonoPcmExtractor>(async () => pcm(1))
    const secondary = vi.fn<MonoPcmExtractor>(async () => pcm(2))

    const result = await demuxMonoPcm(file, undefined, 30, { primary, secondary })

    expect(result.mono[0]).toBe(1)
    expect(primary).toHaveBeenCalledWith(file, undefined, 30)
    expect(secondary).not.toHaveBeenCalled()
  })

  it('falls back to mediabunny when the web-demuxer path fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const primary = vi.fn<MonoPcmExtractor>(async () => {
      throw new Error('Audio codec not supported for captions: pcm_s16le')
    })
    const secondary = vi.fn<MonoPcmExtractor>(async () => pcm(2))
    const signal = new AbortController().signal

    const result = await demuxMonoPcm(file, signal, undefined, { primary, secondary })

    expect(result.mono[0]).toBe(2)
    expect(secondary).toHaveBeenCalledWith(file, signal, undefined)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reports the mediabunny error when both paths fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const primary = vi.fn<MonoPcmExtractor>(async () => {
      throw new Error('web-demuxer failed')
    })
    const secondary = vi.fn<MonoPcmExtractor>(async () => {
      throw new Error('No audio track found in this video.')
    })

    await expect(demuxMonoPcm(file, undefined, undefined, { primary, secondary })).rejects.toThrow(
      'No audio track found in this video.',
    )
    warn.mockRestore()
  })

  it('stops the chain on abort instead of trying the second demuxer', async () => {
    const controller = new AbortController()
    const primary = vi.fn<MonoPcmExtractor>(async () => {
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    })
    const secondary = vi.fn<MonoPcmExtractor>(async () => pcm(2))

    await expect(
      demuxMonoPcm(file, controller.signal, undefined, { primary, secondary }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(secondary).not.toHaveBeenCalled()
  })
})
