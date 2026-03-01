import { describe, it, expect } from 'vitest';
import {
  bindingsEqual,
  findConflict,
  matchesShortcut,
  formatBinding,
  mergeWithDefaults,
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  type ShortcutBinding,
  type ShortcutsConfig,
} from './shortcuts';

// ---------------------------------------------------------------------------
// bindingsEqual
// ---------------------------------------------------------------------------
describe('bindingsEqual', () => {
  it('matches identical simple bindings', () => {
    expect(bindingsEqual({ key: 'z' }, { key: 'z' })).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(bindingsEqual({ key: 'Z' }, { key: 'z' })).toBe(true);
    expect(bindingsEqual({ key: 'a' }, { key: 'A' })).toBe(true);
  });

  it('matches identical modifier bindings', () => {
    expect(
      bindingsEqual({ key: 'd', ctrl: true }, { key: 'd', ctrl: true }),
    ).toBe(true);
  });

  it('treats undefined modifiers as false', () => {
    expect(
      bindingsEqual({ key: 'z' }, { key: 'z', ctrl: false, shift: false, alt: false }),
    ).toBe(true);
  });

  it('rejects different keys', () => {
    expect(bindingsEqual({ key: 'z' }, { key: 'x' })).toBe(false);
  });

  it('rejects different modifiers', () => {
    expect(bindingsEqual({ key: 'z', ctrl: true }, { key: 'z' })).toBe(false);
    expect(bindingsEqual({ key: 'z', shift: true }, { key: 'z' })).toBe(false);
    expect(bindingsEqual({ key: 'z', alt: true }, { key: 'z' })).toBe(false);
  });

  it('rejects when only one has shift', () => {
    expect(
      bindingsEqual({ key: 'z', ctrl: true, shift: true }, { key: 'z', ctrl: true }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findConflict
// ---------------------------------------------------------------------------
describe('findConflict', () => {
  const config: ShortcutsConfig = { ...DEFAULT_SHORTCUTS };

  it('returns null when no conflict exists', () => {
    expect(findConflict({ key: 'q' }, 'addZoom', config)).toBeNull();
  });

  it('detects configurable conflict', () => {
    // 'a' is assigned to addAnnotation
    const result = findConflict({ key: 'a' }, 'addZoom', config);
    expect(result).toEqual({ type: 'configurable', action: 'addAnnotation' });
  });

  it('excludes self from conflict check', () => {
    // 'z' is addZoom — assigning 'z' to addZoom should not conflict
    expect(findConflict({ key: 'z' }, 'addZoom', config)).toBeNull();
  });

  it('detects fixed shortcut conflict', () => {
    // Ctrl+Z is undo (fixed)
    const result = findConflict({ key: 'z', ctrl: true }, 'addZoom', config);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('fixed');
  });

  it('detects fixed arrow key conflict', () => {
    const result = findConflict({ key: 'arrowright' }, 'playPause', config);
    expect(result).toEqual({ type: 'fixed', labelKey: 'shortcut.seekForward' });
  });
});

// ---------------------------------------------------------------------------
// matchesShortcut
// ---------------------------------------------------------------------------
describe('matchesShortcut', () => {
  const makeEvent = (overrides: Partial<KeyboardEvent>): KeyboardEvent =>
    ({
      key: '',
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      ...overrides,
    } as unknown as KeyboardEvent);

  it('matches simple key', () => {
    expect(matchesShortcut(makeEvent({ key: 'z' }), { key: 'z' }, false)).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(matchesShortcut(makeEvent({ key: 'Z' }), { key: 'z' }, false)).toBe(true);
  });

  it('matches Ctrl key on Linux', () => {
    expect(
      matchesShortcut(makeEvent({ key: 'd', ctrlKey: true }), { key: 'd', ctrl: true }, false),
    ).toBe(true);
  });

  it('matches Meta (Cmd) key on Mac', () => {
    expect(
      matchesShortcut(makeEvent({ key: 'd', metaKey: true }), { key: 'd', ctrl: true }, true),
    ).toBe(true);
  });

  it('rejects Ctrl on Mac when binding has ctrl (expects Meta)', () => {
    expect(
      matchesShortcut(makeEvent({ key: 'd', ctrlKey: true }), { key: 'd', ctrl: true }, true),
    ).toBe(false);
  });

  it('rejects when extra modifier is held', () => {
    // Binding is just 'z', but Ctrl is held
    expect(
      matchesShortcut(makeEvent({ key: 'z', ctrlKey: true }), { key: 'z' }, false),
    ).toBe(false);
  });

  it('rejects when required modifier is missing', () => {
    expect(
      matchesShortcut(makeEvent({ key: 'd' }), { key: 'd', ctrl: true }, false),
    ).toBe(false);
  });

  it('matches shift+key', () => {
    expect(
      matchesShortcut(makeEvent({ key: 'a', shiftKey: true }), { key: 'a', shift: true }, false),
    ).toBe(true);
  });

  it('matches alt+key', () => {
    expect(
      matchesShortcut(makeEvent({ key: 'x', altKey: true }), { key: 'x', alt: true }, false),
    ).toBe(true);
  });

  it('matches space key', () => {
    expect(
      matchesShortcut(makeEvent({ key: ' ' }), { key: ' ' }, false),
    ).toBe(true);
  });

  it('rejects wrong key', () => {
    expect(matchesShortcut(makeEvent({ key: 'x' }), { key: 'z' }, false)).toBe(false);
  });

  it('rejects Ctrl+Z on Mac when binding has no modifiers', () => {
    // Physical Ctrl on Mac should not match a bare key binding
    expect(
      matchesShortcut(makeEvent({ key: 'z', ctrlKey: true }), { key: 'z' }, true),
    ).toBe(false);
  });

  it('rejects Meta+Z on Linux when binding has no modifiers', () => {
    expect(
      matchesShortcut(makeEvent({ key: 'z', metaKey: true }), { key: 'z' }, false),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatBinding
// ---------------------------------------------------------------------------
describe('formatBinding', () => {
  it('formats a single key in uppercase', () => {
    expect(formatBinding({ key: 'z' }, false)).toBe('Z');
  });

  it('formats Ctrl+key for Linux', () => {
    expect(formatBinding({ key: 'd', ctrl: true }, false)).toBe('Ctrl + D');
  });

  it('formats Cmd+key for Mac', () => {
    expect(formatBinding({ key: 'd', ctrl: true }, true)).toBe('⌘ + D');
  });

  it('formats Shift+key for Linux', () => {
    expect(formatBinding({ key: 'a', shift: true }, false)).toBe('Shift + A');
  });

  it('formats Shift+key for Mac with symbol', () => {
    expect(formatBinding({ key: 'a', shift: true }, true)).toBe('⇧ + A');
  });

  it('formats Alt+key for Linux', () => {
    expect(formatBinding({ key: 'x', alt: true }, false)).toBe('Alt + X');
  });

  it('formats Alt+key for Mac with symbol', () => {
    expect(formatBinding({ key: 'x', alt: true }, true)).toBe('⌥ + X');
  });

  it('formats multi-modifier binding', () => {
    expect(formatBinding({ key: 'z', ctrl: true, shift: true }, false)).toBe('Ctrl + Shift + Z');
    expect(formatBinding({ key: 'z', ctrl: true, shift: true }, true)).toBe('⌘ + ⇧ + Z');
  });

  it('formats special keys', () => {
    expect(formatBinding({ key: ' ' }, false)).toBe('Space');
    expect(formatBinding({ key: 'arrowleft' }, false)).toBe('←');
    expect(formatBinding({ key: 'arrowright' }, false)).toBe('→');
    expect(formatBinding({ key: 'delete' }, false)).toBe('Del');
    expect(formatBinding({ key: 'backspace' }, false)).toBe('⌫');
    expect(formatBinding({ key: 'escape' }, false)).toBe('Esc');
  });

  it('formats bracket keys', () => {
    expect(formatBinding({ key: ']' }, false)).toBe(']');
    expect(formatBinding({ key: '[' }, false)).toBe('[');
  });
});

// ---------------------------------------------------------------------------
// mergeWithDefaults
// ---------------------------------------------------------------------------
describe('mergeWithDefaults', () => {
  it('returns defaults when given empty object', () => {
    const result = mergeWithDefaults({});
    expect(result).toEqual(DEFAULT_SHORTCUTS);
  });

  it('preserves overridden keys', () => {
    const result = mergeWithDefaults({ addZoom: { key: 'q' } });
    expect(result.addZoom).toEqual({ key: 'q' });
    // Other keys should be defaults
    expect(result.addAnnotation).toEqual(DEFAULT_SHORTCUTS.addAnnotation);
  });

  it('fills missing keys from defaults', () => {
    const partial: Partial<ShortcutsConfig> = {
      playPause: { key: 'p' },
    };
    const result = mergeWithDefaults(partial);
    expect(result.playPause).toEqual({ key: 'p' });
    for (const action of SHORTCUT_ACTIONS) {
      if (action !== 'playPause') {
        expect(result[action]).toEqual(DEFAULT_SHORTCUTS[action]);
      }
    }
  });

  it('ignores invalid entries without key property', () => {
    const result = mergeWithDefaults({ addZoom: { bad: true } as unknown as ShortcutBinding });
    expect(result.addZoom).toEqual(DEFAULT_SHORTCUTS.addZoom);
  });

  it('preserves full config as-is', () => {
    const full: ShortcutsConfig = {
      addZoom: { key: '1' },
      addAnnotation: { key: '2' },
      addKeyframe: { key: '3' },
      toggleScissors: { key: '4' },
      deleteSelected: { key: '5', ctrl: true },
      playPause: { key: '6' },
      speedUp: { key: '7' },
      speedDown: { key: '8' },
    };
    expect(mergeWithDefaults(full)).toEqual(full);
  });
});
