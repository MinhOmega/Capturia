// What the About box says, kept out of the dialog that shows it. Every fact is passed in
// rather than read from `app`/`process`, so the string can be pinned in a test from any
// platform — the same reason install-channel.ts takes an `InstallProbe`.
//
// The install channel is in there deliberately: it is the single fact that explains why a
// copy does or does not offer "Check for Updates" (see install-channel.ts), and the first
// thing worth knowing about a bug report from a build we did not install ourselves.

import type { InstallChannel } from "./install-channel";

export const WEBSITE_URL = "https://github.com/MinhOmega/Capturia";
/** The brand spelling, for the surfaces we render ourselves. NOT `app.name`: that resolves to
 *  electron-builder's `productName` ("Capturia") when packaged and to package.json's `name`
 *  ("capturia") in dev, so the About box would disagree with its own title bar. */
export const PRODUCT_NAME = "Capturia";
/** The collective form, and deliberately NOT the whole of LICENSE. Capturia is a fork of
 *  OpenScreen, so this binary contains both sides' code and the line names both: MIT obliges us
 *  to keep the upstream notice on a codebase that still contains upstream's work, and dropping it
 *  here would put an attribution on the binary that the LICENSE shipping beside it contradicts.
 *
 *  "contributors" on both sides and not the project names: MinhOmega/Capturia and getopenscreen
 *  are GitHub accounts, not legal entities, and copyright cannot vest in something that does not
 *  exist. Each author keeps their own; this is shorthand for all of them.
 *
 *  Must stay byte-identical to `copyright` in electron-builder.json5, which feeds Info.plist's
 *  NSHumanReadableCopyright and the Windows LegalCopyright — about.test.ts reads that file and
 *  pins the two together. That key is declared explicitly BECAUSE electron-builder otherwise
 *  derives those from package.json's `author` — a single name, which put a second attribution on
 *  the same binary this string appears in. */
export const COPYRIGHT =
	"© 2025-2026 Capturia contributors — MIT License. Includes OpenScreen, © 2025-2026 OpenScreen contributors.";

/** macOS opens its own About panel (the app menu's `role: "about"`), so it is the one platform
 *  that must not be shown the message box we build, and the only one whose panel needs
 *  populating up front. Pure so both branches can be pinned from a Linux-only CI. */
export function usesNativeAboutPanel(platform: NodeJS.Platform): boolean {
	return platform === "darwin";
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

/** The block under "Capturia <version>". Untranslated on purpose: every line is a version
 *  number, a platform identifier or a URL, and a pasted bug report reads the same whatever
 *  locale the reporter runs.
 *
 *  `COPYRIGHT` is deliberately NOT part of it: the macOS About panel has its own field for
 *  that line, and putting it here too would print it twice on the one platform that asked
 *  for it separately. The surface that shows the box adds it. */
export function formatAboutDetail(facts: AboutFacts): string {
	return [
		`Electron ${facts.electron} · Chromium ${facts.chrome} · Node ${facts.node}`,
		`${facts.platform} ${facts.arch} · ${facts.channel}`,
		WEBSITE_URL,
	].join("\n");
}
