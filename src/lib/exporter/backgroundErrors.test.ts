import { describe, expect, it } from 'vitest'
import { BackgroundLoadError, isBackgroundLoadError } from './backgroundErrors'

describe('BackgroundLoadError', () => {
  it('only exposes the basename of a file URL in the message', () => {
    const error = new BackgroundLoadError(
      'file:///Users/me/Library/Application%20Support/app/wallpapers/wallpaper3.jpg',
    )
    expect(error.message).toBe('Failed to load background image: wallpaper3.jpg')
    expect(error.displayUrl).toBe('wallpaper3.jpg')
    expect(error.name).toBe('BackgroundLoadError')
  })

  it('never dumps a data URL into the message', () => {
    const error = new BackgroundLoadError('data:image/png;base64,AAAA')
    expect(error.displayUrl).toBe('data:…')
  })

  it('labels a gradient that failed to parse', () => {
    const error = new BackgroundLoadError('linear-gradient(broken')
    expect(error.displayUrl).toBe('gradient')
  })

  it('keeps the original cause and the full url for diagnostics', () => {
    const cause = new Error('boom')
    const error = new BackgroundLoadError('/wallpapers/wallpaper1.jpg', cause)
    expect(error.url).toBe('/wallpapers/wallpaper1.jpg')
    expect(error.cause).toBe(cause)
    expect(error.displayUrl).toBe('wallpaper1.jpg')
  })

  it('is detected by isBackgroundLoadError', () => {
    expect(isBackgroundLoadError(new BackgroundLoadError('x'))).toBe(true)
    expect(isBackgroundLoadError(new Error('x'))).toBe(false)
    expect(isBackgroundLoadError('x')).toBe(false)
  })
})
