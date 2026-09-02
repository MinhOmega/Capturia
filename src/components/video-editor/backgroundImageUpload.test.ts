import { describe, expect, it } from 'vitest'
import { BACKGROUND_IMAGE_ACCEPT, isSupportedBackgroundImageType } from './backgroundImageUpload'

describe('background image upload validation', () => {
  it('accepts PNG images for custom backgrounds', () => {
    expect(isSupportedBackgroundImageType('image/png', '生成画像1.png')).toBe(true)
  })

  it('accepts JPEG images by MIME type regardless of case', () => {
    expect(isSupportedBackgroundImageType('image/jpeg', 'photo.jpg')).toBe(true)
    expect(isSupportedBackgroundImageType('IMAGE/JPG', 'photo.JPG')).toBe(true)
  })

  it('accepts PNG images by extension when the browser does not provide a MIME type', () => {
    expect(isSupportedBackgroundImageType('', '生成画像1.png')).toBe(true)
  })

  it('keeps rejecting non-image uploads', () => {
    expect(isSupportedBackgroundImageType('text/plain', 'notes.txt')).toBe(false)
  })

  it('does not allow extension fallback for explicit unsupported MIME types', () => {
    expect(isSupportedBackgroundImageType('text/plain', 'notes.png')).toBe(false)
  })

  it('exposes an accept attribute covering jpg and png', () => {
    expect(BACKGROUND_IMAGE_ACCEPT.split(',')).toEqual(
      expect.arrayContaining(['.jpg', '.jpeg', '.png', 'image/jpeg', 'image/png']),
    )
  })
})
