# Batch note — W5 A24 + A25b: HUD click-through, drag, content-fit, vertical tray

Five commits on the batch branch, in order: pure helpers + preference, main-process IPC,
`main.ts` wiring (two lines, kept separate so it can be re-applied at merge), launch window,
docs.

## What changed

- **`src/hooks/useHudLayout.ts`** (new, React-free so main can import it): `clampToWorkArea`,
  `clampSizeToWorkArea`, `anchorPreservingResize` (bottom-centre anchor), `hudAnchorOf` /
  `boundsFromHudAnchor` (placement memory), `translateBounds`, `pointInHudRects`,
  `sanitizeHudRects`, `measureHudWindowSize` (content-fit from the viewport's bottom-centre, so
  the result does not depend on the window's current size), `isHudInteractiveTarget` +
  `HUD_INTERACTIVE_SELECTOR`, orientation helpers. 36 tests.
- **`src/lib/userPreferences.ts`**: `hudOrientation: 'horizontal' | 'vertical'` (default
  horizontal, validated on load).
- **`electron/ipc/hudWindowsHandlers.ts`**: three `ipcMain.handle` channels, each refusing any
  sender other than the HUD window's `webContents` (`{ applied: false, reason }`):
  - `hud-overlay-ignore-mouse-events(ignore, rects)` — macOS: `setIgnoreMouseEvents(true,
    { forward: true })`; Linux X11 / Windows: plain ignore plus an 80 ms cursor poll against the
    renderer's boxes that re-enables input when the cursor enters one (and refuses to ignore
    with no boxes, so the window can never be stranded); Wayland: never.
  - `hud-overlay-move-by(dx, dy)` — clamped to the work area of the display under the cursor so
    a drag can cross displays but never leave a screen; Wayland: refused (renderer falls back to
    the native drag region).
  - `hud-overlay-set-size(w, h)` — anchor-preserving resize clamped to the work area; ignored
    while a countdown run is active; Wayland: refused.
- **`electron/windows.ts`**: `getHudOverlayWindow()`, transparent backing + `roundedCorners:
  false`, loose min size (120×80) instead of the fixed 2200×~400 constraints, and
  `userData/hud-overlay-placement.json` (anchor + size, debounced 300 ms on `move`/`resize`,
  ignored when no display contains the anchor). First launch keeps the old wide reserve until
  the renderer reports its size.
- **`LaunchWindow.tsx`**: window-level pointer tracking (`data-hud-interactive` bar, Radix
  popper wrappers, `role=dialog|menu`), popovers keep input on while open, JS drag handle with
  pointer capture and one batched delta per frame, ResizeObserver (bar) + MutationObserver
  (portal popovers) → `setHudOverlaySize`, orientation toggle in the bar header with
  `data-hud-orientation` on the bar. Compact recording bar uses the same handle. 4 tests.
- Preload + both `.d.ts`: `setHudOverlayIgnoreMouseEvents`, `moveHudOverlayBy`,
  `setHudOverlaySize`. `handlers.test.ts` channel pin extended. i18n `launch.dragHandle`,
  `launch.tray.useVertical/useHorizontal` in en/zh-CN/vi.

## Gate (batch branch)

lint 0 errors / 116 warnings; `tsc` + `typecheck:test` clean; i18n 626 en keys; vitest
**120 files / 1269 tests** (from 118 / 1228); `biome format .` clean.

## Not verified here

No display on the lead box, so nothing below ran in a live Electron. The unit tests cover the
handlers with a fake window and the renderer with jsdom (no layout: boxes are stubbed).

## Manual smoke (macOS + Linux X11 + Linux Wayland)

1. Launch: HUD appears at the bottom-centre of the primary display, window shrinks to the bar
   within a frame (no visible jump); no grey/rounded panel behind the bar on macOS.
2. Click-through: click the desktop / another app just above the bar and to its sides — the
   click lands underneath (macOS, X11). Move back over the bar: buttons respond at once
   (macOS) or within ~100 ms (X11 poll). Wayland: the HUD stays fully interactive (expected).
3. Drag: grab the grip, drag across the screen and onto a second display; the bar never
   leaves a screen. Release, quit, relaunch: the bar comes back where it was left. Wayland:
   the grip drags through the native drag region instead.
4. Popovers: open the mic settings, capture settings, stop-shortcut and camera-shape
   popovers; each is fully visible and clickable (window grew around it), and clicking outside
   closes it. Close it: the window shrinks back.
5. Vertical tray: toggle in the bar header; every control stacks full-width, popovers open to
   the side, the window follows; toggle back; relaunch keeps the last choice.
6. Recording: start with a 3 s countdown — the countdown overlay is unaffected and the window
   does not resize until the compact bar replaces the idle bar; drag the compact bar; stop —
   the idle bar returns at the same anchor. Auto-hide on record still minimises/restores.
7. Notes button (macOS) and the permission checker still open from both layouts.
8. Multi-display: unplug the display the HUD was on, relaunch — it falls back to the primary.

## Lead verification (merged as `9a9142a`)

- Checked: all three HUD channels reject a sender that is not the HUD `webContents`; no
  reference to the source project in code or commit messages; `main.ts` wiring isolated in its
  own commit as agreed.
- Gate on merged tree: lint 0 errors / 116 warnings; tsc + test types clean; i18n 626 en keys;
  `biome format .` clean; vitest **120 files / 1269 tests**.
- Unverified here: everything that needs a display (see the manual smoke list above).
