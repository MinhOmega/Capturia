import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFS,
  getExportFolder,
  loadUserPreferences,
  parentDirectoryOf,
  saveUserPreferences,
  USER_PREFERENCES_STORAGE_KEY,
} from './userPreferences';

describe('parentDirectoryOf', () => {
  it('returns the directory for a POSIX path', () => {
    expect(parentDirectoryOf('/Users/me/Movies/clip.mp4')).toBe('/Users/me/Movies');
  });

  it('returns the directory for a Windows path', () => {
    expect(parentDirectoryOf('C:\\Users\\me\\Movies\\clip.mp4')).toBe('C:\\Users\\me\\Movies');
  });

  it('preserves the POSIX root when the file is at /', () => {
    expect(parentDirectoryOf('/video.mp4')).toBe('/');
  });

  it('preserves the Windows drive root with its trailing separator', () => {
    expect(parentDirectoryOf('C:\\video.mp4')).toBe('C:\\');
    expect(parentDirectoryOf('D:/video.mp4')).toBe('D:/');
  });

  it('returns null when no separator is present', () => {
    expect(parentDirectoryOf('video.mp4')).toBeNull();
    expect(parentDirectoryOf('')).toBeNull();
  });
});

// vitest runs in the node environment here, so stub localStorage with an
// in-memory shim that mirrors the subset of the Storage API we touch.
function installLocalStorageStub() {
  const store = new Map<string, string>();
  const stub = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: stub,
    configurable: true,
    writable: true,
  });
}

describe('user preferences persistence', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  beforeEach(() => {
    installLocalStorageStub();
  });

  afterAll(() => {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('returns defaults when nothing is persisted', () => {
    expect(loadUserPreferences()).toEqual(DEFAULT_PREFS);
    expect(getExportFolder()).toBeUndefined();
  });

  it('stores under the capturia-prefixed key', () => {
    saveUserPreferences({ padding: 20 });
    expect(USER_PREFERENCES_STORAGE_KEY.startsWith('capturia.')).toBe(true);
    expect(localStorage.getItem(USER_PREFERENCES_STORAGE_KEY)).not.toBeNull();
  });

  it('round-trips a saved export folder', () => {
    saveUserPreferences({ exportFolder: '/Users/me/Downloads' });
    expect(loadUserPreferences().exportFolder).toBe('/Users/me/Downloads');
    expect(getExportFolder()).toBe('/Users/me/Downloads');
  });

  it('merges partial saves without clobbering other fields', () => {
    saveUserPreferences({ exportFolder: '/Users/me/Downloads' });
    saveUserPreferences({ aspectRatio: '9:16', exportFormat: 'gif' });
    const prefs = loadUserPreferences();
    expect(prefs.exportFolder).toBe('/Users/me/Downloads');
    expect(prefs.aspectRatio).toBe('9:16');
    expect(prefs.exportFormat).toBe('gif');
    expect(prefs.padding).toBe(DEFAULT_PREFS.padding);
  });

  it('ignores non-string and empty export folders', () => {
    localStorage.setItem(USER_PREFERENCES_STORAGE_KEY, JSON.stringify({ exportFolder: 42 }));
    expect(loadUserPreferences().exportFolder).toBeNull();
    localStorage.setItem(USER_PREFERENCES_STORAGE_KEY, JSON.stringify({ exportFolder: '' }));
    expect(loadUserPreferences().exportFolder).toBeNull();
  });

  it('falls back to defaults for invalid enum values', () => {
    localStorage.setItem(
      USER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ aspectRatio: '3:2', exportQuality: 'ultra', exportFormat: 'webm' }),
    );
    const prefs = loadUserPreferences();
    expect(prefs.aspectRatio).toBe(DEFAULT_PREFS.aspectRatio);
    expect(prefs.exportQuality).toBe(DEFAULT_PREFS.exportQuality);
    expect(prefs.exportFormat).toBe(DEFAULT_PREFS.exportFormat);
  });

  it('falls back to defaults for out-of-range numbers', () => {
    localStorage.setItem(
      USER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ padding: 150, seekStepSeconds: 0, previewPlaybackRate: 32 }),
    );
    const prefs = loadUserPreferences();
    expect(prefs.padding).toBe(DEFAULT_PREFS.padding);
    expect(prefs.seekStepSeconds).toBe(DEFAULT_PREFS.seekStepSeconds);
    expect(prefs.previewPlaybackRate).toBe(DEFAULT_PREFS.previewPlaybackRate);
  });

  it('accepts in-range playback preferences', () => {
    saveUserPreferences({ seekStepSeconds: 10, previewPlaybackRate: 1.5 });
    const prefs = loadUserPreferences();
    expect(prefs.seekStepSeconds).toBe(10);
    expect(prefs.previewPlaybackRate).toBe(1.5);
  });

  it('survives malformed JSON in storage', () => {
    localStorage.setItem(USER_PREFERENCES_STORAGE_KEY, '{not json');
    expect(loadUserPreferences()).toEqual(DEFAULT_PREFS);
  });

  it('survives a throwing localStorage', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      },
      configurable: true,
      writable: true,
    });
    expect(loadUserPreferences()).toEqual(DEFAULT_PREFS);
    expect(() => saveUserPreferences({ padding: 10 })).not.toThrow();
  });
});
