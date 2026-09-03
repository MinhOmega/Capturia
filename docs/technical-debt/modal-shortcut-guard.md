# Modal Shortcut Guard: Technical Debt Note

## Context

Global keyboard shortcuts are registered on `window` in the capture phase. Until
the settings-panel batch they kept firing while a modal dialog owned the screen,
so inside a dialog Space toggled playback the user could not see, the arrow keys
seeked the timeline, and Ctrl+Z undid a hidden edit.

## Approach

A dialog is recognised by the `aria-modal="true"` attribute it should carry for
assistive technology anyway, rather than by an "is some dialog open" flag
threaded through every panel. `isModalDialogOpen()` in `src/lib/modalDialog.ts`
reads it back off the document; there is one fact to keep correct, and it lives
where the dialog is opened.

Marked so far:

- `DialogContent` in `src/components/ui/dialog.tsx`, which covers the tutorial,
  custom-font and shortcuts-config dialogs.
- The hand-rolled crop dialog in `SettingsPanel.tsx`.

Guarded so far:

- The editor's global `keydown` handler in `VideoEditor.tsx`.
- `menu-undo` / `menu-redo` forwarded from the native Edit menu.

## Outstanding

1. **`TimelineEditor.tsx` registers its own `window` keydown listener** and is
   not guarded. Its shortcuts still fire under an open dialog. The fix is the
   same one-line early return, but the file belongs to another work stream, so
   it was left alone rather than creating a merge conflict.
2. **`LaunchWindow.tsx` also registers a capture-phase listener.** It is a
   separate window from the editor, so the practical exposure is smaller, but it
   deserves the same treatment if dialogs are ever added there.
3. **New modal surfaces must opt in.** Anything that dims the screen and takes
   focus without going through `DialogContent` needs `role="dialog"` and
   `aria-modal="true"` by hand, as the crop dialog does. There is no test that
   fails when a new hand-rolled overlay forgets.
