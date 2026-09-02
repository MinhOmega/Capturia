import { describe, expect, it, vi } from 'vitest'
import type { AnnotationRegion } from '@/components/video-editor/types'
import { DEFAULT_ANNOTATION_STYLE } from '@/components/video-editor/types'
import { getAnnotationFontShorthand, preloadAnnotationFonts } from './annotationRenderer'

function annotation(overrides: Partial<AnnotationRegion> = {}): AnnotationRegion {
  return {
    id: 'annotation-1',
    startMs: 0,
    endMs: 1000,
    type: 'text',
    content: 'Hello',
    position: { x: 0, y: 0 },
    size: { width: 30, height: 20 },
    style: { ...DEFAULT_ANNOTATION_STYLE },
    zIndex: 1,
    ...overrides,
  }
}

describe('getAnnotationFontShorthand', () => {
  it('builds the same shorthand the canvas uses, scaled for export', () => {
    const style = {
      ...DEFAULT_ANNOTATION_STYLE,
      fontFamily: '"Fira Code", monospace',
      fontSize: 20,
      fontStyle: 'italic' as const,
    }
    expect(getAnnotationFontShorthand(style)).toBe('italic bold 20px "Fira Code", monospace')
    expect(getAnnotationFontShorthand(style, 2)).toBe('italic bold 40px "Fira Code", monospace')
  })
})

describe('preloadAnnotationFonts', () => {
  it('loads each distinct face used by text annotations once', async () => {
    const load = vi.fn().mockResolvedValue([])
    await preloadAnnotationFonts(
      [
        annotation({ id: 'a', style: { ...DEFAULT_ANNOTATION_STYLE, fontFamily: 'Inter' } }),
        annotation({ id: 'b', style: { ...DEFAULT_ANNOTATION_STYLE, fontFamily: 'Inter' } }),
        annotation({
          id: 'c',
          style: {
            ...DEFAULT_ANNOTATION_STYLE,
            fontFamily: 'Lora, Georgia, serif',
            fontWeight: 'normal',
          },
        }),
        annotation({ id: 'img', type: 'image', content: 'data:image/png;base64,AAA' }),
        annotation({ id: 'empty', content: '' }),
      ],
      { load },
    )
    expect(load).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenCalledWith('normal bold 32px Inter')
    expect(load).toHaveBeenCalledWith('normal normal 32px Lora, Georgia, serif')
  })

  it('does nothing without text annotations or without a FontFaceSet', async () => {
    const load = vi.fn().mockResolvedValue([])
    await preloadAnnotationFonts([annotation({ type: 'figure', content: '' })], { load })
    expect(load).not.toHaveBeenCalled()
    await expect(preloadAnnotationFonts([annotation()], undefined)).resolves.toBeUndefined()
  })

  it('swallows load failures so a missing font falls back instead of failing the export', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const load = vi.fn().mockRejectedValue(new Error('no such font'))
    await expect(preloadAnnotationFonts([annotation()], { load })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('gives up on a face that never resolves after the timeout', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const load = vi.fn().mockReturnValue(new Promise(() => undefined))
    const pending = preloadAnnotationFonts([annotation()], { load })
    await vi.advanceTimersByTimeAsync(5000)
    await expect(pending).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    vi.useRealTimers()
  })
})
