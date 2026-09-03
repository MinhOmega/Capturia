import { describe, expect, it } from 'vitest'
import {
  CAPTURE_PERMISSIONS,
  type CapturiaWindowType,
  isPermissionAllowed,
  rememberWindowType,
  windowTypeForContents,
} from './windowPermissions'

const NON_CAPTURE_WINDOWS: readonly CapturiaWindowType[] = [
  'editor',
  'source-selector',
  'countdown-overlay',
  'permission-checker',
  'notes',
]

describe('isPermissionAllowed', () => {
  it('gives the recorder HUD every capture permission it needs', () => {
    for (const permission of CAPTURE_PERMISSIONS) {
      expect(
        isPermissionAllowed({ permission, windowType: 'hud-overlay', isMainFrame: true }),
      ).toBe(true)
    }
  })

  it('refuses capture to every window that only plays back', () => {
    for (const windowType of NON_CAPTURE_WINDOWS) {
      for (const permission of CAPTURE_PERMISSIONS) {
        expect(isPermissionAllowed({ permission, windowType, isMainFrame: true })).toBe(false)
      }
    }
  })

  it('keeps fullscreen for the editor preview', () => {
    expect(
      isPermissionAllowed({ permission: 'fullscreen', windowType: 'editor', isMainFrame: true }),
    ).toBe(true)
    expect(
      isPermissionAllowed({
        permission: 'fullscreen',
        windowType: 'hud-overlay',
        isMainFrame: true,
      }),
    ).toBe(true)
  })

  it('denies everything Capturia does not use', () => {
    const unused = [
      'notifications',
      'geolocation',
      'clipboard-read',
      'clipboard-sanitized-write',
      'midi',
      'midiSysex',
      'pointerLock',
      'openExternal',
      'idle-detection',
      'window-management',
      'usb',
      'hid',
      'serial',
      'storage-access',
      'unknown-future-permission',
    ]
    for (const permission of unused) {
      expect(
        isPermissionAllowed({ permission, windowType: 'hud-overlay', isMainFrame: true }),
      ).toBe(false)
      expect(isPermissionAllowed({ permission, windowType: 'editor', isMainFrame: true })).toBe(
        false,
      )
    }
  })

  it('never grants anything to a subframe', () => {
    expect(
      isPermissionAllowed({ permission: 'media', windowType: 'hud-overlay', isMainFrame: false }),
    ).toBe(false)
    expect(
      isPermissionAllowed({ permission: 'fullscreen', windowType: 'editor', isMainFrame: false }),
    ).toBe(false)
  })

  it('never grants anything to a WebContents Capturia did not create', () => {
    for (const permission of [...CAPTURE_PERMISSIONS, 'fullscreen']) {
      expect(isPermissionAllowed({ permission, windowType: null, isMainFrame: true })).toBe(false)
      expect(isPermissionAllowed({ permission, windowType: undefined, isMainFrame: true })).toBe(
        false,
      )
    }
  })
})

describe('windowTypeForContents', () => {
  it('reports what the main process created the window as', () => {
    const hud = {}
    const editor = {}
    rememberWindowType(hud, 'hud-overlay')
    rememberWindowType(editor, 'editor')

    expect(windowTypeForContents(hud)).toBe('hud-overlay')
    expect(windowTypeForContents(editor)).toBe('editor')
  })

  it('reports null for an unknown or missing WebContents', () => {
    expect(windowTypeForContents({})).toBeNull()
    expect(windowTypeForContents(null)).toBeNull()
    expect(windowTypeForContents(undefined)).toBeNull()
  })

  it('does not let one window inherit another window type', () => {
    const editor = {}
    rememberWindowType(editor, 'editor')

    expect(
      isPermissionAllowed({
        permission: 'display-capture',
        windowType: windowTypeForContents(editor),
        isMainFrame: true,
      }),
    ).toBe(false)
  })
})
