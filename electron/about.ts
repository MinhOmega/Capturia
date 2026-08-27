// What the About box says, kept out of the dialog that shows it (ported from
// OpenScreen). Every fact is passed in rather than read from `app`/`process`,
// so the string can be pinned in a test from any platform.

import { GITHUB_REPO_URL } from '../src/lib/supportLinks';
import type { InstallChannel } from './install-channel';

export const WEBSITE_URL = GITHUB_REPO_URL;
/**
 * The brand spelling, for the surfaces we render ourselves. NOT `app.name`,
 * which is electron-builder's `productName` when packaged and package.json's
 * `name` ("capturia") in dev.
 */
export const PRODUCT_NAME = 'Capturia';
/**
 * Must stay byte-identical to `copyright` in electron-builder.json5, which
 * feeds Info.plist's NSHumanReadableCopyright and the Windows LegalCopyright
 * (about.test.ts pins that).
 */
export const COPYRIGHT = '© 2025-2026 MinhOmega and contributors — MIT License';

/** macOS opens its own About panel (the app menu's `role: "about"`); everywhere else we build a message box. */
export function usesNativeAboutPanel(platform: NodeJS.Platform): boolean {
  return platform === 'darwin';
}

export interface AboutFacts {
  version: string;
  channel: InstallChannel;
  platform: NodeJS.Platform;
  arch: string;
  electron: string;
  chrome: string;
  node: string;
}

/**
 * The block under "Capturia <version>". Untranslated on purpose: every line is
 * a version number, a platform identifier or a URL, and a pasted bug report
 * reads the same whatever locale the reporter runs. `COPYRIGHT` is not part
 * of it: the macOS panel has its own field for that line.
 */
export function formatAboutDetail(facts: AboutFacts): string {
  return [
    `Electron ${facts.electron} · Chromium ${facts.chrome} · Node ${facts.node}`,
    `${facts.platform} ${facts.arch} · ${facts.channel}`,
    WEBSITE_URL,
  ].join('\n');
}
