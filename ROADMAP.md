# Capturia Roadmap
The recorder you love, with an optional AI sidekick. Same sleek, low-friction recorder UX. An opt-in AI editing layer is on the way for users who want it — never required, never snuck in.

This roadmap is the source of truth for what we're shipping next in Capturia. It is a living document — items move between tiers as work lands. It is also published on the site at [minhvo.is-a.dev/Capturia/roadmap](https://minhvo.is-a.dev/Capturia/roadmap), rendered from this file. Have an idea, a vote, or a dissenting opinion? Open a GitHub issue with the `roadmap` label.

Capturia is a fork of [getopenscreen/openscreen](https://github.com/getopenscreen/openscreen), re-baselined onto upstream v1.10.0. Items below that came from upstream's tracker are linked as **upstream #N** and point at upstream's issues, not ours — the numbers are theirs, and renumbering them here would only break the trail back to the original report.

## 🧭 North Star
**Record → Edit → Export.** (with an optional AI shortcut for users who want one)

Capturia is, first and foremost, a polished screen recorder. Record, trim on the timeline, export. Most users will keep using exactly this workflow.

There is also an optional AI editing layer — for users who want to edit by talking or by editing a transcript. It's opt-in, off by default, and never required. If you don't enable it, the AI layer doesn't exist for your install: nothing downloads, nothing leaves your machine, no LLM is contacted.

Three axes guide every decision on this roadmap:

- **Stability first** — the recorder must work reliably on macOS, Windows, and Linux. Bugs found by real users ship before new features.
- **Sleek UX stays** — every AI feature must keep the Capturia feel: minimal clicks, instant feedback, no clutter.
- **100% free, forever** — no paywalls, no premium tier, no usage caps. Every feature on this page ships under MIT.

## 🤖 The optional AI Edition — shipped, off by default
A Screen Studio + Descript alternative, open-source and free forever. The recorder-first UX stays intact, and the AI layer sits beside it, off by default.

What ships today (each one opt-in, each one toggleable independently):

- [x] **Local Whisper transcription (on-device)** — whisper.cpp with the compute backend picked at runtime: Metal on Apple Silicon, Vulkan on Windows and Linux, CPU everywhere else. No upload, no cloud, works offline. It's the foundation every feature below stands on.
- [x] **Transcript-driven editing (local)** — edit video like a doc: select words, press `Delete`, the span is cut from playback and export. Silences are marked inline and trimmable the same way. Word boundaries are re-anchored on the audio so a cut lands where the word actually starts.
- [x] **Captions as a derived layer (local)** — cues are a live view of the transcript, not generated text you then maintain; restyle or regroup them with no regeneration step. Optional translation into 15 languages, stored beside the transcript and never in it.
- [x] **Edit by chat (requires BYO LLM key)** — describe an edit in plain language; the agent applies real, undoable timeline operations (trims, zooms, speed, annotations, clip ranges, reordering). Off until you connect a provider.
- [x] **Non-destructive project document (always on)** — `.capturia` projects keep every edit re-editable, and `Ctrl/Cmd + Z` covers agent edits exactly like manual ones. Projects saved by older builds under `.openscreen` or `.axcut` still open; they're migrated, never orphaned.
- [x] **Bring-your-own LLM (opt-in)** — Anthropic, OpenAI, Google, Mistral, OpenRouter, MiniMax, and any OpenAI-compatible endpoint. Keys live in your OS credential store via Electron `safeStorage`; requests go straight from your machine to the provider. We never see them, because there is no server to see them with.

Still open on this axis:

- [x] **One-click cleanup: silences and filler words** — Auto-enhance → *Remove dead air* cuts long pauses and hesitation sounds ("um", "uh", …) from the transcript's own word timings, on this device, with no provider involved. It runs as one undo step and does not stack a second cut on a pause that is already cut.
- [ ] **One-click cleanup: voice enhancement** — cleaning up the recorded voice itself isn't started.
- [ ] **Sanctioned ChatGPT / GitHub Copilot sign-in** — both were removed in 1.8.0: reaching a user's subscription meant shipping GitHub's and OpenAI's own client IDs and an editor `User-Agent` against endpoints reserved for first-party clients, from inside a signed installer. They come back on the vendors' sanctioned surfaces — GitHub's Copilot SDK (we register our own OAuth App) and `codex app-server` (drives the user's own `codex login`, no client ID shipped at all). Separate integrations, not a header swap.

## 🖥️ Rendering & platform parity
The live preview and MP4 export run on one native Rust compositor: demux → decode → composite → hardware encode → mux, GPU-resident, no CPU readback between stages. Both consume the same scene description, so the frame you see in the editor is the frame the export writes — there is no second renderer that can drift.

That engine ran on Direct3D 11 only until 1.8.0, which made this the largest gap on the roadmap. It now has three backends behind the same scene contract:

- [x] **MP4 export on macOS** — Metal render pipeline with VideoToolbox decode and encode, a CoreText text rasterizer, and audio muxed into the output. All nine shader entry points are ported to MSL, so annotations, the cursor and its trail, the 3D tilt zoom and the dual-Kawase blur all render there.
- [x] **MP4 export on Linux** — wgpu/WGSL pipeline with software H.264 encode, MP4 mux and AAC audio.
- [x] **Feature:** software fallback when no GPU encoder is available — [upstream #18](https://github.com/getopenscreen/openscreen/issues/18). A CPU backend (software render + decode) is selected automatically and surfaced in the UI, and reaches the export encoder like any other backend. Direct3D 11 now fails legibly rather than silently degrading to WARP.

Still open on this axis:

- [ ] **Hardware encode on Linux** — the export path is correct but software-encoded, so it is slower than the Windows and macOS ones. The capture helper already uses a hardware H.264 encoder; the export pipeline does not.
- [ ] **A discrete-GPU and Intel QSV measurement.** Every number in [rendering-performance.md](https://github.com/MinhOmega/Capturia/blob/main/technical-documentation/engineering/rendering-performance.md) comes from one passive-iGPU laptop, deliberately chosen as the weak case. Nothing is measured on the hardware most users have.

## 🛠️ Stability & quality (what we're actually shipping)
Pulled from real user bug reports on upstream's tracker, [getopenscreen/openscreen](https://github.com/getopenscreen/openscreen/issues). Capturia inherits the code these reports describe, so it inherits the bugs. This is the queue for the next release window.

- [ ] **Fix:** video disappears from editor after export — [upstream #8](https://github.com/getopenscreen/openscreen/issues/8) (Linux, Manjaro). Renderer regression after export.
- [ ] **Fix:** crash after stopping macOS recording — [upstream #21](https://github.com/getopenscreen/openscreen/issues/21) (macOS 26.4.1, Apple Silicon). Crash is in the Electron / Node async fs shutdown path; recording artifacts are written correctly.
- [ ] **Fix:** macOS cursor offset in single-window capture — [upstream #22](https://github.com/getopenscreen/openscreen/issues/22). Fix landed, awaiting Mac verification: the capture helper reports the captured window's frame, and the cursor is normalised against it instead of against the display.
- ~~**Fix:** recover preview from WebGL context loss on Linux / Wayland — [upstream #19](https://github.com/getopenscreen/openscreen/issues/19).~~ Retired: the preview no longer draws through WebGL (it shows the native compositor's frames in a 2D canvas), so there is no WebGL context left to lose.
- [x] **Feature:** copy / paste regions in the timeline — [upstream #24](https://github.com/getopenscreen/openscreen/issues/24). `Ctrl/Cmd + C` copies the selected region; `Ctrl/Cmd + V` pastes a new one with the same attributes and length at the playhead.
- [x] **Feature:** right-click context menu for the copy / paste above — [upstream #24](https://github.com/getopenscreen/openscreen/issues/24). Right-click a region pill for Copy, Paste at playhead and Delete, or a clip for Split at playhead; the Menu key and `Shift + F10` open it for the selected pill. Each entry runs the same action as its shortcut and shows that shortcut.
- [ ] **Feature:** apply copied attributes onto an existing region of the same kind — [upstream #24](https://github.com/getopenscreen/openscreen/issues/24). Not built: paste only ever creates a new region at the playhead. This line was previously ticked for behaviour that never shipped.
- [x] **Feature:** restore blur regions — [upstream #76](https://github.com/getopenscreen/openscreen/issues/76). Shipped as an annotation **type** rather than its own region kind: Gaussian or mosaic, rectangle or oval, composited natively in both preview and export. Freehand is deliberately not offered when creating one — its input was broken and the renderer only ever masked the bounding box, and a half-reliable privacy tool is worse than no tool, because people trust it. Existing freehand shapes still render as their bounding box, with the inspector saying so.

## 📚 Site & documentation
- [x] **Feature:** Docusaurus site — landing + docs, live at [minhvo.is-a.dev/Capturia](https://minhvo.is-a.dev/Capturia/), built from `website/` and deployed to GitHub Pages by `.github/workflows/docs.yml` on every push to `main`. Landing page plus a Features section covering recording, the media library, the timeline, captions, AI editing and export. MIT, no tracking, no paywall — same posture as the app.
  - [x] This roadmap, rendered on the site at [/roadmap](https://minhvo.is-a.dev/Capturia/roadmap) instead of bouncing visitors to a raw file on GitHub. The page imports this document at build time, so it is exactly as current as the last deploy — there is no second copy to keep in step.
  - [ ] Custom domain.
  - [ ] Versioning — still off until v2.
  - Engineering docs stay in `technical-documentation/` on purpose: they track the code rather than the product, are link-checked by `npm run docs:check`, and aren't user-facing.

## 📬 How to influence this roadmap
- **GitHub** — open an issue with the `enhancement` label, or react with 👍 / 👎 on existing items. This is the fastest way to get a thumbs-up or thumbs-down on a feature.
- **PRs** — if you want to ship one of these, open a PR and link the relevant issue. We review fast and help with native-bridge / i18n questions.

Anything not on this list yet? Open an issue and tag it `roadmap` — we'll triage it into a tier within a week.

---

## Changelog
Entries dated before 2026-09-10 are inherited from upstream's roadmap document and are kept as written: they record what upstream decided and when. Capturia's own entries start at 2026-09-10.

- **2026-06-24** — initial draft. Stability items pulled from open issues / PRs on getopenscreen/openscreen. AI section presented as opt-in / off by default. Whisper entry updated to reflect existing caption feature.
- **2026-06-25** — added "Site & documentation" tier: Docusaurus + GitHub Pages. Cleaned smoke-test noise from the changelog (internal CI sync validation, not user-facing).
- **2026-07-06** — added blur regions to the stability & quality tier. Confirmed upstream deprecated the feature in v1.5.0 without an explicit reason; the renderer code carried over to the fork, so the work is unblocking the export guard + adding coverage. Tracked via #76.
- **2026-07-27** — reconciled the roadmap with the code. The AI Edition tier moved from "a direction, not a sprint plan" to shipped: on-device transcription, transcript-driven editing, captions as a derived layer with translation, the chat agent, and the non-destructive project document are all in. Provider list corrected — ChatGPT and GitHub Copilot were removed in 1.8.0 and are now blocked on the vendors' sanctioned surfaces, and MiniMax was missing. New "Rendering & platform parity" tier: preview and MP4 export share one native D3D11 compositor, and porting it off Windows is now the biggest open item; #18 moved there since it's an encoder concern. Blur (#76) marked shipped — as an annotation type, not a region kind, so the old note pointing at `src/lib/exporter/videoExporter.ts` was doubly stale (that file was deleted with the web export pipeline). Copy/paste (#24) split: the shortcuts shipped, the right-click menu didn't. Docusaurus site marked shipped.
- **2026-08-01** — the platform-parity tier was the stalest thing on this page: it still described the compositor as Direct3D 11 and listed MP4 export on macOS and Linux as unstarted, while v1.8.0-rc.5 was already publishing DMGs and Linux packages built on the Metal and WGSL backends. #18 (software encoder fallback) shipped with them, as an automatically-selected CPU backend rather than an encoder flag. Two real gaps replace them: Linux export is software-encoded, and every performance number on record still comes from one passive-iGPU laptop. Also corrected the framing that produced this drift — the tier was written as "porting it off Windows is the biggest open item", which stayed true in the text long after it stopped being true in the tree.
- **2026-09-10** — rebranded this document to Capturia and published it on the site at `/roadmap`. Upstream's issue numbers are now linked as `upstream #N` against getopenscreen/openscreen, where they actually live: relative `../../issues/N` links resolved to *this* repo, where those numbers are unrelated PRs. Corrected the project file extension (`.capturia`; `.openscreen` and `.axcut` still open as legacy) and the site URL. Dropped the Discord section — that invite pointed at upstream's server, and Capturia does not run one; GitHub issues are the channel.
- **2026-09-11** — shipped the right-click menu for upstream #24, and corrected the copy/paste line, which had been ticked for applying attributes onto another region. Paste has only ever created a new region at the playhead, so applying attributes onto an existing region is now listed separately, unticked. Split one-click cleanup: the silence and filler-word pass has shipped as *Remove dead air*, and only voice enhancement is still open. Retired upstream #19, because nothing in the preview uses WebGL any more. Marked upstream #22 as fixed in code but unverified, because no one has confirmed it on a Mac.
