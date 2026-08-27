// The application menu's Edit submenu, split out of `main.ts` so it can be
// tested (ported from OpenScreen, upstream #433).
//
// Undo/Redo are deliberately NOT `role: "undo"` / `role: "redo"`.
//
// Those roles run `webContents.undo()`, the WEB EDITING undo, which does
// nothing at all outside a focused text field. On macOS their Cmd+Z key
// equivalent is matched by AppKit inside `-[NSApplication sendEvent:]`, BEFORE
// the key event reaches the web contents, so the editor's own window-level
// keydown handler never sees the keydown and Cmd+Z silently did nothing.
//
// `registerAccelerator: false` does not fix that: Electron annotates the field
// `@platform linux,win32`, so on darwin it is ignored and the menu keeps the
// key equivalent. On Windows and Linux the roles were never the problem: menu
// accelerators there are dispatched from the unhandled-keyboard-event path,
// AFTER the renderer, which the renderer's own `preventDefault()` suppresses.
//
// So the items own the accelerator on every platform and forward to the editor
// renderer, which applies the rule its keydown path applies: a focused text
// field gets the browser's text undo, anything else gets the document undo.
// `dispatch` falls back to `webContents.undo()` when the focused window is not
// the editor at all (HUD, permission checker).

import type { MenuItemConstructorOptions } from 'electron';

/** IPC channels the Edit menu forwards to the editor renderer. */
export type EditorUndoRedoChannel = 'menu-undo' | 'menu-redo';

export interface EditMenuOptions {
  /** Localised label for `key`, falling back to `fallback` when untranslated. */
  label: (key: string, fallback: string) => string;
  /** Route an undo/redo request to whichever window should service it. */
  dispatch: (channel: EditorUndoRedoChannel) => void;
}

/** The slice of `WebContents` the routing below touches. */
export interface UndoRedoWebContents {
  send: (channel: EditorUndoRedoChannel) => void;
  undo: () => void;
  redo: () => void;
}

/** The slice of `BrowserWindow` the routing below touches. */
export interface UndoRedoWindow {
  isDestroyed: () => boolean;
  webContents: UndoRedoWebContents;
}

/**
 * Deliver an undo/redo request to the window that should service it. Never
 * CREATES an editor window: Cmd+Z is not a request to open the editor.
 * `isEditor` is a callback so nothing reads the window's URL before the
 * destroyed check has run.
 */
export function routeEditorUndoRedo(
  channel: EditorUndoRedoChannel,
  window: UndoRedoWindow | null | undefined,
  isEditor: () => boolean,
): void {
  if (!window || window.isDestroyed()) return;
  if (!isEditor()) {
    if (channel === 'menu-undo') window.webContents.undo();
    else window.webContents.redo();
    return;
  }
  window.webContents.send(channel);
}

export function buildEditMenuSubmenu({ label, dispatch }: EditMenuOptions): MenuItemConstructorOptions[] {
  return [
    {
      label: label('actions.undo', 'Undo'),
      accelerator: 'CmdOrCtrl+Z',
      click: () => dispatch('menu-undo'),
    },
    {
      label: label('actions.redo', 'Redo'),
      accelerator: 'Shift+CmdOrCtrl+Z',
      click: () => dispatch('menu-redo'),
    },
    { type: 'separator' },
    // The clipboard roles keep theirs: they act on the focused text selection,
    // which is precisely what `webContents.cut/copy/paste` do.
    { role: 'cut', label: label('actions.cut', 'Cut') },
    { role: 'copy', label: label('actions.copy', 'Copy') },
    { role: 'paste', label: label('actions.paste', 'Paste') },
    { role: 'selectAll', label: label('actions.selectAll', 'Select All') },
  ];
}
