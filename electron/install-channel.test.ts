import { describe, expect, it } from 'vitest';
import {
  classifyInstall,
  type InstallProbe,
  offersUpdateCheck,
  ownsItsUpdates,
  platformOwnsUpdates,
} from './install-channel';

/** A packaged Linux install with no channel markers at all. */
function probe(overrides: Partial<InstallProbe> = {}): InstallProbe {
  return {
    platform: 'linux',
    isPackaged: true,
    execPath: '/opt/Capturia/capturia',
    windowsStore: false,
    env: {},
    hasFlatpakInfo: false,
    packageType: null,
    ...overrides,
  };
}

describe('classifyInstall', () => {
  it('reports dev for an unpacked build regardless of platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(classifyInstall(probe({ platform, isPackaged: false }))).toBe('dev');
    }
  });

  it('classifies the installers we build and own', () => {
    expect(classifyInstall(probe({ platform: 'win32' }))).toBe('nsis');
    expect(classifyInstall(probe({ platform: 'darwin' }))).toBe('dmg');
    expect(classifyInstall(probe({ env: { APPIMAGE: '/home/u/Apps/Capturia.AppImage' } }))).toBe('appimage');
    for (const packageType of ['deb', 'rpm', 'pacman'] as const) {
      expect(classifyInstall(probe({ packageType }))).toBe(packageType);
    }
  });

  it('classifies the channels a package manager owns', () => {
    expect(classifyInstall(probe({ platform: 'win32', windowsStore: true }))).toBe('store');
    expect(classifyInstall(probe({ env: { FLATPAK_ID: 'com.capturia.app' } }))).toBe('flatpak');
    expect(classifyInstall(probe({ hasFlatpakInfo: true }))).toBe('flatpak');
    expect(classifyInstall(probe({ env: { SNAP: '/snap/capturia/42', SNAP_REVISION: '42' } }))).toBe('snap');
    expect(classifyInstall(probe({ execPath: '/nix/store/abc-capturia/bin/capturia' }))).toBe('nix');
  });

  it('prefers the platform owner when both kinds of marker are present', () => {
    expect(classifyInstall(probe({ env: { FLATPAK_ID: 'x' }, packageType: 'deb' }))).toBe('flatpak');
    expect(classifyInstall(probe({ env: { SNAP: '/snap/x', SNAP_REVISION: '1' }, packageType: 'deb' }))).toBe('snap');
    expect(
      classifyInstall(probe({ execPath: '/nix/store/x/bin/capturia', env: { APPIMAGE: '/x.AppImage' } })),
    ).toBe('nix');
    expect(classifyInstall(probe({ platform: 'win32', windowsStore: true }))).toBe('store');
  });

  it('does not mistake a stray SNAP variable for a snap install', () => {
    expect(classifyInstall(probe({ env: { SNAP: '/snap/something' } }))).toBe('unknown');
  });

  it('returns unknown rather than guessing when a Linux build carries no marker', () => {
    expect(classifyInstall(probe())).toBe('unknown');
    expect(classifyInstall(probe({ packageType: 'tar.gz' }))).toBe('unknown');
  });
});

describe('ownsItsUpdates / platformOwnsUpdates', () => {
  const ALL = [
    'nsis',
    'dmg',
    'appimage',
    'deb',
    'rpm',
    'pacman',
    'store',
    'flatpak',
    'snap',
    'nix',
    'dev',
    'unknown',
  ] as const;

  it('allows self-update only for the artifacts we build and can replace', () => {
    for (const channel of ['nsis', 'dmg', 'appimage', 'deb', 'rpm', 'pacman'] as const) {
      expect(ownsItsUpdates(channel)).toBe(true);
    }
    for (const channel of ['store', 'flatpak', 'snap', 'nix', 'dev', 'unknown'] as const) {
      expect(ownsItsUpdates(channel)).toBe(false);
    }
  });

  it('is true exactly where a package manager keeps the app current', () => {
    for (const channel of ['store', 'flatpak', 'snap', 'nix'] as const) {
      expect(platformOwnsUpdates(channel)).toBe(true);
    }
    for (const channel of ['dev', 'unknown'] as const) {
      expect(platformOwnsUpdates(channel)).toBe(false);
    }
  });

  it('never claims both ownerships for the same channel', () => {
    for (const channel of ALL) {
      expect(ownsItsUpdates(channel) && platformOwnsUpdates(channel)).toBe(false);
    }
  });
});

describe('offersUpdateCheck', () => {
  it('offers nothing where a package manager owns the update', () => {
    for (const channel of ['store', 'flatpak', 'snap', 'nix'] as const) {
      expect(offersUpdateCheck(channel, { recording: false })).toBe(false);
      expect(offersUpdateCheck(channel, { recording: true })).toBe(false);
    }
  });

  it('offers the check on a copy that can update itself, except while recording', () => {
    for (const channel of ['nsis', 'dmg', 'appimage', 'deb', 'rpm', 'pacman', 'dev', 'unknown'] as const) {
      expect(offersUpdateCheck(channel, { recording: true })).toBe(false);
      expect(offersUpdateCheck(channel, { recording: false })).toBe(true);
    }
  });
});
