// Regression cover for the macOS half of upstream #433: the Edit menu must own
// Cmd+Z / Shift+Cmd+Z itself (no `role`) and forward them to the editor
// renderer, falling back to the web-editing undo for non-editor windows.

import { describe, expect, it, vi } from 'vitest';
import { buildEditMenuSubmenu, type EditorUndoRedoChannel, routeEditorUndoRedo, type UndoRedoWindow } from './edit-menu';

function build() {
  const dispatch = vi.fn<(channel: EditorUndoRedoChannel) => void>();
  const items = buildEditMenuSubmenu({
    label: (_key, fallback) => fallback,
    dispatch,
  });
  return { items, dispatch };
}

describe('buildEditMenuSubmenu', () => {
  it('owns Cmd+Z itself instead of leaning on registerAccelerator', () => {
    const { items } = build();
    const undoItem = items.find((i) => i.label === 'Undo');

    expect(undoItem?.accelerator).toBe('CmdOrCtrl+Z');
    expect(undoItem?.role).toBeUndefined();
    expect(undoItem?.registerAccelerator).toBeUndefined();
  });

  it('owns Shift+Cmd+Z for redo on the same terms', () => {
    const { items } = build();
    const redoItem = items.find((i) => i.label === 'Redo');

    expect(redoItem?.accelerator).toBe('Shift+CmdOrCtrl+Z');
    expect(redoItem?.role).toBeUndefined();
    expect(redoItem?.registerAccelerator).toBeUndefined();
  });

  it('routes both to the editor renderer, which owns the document undo stack', () => {
    const { items, dispatch } = build();

    items.find((i) => i.label === 'Undo')?.click?.(undefined as never, undefined as never, undefined as never);
    expect(dispatch).toHaveBeenCalledWith('menu-undo');

    items.find((i) => i.label === 'Redo')?.click?.(undefined as never, undefined as never, undefined as never);
    expect(dispatch).toHaveBeenCalledWith('menu-redo');
  });

  it('leaves the clipboard items as roles', () => {
    const { items } = build();
    expect(items.map((i) => i.role).filter(Boolean)).toEqual(['cut', 'copy', 'paste', 'selectAll']);
  });

  it('translates labels through the supplied lookup', () => {
    const items = buildEditMenuSubmenu({
      label: (key) => `T:${key}`,
      dispatch: vi.fn(),
    });
    expect(items[0].label).toBe('T:actions.undo');
    expect(items[3].label).toBe('T:actions.cut');
  });
});

function editorWindow() {
  const webContents = {
    send: vi.fn<(channel: EditorUndoRedoChannel) => void>(),
    undo: vi.fn(),
    redo: vi.fn(),
  };
  const isDestroyed = vi.fn(() => false);
  return {
    window: { isDestroyed, webContents } satisfies UndoRedoWindow,
    webContents,
    isDestroyed,
  };
}

describe('routeEditorUndoRedo', () => {
  it('hands the editor window the request over IPC', () => {
    const target = editorWindow();

    routeEditorUndoRedo('menu-undo', target.window, () => true);
    routeEditorUndoRedo('menu-redo', target.window, () => true);

    expect(target.webContents.send.mock.calls).toEqual([['menu-undo'], ['menu-redo']]);
    expect(target.webContents.undo).not.toHaveBeenCalled();
    expect(target.webContents.redo).not.toHaveBeenCalled();
  });

  it('falls back to the web-editing undo when the focused window is not the editor', () => {
    const target = editorWindow();

    routeEditorUndoRedo('menu-undo', target.window, () => false);
    expect(target.webContents.undo).toHaveBeenCalledOnce();
    expect(target.webContents.redo).not.toHaveBeenCalled();

    routeEditorUndoRedo('menu-redo', target.window, () => false);
    expect(target.webContents.redo).toHaveBeenCalledOnce();

    expect(target.webContents.send).not.toHaveBeenCalled();
  });

  it('does nothing when there is no window, or it has been destroyed', () => {
    const isEditor = vi.fn(() => true);
    expect(() => routeEditorUndoRedo('menu-undo', null, isEditor)).not.toThrow();

    const target = editorWindow();
    target.isDestroyed.mockReturnValue(true);
    routeEditorUndoRedo('menu-undo', target.window, isEditor);

    expect(target.webContents.send).not.toHaveBeenCalled();
    expect(target.webContents.undo).not.toHaveBeenCalled();
    expect(isEditor).not.toHaveBeenCalled();
  });
});
