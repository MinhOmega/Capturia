import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceleratorToBinding,
  bindingToAccelerator,
  DEFAULT_GLOBAL_BINDINGS,
  GlobalShortcutManager,
  type GlobalShortcutRegistry,
  isGlobalBindingAllowed,
  persistStoredGlobalBinding,
  readStoredGlobalBindings,
} from './globalShortcut';

describe('bindingToAccelerator', () => {
  it('orders modifiers CommandOrControl, Shift, Alt and upper-cases letters', () => {
    expect(bindingToAccelerator({ key: 'o', ctrl: true, shift: true })).toBe('CommandOrControl+Shift+O');
    expect(bindingToAccelerator({ key: 'r', ctrl: true, alt: true })).toBe('CommandOrControl+Alt+R');
    expect(bindingToAccelerator({ key: 'x', alt: true, shift: true })).toBe('Shift+Alt+X');
    expect(bindingToAccelerator({ key: '2', ctrl: true, shift: true })).toBe('CommandOrControl+Shift+2');
  });

  it('maps special KeyboardEvent.key values to accelerator names', () => {
    expect(bindingToAccelerator({ key: ' ', ctrl: true })).toBe('CommandOrControl+Space');
    expect(bindingToAccelerator({ key: 'ArrowUp', ctrl: true })).toBe('CommandOrControl+Up');
    expect(bindingToAccelerator({ key: 'escape', alt: true })).toBe('Alt+Escape');
    expect(bindingToAccelerator({ key: 'Enter', ctrl: true })).toBe('CommandOrControl+Return');
    expect(bindingToAccelerator({ key: '+', ctrl: true })).toBe('CommandOrControl+Plus');
    expect(bindingToAccelerator({ key: '-', ctrl: true })).toBe('CommandOrControl+numsub');
  });

  it('passes multi-character keys such as F-keys through unchanged', () => {
    expect(bindingToAccelerator({ key: 'F9', ctrl: true })).toBe('CommandOrControl+F9');
  });
});

describe('acceleratorToBinding', () => {
  it('parses the HUD-style raw accelerators', () => {
    expect(acceleratorToBinding('Command+Shift+2')).toEqual({ key: '2', ctrl: true, shift: true });
    expect(acceleratorToBinding('Control+Alt+R')).toEqual({ key: 'r', ctrl: true, alt: true });
    expect(acceleratorToBinding('CommandOrControl+Shift+O')).toEqual({ key: 'o', ctrl: true, shift: true });
  });

  it('maps accelerator key names back to KeyboardEvent.key values', () => {
    expect(acceleratorToBinding('CommandOrControl+Space')).toEqual({ key: ' ', ctrl: true });
    expect(acceleratorToBinding('Alt+Up')).toEqual({ key: 'arrowup', alt: true });
    expect(acceleratorToBinding('Ctrl+Return')).toEqual({ key: 'enter', ctrl: true });
  });

  it('round-trips through bindingToAccelerator', () => {
    for (const accelerator of ['CommandOrControl+Shift+2', 'CommandOrControl+Alt+R', 'Alt+Space', 'Shift+Alt+F9']) {
      const binding = acceleratorToBinding(accelerator);
      expect(binding).not.toBeNull();
      expect(bindingToAccelerator(binding as NonNullable<typeof binding>)).toBe(accelerator);
    }
  });

  it('rejects empty or modifier-only strings', () => {
    expect(acceleratorToBinding('')).toBeNull();
    expect(acceleratorToBinding('  ')).toBeNull();
    expect(acceleratorToBinding('Control+Shift')).toBeNull();
  });
});

describe('isGlobalBindingAllowed', () => {
  it('requires ctrl or alt so a bare key is never captured system-wide', () => {
    expect(isGlobalBindingAllowed({ key: 'o' })).toBe(false);
    expect(isGlobalBindingAllowed({ key: 'o', shift: true })).toBe(false);
    expect(isGlobalBindingAllowed({ key: 'o', ctrl: true })).toBe(true);
    expect(isGlobalBindingAllowed({ key: 'o', alt: true })).toBe(true);
    expect(isGlobalBindingAllowed({ key: '', ctrl: true })).toBe(false);
  });
});

function fakeRegistry(failing: ReadonlySet<string> = new Set()) {
  const registered = new Map<string, () => void>();
  const registry: GlobalShortcutRegistry = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (failing.has(accelerator)) return false;
      registered.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => {
      registered.delete(accelerator);
    }),
    unregisterAll: vi.fn(() => registered.clear()),
  };
  return { registry, registered };
}

describe('GlobalShortcutManager', () => {
  const handlers = { openApp: vi.fn(), stopRecording: vi.fn() };

  beforeEach(() => {
    handlers.openApp.mockClear();
    handlers.stopRecording.mockClear();
  });

  it('registers a binding and dispatches to the action handler', () => {
    const { registry, registered } = fakeRegistry();
    const manager = new GlobalShortcutManager(registry, handlers);

    const result = manager.register('openApp', { key: 'o', ctrl: true, shift: true });
    expect(result).toEqual({ ok: true, accelerator: 'CommandOrControl+Shift+O' });
    expect(manager.getAccelerator('openApp')).toBe('CommandOrControl+Shift+O');

    registered.get('CommandOrControl+Shift+O')?.();
    expect(handlers.openApp).toHaveBeenCalledOnce();
    expect(handlers.stopRecording).not.toHaveBeenCalled();
  });

  it('accepts raw accelerator strings (the HUD legacy path)', () => {
    const { registry } = fakeRegistry();
    const manager = new GlobalShortcutManager(registry, handlers);
    expect(manager.register('stopRecording', ' Command+Shift+2 ')).toEqual({
      ok: true,
      accelerator: 'Command+Shift+2',
    });
  });

  it('registers the new accelerator before unregistering the old one', () => {
    const { registry } = fakeRegistry();
    const manager = new GlobalShortcutManager(registry, handlers);
    manager.register('openApp', { key: 'o', ctrl: true, shift: true });

    const order: string[] = [];
    (registry.register as ReturnType<typeof vi.fn>).mockImplementation((acc: string) => {
      order.push(`register:${acc}`);
      return true;
    });
    (registry.unregister as ReturnType<typeof vi.fn>).mockImplementation((acc: string) => {
      order.push(`unregister:${acc}`);
    });

    manager.register('openApp', { key: 'p', ctrl: true, shift: true });
    expect(order).toEqual(['register:CommandOrControl+Shift+P', 'unregister:CommandOrControl+Shift+O']);
  });

  it('keeps the old binding and reports "unavailable" when the OS refuses the new one', () => {
    const { registry, registered } = fakeRegistry(new Set(['CommandOrControl+Shift+P']));
    const manager = new GlobalShortcutManager(registry, handlers);
    manager.register('openApp', { key: 'o', ctrl: true, shift: true });

    const result = manager.register('openApp', { key: 'p', ctrl: true, shift: true });
    expect(result).toEqual({ ok: false, accelerator: 'CommandOrControl+Shift+O', error: 'unavailable' });
    expect(registered.has('CommandOrControl+Shift+O')).toBe(true);
    expect(registry.unregister).not.toHaveBeenCalled();
  });

  it('treats a throwing registry like a refusal', () => {
    const { registry } = fakeRegistry();
    (registry.register as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('bad accelerator');
    });
    const manager = new GlobalShortcutManager(registry, handlers);
    expect(manager.register('openApp', 'Nope').error).toBe('unavailable');
  });

  it('refuses to bind both actions to the same accelerator', () => {
    const { registry } = fakeRegistry();
    const manager = new GlobalShortcutManager(registry, handlers);
    manager.register('stopRecording', { key: '2', ctrl: true, shift: true });

    const result = manager.register('openApp', { key: '2', ctrl: true, shift: true });
    expect(result).toEqual({ ok: false, accelerator: '', error: 'conflict' });
    expect(manager.getAccelerator('openApp')).toBeNull();
  });

  it('is a no-op when re-registering the current accelerator', () => {
    const { registry } = fakeRegistry();
    const manager = new GlobalShortcutManager(registry, handlers);
    manager.register('openApp', { key: 'o', ctrl: true, shift: true });
    (registry.register as ReturnType<typeof vi.fn>).mockClear();

    expect(manager.register('openApp', { key: 'O', ctrl: true, shift: true }).ok).toBe(true);
    expect(registry.register).not.toHaveBeenCalled();
  });

  it('rejects an empty accelerator', () => {
    const { registry } = fakeRegistry();
    const manager = new GlobalShortcutManager(registry, handlers);
    expect(manager.register('stopRecording', '   ')).toEqual({ ok: false, accelerator: '', error: 'empty' });
  });

  it('registerAll falls back to the default when a stored custom binding cannot be registered', () => {
    const { registry } = fakeRegistry(new Set(['CommandOrControl+Alt+Q']));
    const manager = new GlobalShortcutManager(registry, handlers);

    manager.registerAll({ openApp: { key: 'q', ctrl: true, alt: true } });

    expect(manager.getAccelerator('openApp')).toBe(bindingToAccelerator(DEFAULT_GLOBAL_BINDINGS.openApp));
    expect(manager.getAccelerator('stopRecording')).toBe(bindingToAccelerator(DEFAULT_GLOBAL_BINDINGS.stopRecording));
  });

  it('unregisterAll clears the registry and the bookkeeping', () => {
    const { registry } = fakeRegistry();
    const manager = new GlobalShortcutManager(registry, handlers);
    manager.registerAll({});
    manager.unregisterAll();
    expect(registry.unregisterAll).toHaveBeenCalledOnce();
    expect(manager.getAccelerator('openApp')).toBeNull();
  });
});

describe('shortcuts.json persistence', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'capturia-shortcuts-'));
    file = path.join(dir, 'shortcuts.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads only well-formed global bindings', async () => {
    await writeFile(
      file,
      JSON.stringify({
        addZoom: { key: 'z' },
        openApp: { key: 'o', ctrl: true, shift: true },
        stopRecording: 'not-a-binding',
      }),
    );
    expect(await readStoredGlobalBindings(file)).toEqual({ openApp: { key: 'o', ctrl: true, shift: true } });
  });

  it('returns an empty map when the file is missing or corrupt', async () => {
    expect(await readStoredGlobalBindings(file)).toEqual({});
    await writeFile(file, '{ not json');
    expect(await readStoredGlobalBindings(file)).toEqual({});
  });

  it('merges one global binding without disturbing the editor shortcuts', async () => {
    await writeFile(file, JSON.stringify({ addZoom: { key: 'z' } }));
    await persistStoredGlobalBinding(file, 'stopRecording', { key: '2', ctrl: true, shift: true });
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    expect(parsed).toEqual({ addZoom: { key: 'z' }, stopRecording: { key: '2', ctrl: true, shift: true } });
  });

  it('creates the file when it does not exist yet', async () => {
    await persistStoredGlobalBinding(path.join(dir, 'nested', 'shortcuts.json'), 'openApp', { key: 'o', ctrl: true });
    const parsed = JSON.parse(await readFile(path.join(dir, 'nested', 'shortcuts.json'), 'utf-8'));
    expect(parsed).toEqual({ openApp: { key: 'o', ctrl: true } });
  });
});
