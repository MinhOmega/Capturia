# R5-A1 — browser-path system audio, camera resilience, HUD popover leftovers

Four commits on `feat/upstream-sync-v1.7`. Branch: `worktree-agent-a88643c81af513e35`.

| Commit | Item |
|---|---|
| `ff05c01` | camera disconnect resilience + native camera orientation |
| `61de78e` | R5-A1 system audio on the browser recording path |
| `3aca058` | A-5 HUD popovers close on window blur |
| `deedc23` | A-14 stop shortcut read from main on mount |

## R5-A1 — system audio without the native helper

`src/lib/audioMix.ts` is a new pure mix-graph builder over a minimal `AudioContext`
surface, so it is testable without Web Audio. Microphone feeds a gain node (ramped
from 0 to the user gain over 20 ms, which kills the click at recording start),
system audio feeds a unity gain node, both hit one soft limiter into a
`MediaStreamDestination`. Two shortcuts avoid building a graph at all: a lone
system track passes through verbatim, and a runtime with no Web Audio records the
raw tracks. `normalizeMicrophoneGain` moved here from the recorder hook.

`useScreenRecorder` takes `systemAudioEnabled`. Desktop capture asks for audio on
both request shapes (`getDisplayMedia({ audio })` and the legacy
`chromeMediaSource: 'desktop'` constraint) and retries video-only when the audio
request is refused, so a rejected request never costs the recording. A missing
audio track surfaces `editor.recordingSystemAudioUnavailable` and recording
continues. The mixed stream feeds both the plain and the camera-composited
recorders; the streamed-to-disk handle and pause/resume are untouched.
`hasMicrophoneAudio`, which the editor reads as "this file has an audio track", is
now true when either input is present.

### Platform matrix

| Platform | Where system audio comes from | Toggle visible |
|---|---|---|
| Windows | Chromium loopback, granted by the display-media handler when `request.audioRequested` | yes |
| Linux | renderer's legacy desktop-audio constraint (PulseAudio/PipeWire monitor) | yes |
| macOS | native helper only; the browser path gets none | only once the helper reports `canCaptureSystemAudio` |

macOS also gets a Chromium switch: `disable-features=MacCatapLoopbackAudioForScreenShare`.
Without it a `getDisplayMedia({ audio: true })` request goes through the CoreAudio
tap API, which needs an audio-capture usage string in the *host* process Info.plist.
That string is absent when the app is run from a terminal or an IDE in development,
and the renderer crashes outright.

The native start result is read defensively: `canCaptureSystemAudio` is optional,
remembered in `capturia.nativeSystemAudioSupported`, and exposed as
`nativeSystemAudioSupported`. `hasSystemAudio` and `warnings` from the same result
are not consumed yet.

## Camera resilience

The overlay listens for the webcam track's `ended` event. Unplugging the camera
mid-recording drops the overlay, so the canvas keeps drawing the plain desktop
instead of freezing on the last camera frame, warns once through
`editor.recordingCameraDisconnected`, and the recording continues. Camera
constraints no longer ask for an ideal 1280x720, so the driver's native
orientation survives: portrait cameras are centre-cropped into the overlay box
rather than rotated.

## A-5 — popovers close on window blur

The HUD is a small bar on a mostly transparent, click-through window. A click
anywhere else on screen never reaches this renderer as a pointerdown, so a
popover's own outside-click dismissal cannot fire, and once focus has gone Escape
is undeliverable here too. A stale device picker therefore sat on top of the bar
and blocked the controls underneath it.

The capture-settings and camera-shape popovers became controlled (microphone and
stop-shortcut already were) and all four close from one window `blur` listener,
which also leaves the stop-shortcut capture mode. The listener sits on the window
in bubble phase and element blur does not bubble, so moving focus between controls
inside an open popover does not dismiss it. That distinction has its own test.

## A-14 — stop shortcut from main

The HUD trusted its own `localStorage` copy and pushed it into main on every
mount, so a shortcut changed anywhere else was silently overwritten by a stale HUD
value. It now asks main for the accelerator actually registered and adopts it,
mirroring it back into `localStorage`. Only when main reports nothing registered
does the persisted value get pushed through as before, which keeps first run and
an older main working. The call goes through optional chaining and a try/catch.

## Gate

Run in the worktree on `deedc23`.

| Gate | Result |
|---|---|
| `npm run lint` | 0 errors, 116 warnings (unchanged; the 2 on `LaunchWindow.tsx` predate the branch) |
| `npx tsc --noEmit` | clean |
| `npm run typecheck:test` | clean |
| `npm run i18n:check` | PASSED, 640 en keys, zh-CN and vi in parity |
| `npx biome format .` | clean, 358 files |
| `npx vitest --run` | 124 files / 1370 tests passed |

`LaunchWindow.test.tsx` alone is 22 tests, 8 of them new here.

## Unverified

- No live Electron run anywhere in this batch: no display on the box. Loopback
  audio on Windows, the PulseAudio/PipeWire monitor on Linux and the macOS switch
  are all argued from the API contract, not observed.
- The `blur` dismissal is exercised in jsdom only. Whether a real Electron HUD
  emits window `blur` on every desktop click that lands outside it, including on
  a click-through region of its own window, is untested.
- Physically unplugging a camera mid-recording was not tried; the test drives the
  track's `ended` event directly.
- `hasSystemAudio` and `warnings` from the native start result, and the toast keys
  `launch.microphoneDeviceNotFound` / `launch.systemAudioUnavailable` that arrived
  with the native batch, have no consumer on this branch.
