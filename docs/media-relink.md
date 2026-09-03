# Project state survives a moved or renamed recording

Project state is stored per recording under `<userData>/projects/<basename>_<sha256(path)[0..16]>.json`
and the cursor track next to the recording as `<name>.cursor.json`. Both keys are derived from the
recording's path, so moving or renaming the file orphaned every edit made to it: the editor opened
the same video with an empty timeline and no cursor track, and the old state sat unreachable on disk.

A content fingerprint recorded on every save gives a second way in.

## Registry

`<userData>/media-links.json`, written atomically (temp file + rename) through a per-directory
promise queue so two auto-saves cannot clobber each other:

```json
{
  "version": 1,
  "entries": [
    {
      "fingerprint": { "sizeBytes": 41231, "headSha256": "…", "tailSha256": "…" },
      "lastKnownPath": "/Users/me/Movies/demo.webm",
      "projectStateFile": "demo.webm_1f2e3d4c5b6a7980.json",
      "cursorSidecarPath": "/Users/me/Movies/demo.cursor.json",
      "updatedAt": "2026-09-03T09:00:00.000Z"
    }
  ]
}
```

- **Fingerprint** = file size + SHA-256 of the first 64 KiB + SHA-256 of the last 64 KiB
  (`computeMediaFingerprint`). Not a whole-file hash: recordings run to gigabytes and the auto-save
  fires every few seconds, so the cost has to be flat in file size. It survives a move, a rename and
  a copy, which is the whole problem being solved; it deliberately does not recognise a re-encode.
- **Entries are keyed by fingerprint *and* path.** Two live copies of the same bytes get one entry
  each rather than overwriting one another, which is what makes ambiguity visible below.
- Capped at 500 entries, oldest `updatedAt` dropped first. A malformed entry is skipped on read
  (`normalizeMediaLinkEntry`); an unreadable file starts empty rather than failing the load.
- `save-project-state` refreshes the entry after the state write. The fingerprint is cached per
  path against size+mtime so the recurring auto-save re-reads nothing, and any failure is logged
  and swallowed: the registry is a convenience and must never turn a good save into an error.

## Relink decision

`load-project-state` looks for the state file for the path first. Only when there is none does it
fingerprint the recording and ask the registry (`decideRelink`, pure and table-tested):

| Situation | Result |
|---|---|
| A state file already exists for this path | `keep` — registry not consulted |
| No entry matches the fingerprint | `none: no-match` |
| The only matches are this same path | `none: same-path` |
| Matches exist but none has a state file that is still on disk | `none: state-missing` |
| Two or more other paths each have their own state file | `none: ambiguous` |
| Exactly one other path has a state file | `relink` |

**Ambiguity never relinks.** If the same bytes are registered at several paths with different
project states, the user has copies that were edited apart and nothing in the fingerprint says which
one this is. Attaching the wrong edits silently is worse than attaching none, so the editor opens
clean. The same rule governs the cursor sidecar: when the copies disagree on which sidecar to use,
none is used.

On `relink` the old state is **copied** to the new path's key and the cursor sidecar is copied next
to the moved recording, so every later open takes the cheap path and the registry works once per
move. Copies, not moves: if the user keeps both locations, both stay editable. The old entry is
dropped only when nothing is left at its path, which is what lets a recording be moved twice.

The renderer shows `editor.projectRelinked` as an info toast when `loadProjectState` comes back with
`relinked: true`. No new IPC channel: the existing result gained `relinked` and `relinkedFrom`.

`get-current-video-path` and `set-current-video-path` use the same registry for the cursor track
alone (`findLinkedCursorSidecar`), read-only — copying it next to the new path is the relinker's job.

## Trust boundary

Everything read out of the registry is data, never trust. The registry file is user-writable, so:

- a `projectStateFile` is accepted only as a bare `.json` name resolved inside `<userData>/projects`
  through `resolveOutputPathInDir` (no separators, no `..`);
- a `cursorSidecarPath` is accepted only when it is exactly the sidecar its own entry's recording
  path implies, absolute and `.json`;
- the recording being opened must itself pass `isReadablePathAllowed` from `electron/ipc/paths.ts`
  (inside the recordings dir, or approved by a file picker) before anything is fingerprinted,
  registered or relinked.

## Tests

`electron/media/mediaLinksRegistry.test.ts` (13) — fingerprint stability across copy/rename, head
and tail sensitivity, body insensitivity on a large file, registry round trip, per-path entries,
stale removal, concurrent writes, entry validation, pruning.
`electron/media/projectMediaRelinker.test.ts` (21) — the decision table, sidecar path trust, save
registration, relink of a moved recording, refusal outside the read policy, refusal on ambiguity,
a second move, and the cursor-sidecar lookup.
`electron/ipc/projectState.test.ts` — the IPC round trip end to end.
