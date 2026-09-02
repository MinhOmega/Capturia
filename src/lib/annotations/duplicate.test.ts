import { describe, expect, it } from 'vitest'
import type { AnnotationRegion } from '@/components/video-editor/types'
import { DEFAULT_ANNOTATION_STYLE, DEFAULT_BLUR_DATA } from '@/components/video-editor/types'
import { DUPLICATE_ANNOTATION_OFFSET_PERCENT, duplicateAnnotationRegion } from './duplicate'

function annotation(overrides: Partial<AnnotationRegion> = {}): AnnotationRegion {
  return {
    id: 'annotation-1',
    startMs: 1000,
    endMs: 4000,
    type: 'text',
    content: 'Hello',
    textContent: 'Hello',
    position: { x: 20, y: 30 },
    size: { width: 30, height: 20 },
    style: { ...DEFAULT_ANNOTATION_STYLE, color: '#ff0000' },
    zIndex: 3,
    ...overrides,
  }
}

describe('duplicateAnnotationRegion', () => {
  it('copies the annotation under the new id and z-index with a small offset', () => {
    const source = annotation()
    const copy = duplicateAnnotationRegion(source, { id: 'annotation-9', zIndex: 7 })

    expect(copy.id).toBe('annotation-9')
    expect(copy.zIndex).toBe(7)
    expect(copy.position).toEqual({
      x: 20 + DUPLICATE_ANNOTATION_OFFSET_PERCENT,
      y: 30 + DUPLICATE_ANNOTATION_OFFSET_PERCENT,
    })
    expect(copy.startMs).toBe(source.startMs)
    expect(copy.endMs).toBe(source.endMs)
    expect(copy.content).toBe('Hello')
    expect(copy.textContent).toBe('Hello')
    expect(copy.style).toEqual(source.style)
  })

  it('does not share nested objects with the source', () => {
    const source = annotation({
      type: 'figure',
      figureData: { arrowDirection: 'up', color: '#00ff00', strokeWidth: 3 },
    })
    const copy = duplicateAnnotationRegion(source, { id: 'annotation-2', zIndex: 4 })

    expect(copy.figureData).toEqual(source.figureData)
    expect(copy.figureData).not.toBe(source.figureData)
    expect(copy.style).not.toBe(source.style)
    expect(copy.size).not.toBe(source.size)
    expect(copy.position).not.toBe(source.position)
  })

  it('keeps the duplicate inside the frame when the source touches the edge', () => {
    const source = annotation({ position: { x: 70, y: 80 }, size: { width: 30, height: 20 } })
    const copy = duplicateAnnotationRegion(source, { id: 'annotation-2', zIndex: 4 })
    expect(copy.position).toEqual({ x: 70, y: 80 })
  })

  it('leaves figureData undefined for non-figure annotations', () => {
    const copy = duplicateAnnotationRegion(annotation(), { id: 'annotation-2', zIndex: 4 })
    expect(copy.figureData).toBeUndefined()
    expect(copy.blurData).toBeUndefined()
  })

  it('deep-copies blurData for blur regions', () => {
    const source = annotation({
      type: 'blur',
      content: '',
      blurData: { ...DEFAULT_BLUR_DATA, shape: 'oval', blockSize: 20 },
    })
    const copy = duplicateAnnotationRegion(source, { id: 'blur-2', zIndex: 4 })
    expect(copy.type).toBe('blur')
    expect(copy.blurData).toEqual(source.blurData)
    expect(copy.blurData).not.toBe(source.blurData)
  })
})
