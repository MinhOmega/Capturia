import { describe, expect, it } from 'vitest'
import { isLinuxWaylandSession, shouldDisableLinuxGpu } from './linuxGpu'

/**
 * The packaged Linux launcher no longer passes `--disable-gpu`, so this gate is
 * the only thing standing between an Ubuntu Wayland install and the Electron
 * startup crash — and the only thing standing between an X11 install and
 * software rendering it does not need.
 */
describe('isLinuxWaylandSession', () => {
  it('is false off Linux whatever the environment says', () => {
    const wayland = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' }
    expect(isLinuxWaylandSession(wayland, 'darwin')).toBe(false)
    expect(isLinuxWaylandSession(wayland, 'win32')).toBe(false)
  })

  it('is true for a Wayland session type', () => {
    expect(isLinuxWaylandSession({ XDG_SESSION_TYPE: 'wayland' }, 'linux')).toBe(true)
  })

  it('accepts the session type in any casing or with stray whitespace', () => {
    expect(isLinuxWaylandSession({ XDG_SESSION_TYPE: 'Wayland' }, 'linux')).toBe(true)
    expect(isLinuxWaylandSession({ XDG_SESSION_TYPE: ' WAYLAND ' }, 'linux')).toBe(true)
  })

  it('is false on X11, which is where the GPU path works', () => {
    expect(isLinuxWaylandSession({ XDG_SESSION_TYPE: 'x11' }, 'linux')).toBe(false)
    // An X11 session that happens to advertise a compositor socket is still X11:
    // the explicit session type wins over the fallback.
    expect(
      isLinuxWaylandSession({ XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' }, 'linux'),
    ).toBe(false)
  })

  it('falls back to the compositor socket when the session type is missing', () => {
    // Some packaged launch contexts (AppImage, portals, sandboxes) do not
    // forward XDG_SESSION_TYPE; the safe answer there is "Wayland".
    expect(isLinuxWaylandSession({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(true)
    expect(
      isLinuxWaylandSession({ XDG_SESSION_TYPE: '', WAYLAND_DISPLAY: 'wayland-1' }, 'linux'),
    ).toBe(true)
  })

  it('is false when neither signal is present', () => {
    expect(isLinuxWaylandSession({}, 'linux')).toBe(false)
    expect(isLinuxWaylandSession({ WAYLAND_DISPLAY: '' }, 'linux')).toBe(false)
    expect(isLinuxWaylandSession({ XDG_SESSION_TYPE: 'tty' }, 'linux')).toBe(false)
  })
})

describe('shouldDisableLinuxGpu', () => {
  it('disables the GPU exactly for the Wayland sessions', () => {
    expect(shouldDisableLinuxGpu({ XDG_SESSION_TYPE: 'wayland' }, 'linux')).toBe(true)
    expect(shouldDisableLinuxGpu({ XDG_SESSION_TYPE: 'x11' }, 'linux')).toBe(false)
    expect(shouldDisableLinuxGpu({ XDG_SESSION_TYPE: 'wayland' }, 'darwin')).toBe(false)
  })
})
