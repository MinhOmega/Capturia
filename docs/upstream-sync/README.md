# Upstream sync: OpenScreen -> Capturia

Status: **in progress** (started 2026-08-27). Branch: `feat/upstream-sync-v1.7`.

## Context

- Capturia forked from `siddharthvaddem/openscreen` at upstream commit `87735c27`
  (2026-02-23, "squashed history up to v1.2.5"), then added ~40 commits of its own
  (macOS ScreenCaptureKit helper, subtitle/rough-cut analysis, aspect crop/zoom,
  export audio processing, permissions diagnostics, shortcuts UI, undo/redo, ...).
- Upstream moved to `getopenscreen/openscreen` and is now at **v1.10.0**
  (2269 commits). Its history splits into two eras:
  - **v1.3.0 - v1.7.0 (Apr-Jul 2026)** - same architecture as Capturia
    (React + PixiJS `VideoEditor`, `dnd-timeline`, WebCodecs exporter). ~350 files,
    +50k lines. **This is the sync target.**
  - **v1.8.0+ (Aug 2026)** - editor replaced by `src/components/ai-edition/` +
    a Rust GPU compositor (`crates/compositor`, D3D11/Metal/wgpu), PipeWire/WGC
    native helpers, whisper.cpp STT, LLM chat editing, CLI. This is a
    **re-platform, not a feature increment**. Out of scope for this sync; only
    architecture-independent pieces (electron utilities, locales) are considered.

Reference checkouts used for diffing (not part of the repo):

| Path | Ref |
|------|-----|
| `/tmp/openscreen-base` | `87735c27` - fork base |
| `/tmp/openscreen-v1.7.0` | `v1.7.0` - sync target |
| `/tmp/openscreen-upstream` | `main` (v1.10.0) |

## Ground rules for the sync

1. Capturia's own features are **not** regressed. Where upstream and Capturia solved the
   same problem differently (e.g. captions, crop, auto-zoom, native macOS recorder),
   the Capturia behaviour stays the default and the upstream capability is added
   alongside or merged into it, never a blind overwrite.
2. Every ported feature ships with its upstream unit tests (adapted), or new tests.
3. `npx tsc --noEmit` and `npm test` must stay green after every merge. Lint may not
   get worse than the baseline (59 problems on `main`).
4. Ports are reviewed against upstream's implementation for missed follow-up fixes
   (upstream often lands a feature then 3-6 fix commits; port the *final* state).
5. Decisions and progress are recorded in this folder so the work can resume across
   sessions.

## Work streams

| ID | Stream | Gap report |
|----|--------|-----------|
| A | Recording / launch HUD / native capture | `gap/A-recording.md` |
| B1 | Webcam composite, backgrounds, blur, 3D | `gap/B1-composite.md` |
| B2 | Zoom, cursor pipeline, motion | `gap/B2-zoom-cursor.md` |
| B3 | Timeline, annotations, project lifecycle, i18n | `gap/B3-timeline-project.md` |
| D | Exporter + audio + captions | `gap/D-export-captions.md` |
| F | Electron main/preload, security, build, packaging | `gap/F-electron-infra.md` |

## Cycle

plan -> test -> implement -> review -> verify -> remember -> improve

- **plan**: gap reports above, then `PLAN.md` with ordered batches.
- **test**: port/write tests first where upstream has them.
- **implement**: one batch per teammate, on its own branch/worktree.
- **review**: leader review + written review note in `reviews/`.
- **verify**: tsc + vitest + lint delta + manual smoke where applicable.
- **remember**: update `PROGRESS.md` and this file.
- **improve**: fold review findings back into the next batch.

## Baseline (main @ 4cab381)

- `npx tsc --noEmit`: clean
- `npm test`: 32 files / 204 tests passing
- `npm run lint`: 59 problems (46 errors, 13 warnings) - pre-existing
