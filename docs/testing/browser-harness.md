# Browser harness

Runs the renderer in an ordinary Chrome tab instead of an Electron window, with
a fixture recording already loaded in the editor. It exists so a renderer change
can be looked at, clicked through and debugged in real DevTools **before**
anyone writes a Playwright spec for it — the slow, flaky part of this codebase's
end-to-end lane is booting Electron, and most renderer bugs do not need it.

It is not a replacement for `e2e/`. Anything that touches capture, the native
helper, the main process or the filesystem still needs the Electron specs.

## Starting it

```
systemd-run --user --scope -q -p MemoryMax=6G npm run dev:browser
```

The memory cap matters on this machine: an uncapped dev server compiling the
editor has been observed around 4 GB and the box OOMs under several at once.
Use `MemoryMax` only — never `MemoryHigh` (systemd-oomd reads it as a pressure
signal and elects the scope as the kill victim) and never `MemorySwapMax=0`
(the kernel then has nothing to reclaim on a brief overshoot). Check headroom
first with `free -g | sed -n 2p`; the sum of every cap must fit in *available*
memory, not total.

The server listens on port 5180 (`PORT=5199 npm run dev:browser` to move it).

| URL | What opens |
|---|---|
| `http://localhost:5180/?windowType=editor` | The editor, with the fixture recording loaded |
| `http://localhost:5180/?windowType=hud-overlay` | The launch / recorder HUD |
| `http://localhost:5180/?windowType=source-selector` | The capture source picker |
| `http://localhost:5180/?windowType=permission-checker` | The permission checker |
| `http://localhost:5180/?showNotes=true` | The notes window |
| `http://localhost:5180/dev-fixtures/sample.webm` | The fixture itself (range requests supported) |

These are the same `windowType` values the main process puts on each real
window, so a URL here and a window there are the same screen.

## How it works

`npm run dev:browser` (`scripts/dev-browser.mjs`) sets `VITE_BROWSER_HARNESS=1`
before Vite resolves its config, which changes two things, both dev-server only:

- `vite.config.ts` leaves the Electron plugin out — no app window is spawned and
  no preload is built, so nothing shadows the shim — and adds a middleware that
  serves `src/__fixtures__/sample.webm` (the fixture the export end-to-end spec
  uses) at `/dev-fixtures/sample.webm` with `Accept-Ranges`, which `<video>`
  seeking and the exporter's chunked reads both need.
- `src/main.tsx` sees the flag on `import.meta.env` and installs
  `src/dev/browserBridge.ts` as `window.electronAPI` before React mounts.

The shim implements every method `electron/preload.ts` exposes:

- **the current recording** is the fixture, handed over as an absolute
  `http://localhost:5180/...` URL. `VideoEditor.toFileUrl` passes an absolute
  URL through untouched, so the editor never rewrites it to `local-media://`
  and the usual cross-origin dance does not apply;
- **metadata** reports 320x240 at 15 fps with audio, plus a synthetic cursor
  track (a diagonal sweep with one click) so the cursor overlay and the
  auto-zoom wand have something to work on;
- **project state and shortcuts** are stored in `localStorage` under
  `capturia.browserHarness.*`, so a reload behaves like a second session;
- **file reads** (`readBinaryFile`, `readFileChunk`, `getReadableFileInfo`) are
  `fetch` calls against the dev server;
- **export writes** (`saveExportedVideo`) are captured in memory and offered as
  a browser download;
- **permissions** resolve as granted, `platform` is `linux`, `openExternalUrl`
  and `revealInFolder` log instead of acting.

Everything else — capture, the native recorder, cursor tracking,
transcription, the caption model cache, the updater, OS settings — logs a
console warning naming the method it could not honour and returns a benign
failure, so a gap shows up in the console instead of as a blank screen.

## Driving it from DevTools

The shim publishes a handle on `window.__capturiaBrowserHarness`:

```js
__capturiaBrowserHarness.fixtureUrl        // the recording the editor opened
__capturiaBrowserHarness.emit('menu-export')  // same push the application menu sends
__capturiaBrowserHarness.exports           // every saveExportedVideo call, with bytes
__capturiaBrowserHarness.autoDownload = false // stop offering exports as downloads
__capturiaBrowserHarness.reset()           // forget saved state and reload
```

`emit` accepts any channel a preload `on*` method subscribes to:
`menu-undo`, `menu-redo`, `menu-import-video`, `menu-export`,
`menu-return-to-recorder`, `menu-toggle-timeline`, `menu-toggle-settings`,
`menu-open-shortcuts`, `request-save-before-close`, `stop-recording-from-tray`,
`selected-source-changed`, `source-selector-closed`, `countdown-overlay-value`,
`notes-window-closed`, `update-progress`, `caption-model-progress`,
`native-recorder-exited`. The last one carries a payload:
`emit('native-recorder-exited', { code: null, signal: 'SIGKILL', reason: 'killed', outputPath: '/tmp/recording-1.mp4', outputPlayable: false })` walks the HUD
through a native helper that died mid-recording.

## Known limitations

- **No capture.** There is no screen, camera or microphone recording, and no
  native helper. Starting a recording from the HUD will not work.
- **No filesystem.** Exports never reach disk; they land in
  `__capturiaBrowserHarness.exports` and, unless `autoDownload` is off, in the
  browser's downloads. `openVideoFilePicker` cannot return a path, so importing
  another recording is not possible — point the editor elsewhere with
  `electronAPI.setCurrentVideoPath(url)` instead.
- **No transcription or captions.** Both the native transcriber and the caption
  model cache are main-process features.
- **One tab, not several windows.** `switchToEditor` / `switchToLaunch`
  navigate the tab; the source selector, notes and permission windows open as
  popups and need popups allowed.
- **No application menu, no global shortcuts.** Use
  `__capturiaBrowserHarness.emit('menu-…')` for the menu actions.
- **Chrome is not Electron.** Codec support, WebCodecs behaviour and GPU flags
  differ from the shipped Chromium. A preview or export that works here can
  still fail in the app; a failure here is worth checking in the app before
  filing it.

## Turning a DevTools check into a Playwright spec

The harness and `e2e/export.spec.ts` deliberately drive the editor the same
way, so a check that passed by hand transfers with little rewriting. Walk it in
this order:

1. **Name the observable.** Write down what you looked at — a `data-testid`, a
   visible string, a `<video>` reaching `readyState >= 2`. If you found the
   thing by eye, add a `data-testid` to the component first; assertions on class
   names or DOM shape rot.
2. **Check the fixture is enough.** The spec uses the same
   `src/__fixtures__/sample.webm`. If your check needed a longer recording,
   audio, or a specific frame rate, decide now whether to seed project state
   instead of adding a second fixture.
3. **Replace the shim with the seeding the spec already does.**
   `saveProjectState(videoPath, {...})` then `setCurrentVideoPath(videoPath)`
   then `reload()`, as in `e2e/export.spec.ts`. Anything you set through
   `localStorage` in the browser belongs in that project state, not in a
   test-only branch in the editor.
4. **Replace `__capturiaBrowserHarness.emit('menu-…')` with the real channel.**
   In an Electron spec that is
   `win.webContents.send('menu-export')` through `app.evaluate`.
5. **Replace the in-memory export sink with a real file.** Stub
   `dialog.showSaveDialog` in the main process (again, as `export.spec.ts`
   does) and assert on the bytes that land on disk.
6. **Budget the timeouts.** The e2e lane runs with software rendering and is
   far slower than your desktop Chrome. Copy the orders of magnitude from the
   existing specs rather than the numbers you measured by hand.
7. **Keep it out of the PR gate.** Electron specs run nightly
   (`.github/workflows/e2e.yml`); a unit or browser-mode vitest is the right
   home for anything that does not need a real app boot.

## Keeping the shim honest

`src/dev/browserBridge.test.ts` parses `electron/preload.ts` and fails if the
bridge grows or loses a method the shim does not mirror, and the shim is typed
as `Window['electronAPI']`, so a changed signature is a compile error. When you
add an IPC method, add it to the shim in the same change — implemented, or
listed in `UNIMPLEMENTED_BRIDGE_METHODS` with a warning that names it.

```
npx vitest --run src/dev
```
