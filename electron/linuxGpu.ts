/**
 * Whether this Linux session needs Capturia's software-rendering workaround.
 *
 * Electron 39 can hard-crash during startup on some Ubuntu Wayland GPU stacks,
 * so Capturia disables hardware acceleration there. It is a Wayland-only
 * problem: on X11 the GPU path works and switching it off costs a visibly
 * slower preview and export.
 *
 * The decision is made at runtime from the session environment rather than
 * baked into the packaged launcher, because a single build is installed on both
 * session types and the launcher cannot tell them apart. Pure so the packaging
 * question ("what does this decide when the environment looks like *that*?")
 * can be answered by a test instead of by a reinstall.
 */

/** The environment slice the decision reads. */
export type SessionEnv = Pick<NodeJS.ProcessEnv, string> | Record<string, string | undefined>

/**
 * `XDG_SESSION_TYPE` is what a desktop session exports and what a `.desktop`
 * launch inherits, so it is the primary signal. `WAYLAND_DISPLAY` is the
 * fallback: it is set by the compositor itself, and it survives launch contexts
 * that drop the session type (some AppImage and sandbox launchers do). Treating
 * "compositor socket present" as Wayland can only ever turn the workaround
 * *on*, never off, so a missing session type degrades to the safe answer.
 */
export function isLinuxWaylandSession(
  env: SessionEnv = process.env,
  platform: string = process.platform,
): boolean {
  if (platform !== 'linux') return false
  const sessionType = String(env['XDG_SESSION_TYPE'] ?? '')
    .trim()
    .toLowerCase()
  if (sessionType === 'wayland') return true
  if (sessionType === 'x11' || sessionType === 'tty') return false
  return String(env['WAYLAND_DISPLAY'] ?? '').trim().length > 0
}

/**
 * `true` when `--disable-gpu` / `--disable-gpu-compositing` must be applied.
 * Identical to `isLinuxWaylandSession` today; kept separate so a future
 * driver-specific exception has one place to live.
 */
export function shouldDisableLinuxGpu(
  env: SessionEnv = process.env,
  platform: string = process.platform,
): boolean {
  return isLinuxWaylandSession(env, platform)
}
