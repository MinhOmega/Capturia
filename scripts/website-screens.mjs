#!/usr/bin/env node
/**
 * Real screenshots of the 2.1 features, for website/static/img/screens/.
 *
 *   npx vite build && node scripts/website-screens.mjs
 *
 * Drives the packaged renderer inside a real Electron launch (same
 * `_electron.launch` the e2e specs use), against a throwaway `--user-data-dir`
 * seeded with one demo project. Nothing here mocks the UI: the documents go
 * through the real DocumentService over the real native bridge, the posters are
 * real ffmpeg grabs, and the speech-model cards are whatever `stt:models`
 * reports.
 *
 * Environment notes, all learned the hard way on GNOME/Wayland + Intel Arc:
 *  · `--disable-gpu --disable-gpu-compositing` or the app exits on launch.
 *  · The HUD window is born click-through (`setIgnoreMouseEvents`) and produces
 *    no frames while it is, so every screenshot of it times out. Taking it out
 *    of click-through and focusing it first is what makes it capturable.
 *  · `desktopCapturer.getSources` never returns on this session, so the source
 *    picker's Screens/Windows/Area cards cannot be shot here — and the Area tab
 *    is hidden on Linux regardless (see `offerArea` in SourceSelector.tsx). The
 *    area overlay itself is renderer-only, so that is what `area` captures.
 *
 * `--only=a,b` limits the run to named shots while iterating.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "website", "static", "img", "screens");
// Absolute: `ffmpegCandidates` rejects a bare name, and the poster grabs go silent
// rather than loud when it does.
const FFMPEG =
	process.env.CAPTURIA_FFMPEG_PATH ??
	execFileSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"])
		.toString()
		.trim()
		.split(/\r?\n/)[0];
/** Source frame for the demo recording: a real screen-capture still already in the repo. */
const DEMO_FRAME = path.join(ROOT, "website", "static", "img", "walkthrough", "canvas-poster.jpg");
const DEMO_SEC = 48;
/** Moments "flagged while recording", written as the sidecar the HUD's flag button writes. */
const DEMO_FLAGS_MS = [6_200, 17_800, 31_400, 41_000];
const VIEWPORT = { width: 1440, height: 900 };

const only = process.argv
	.find((a) => a.startsWith("--only="))
	?.slice(7)
	.split(",");
const wanted = (name) => !only || only.includes(name);

for (const f of ["dist-electron/main.js", "dist/index.html"]) {
	if (!fs.existsSync(path.join(ROOT, f)))
		throw new Error(`Missing ${f} — run \`npx vite build\` first.`);
}
fs.mkdirSync(OUT, { recursive: true });

// --- throwaway profile -------------------------------------------------------
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "capturia-screens-"));
// Where "Save recordings to" will point. A named directory rather than the
// default under userData, so the setting shows a path a reader can recognise.
const recordingsDir = path.join(os.tmpdir(), "Capturia");
fs.mkdirSync(recordingsDir, { recursive: true });
fs.writeFileSync(
	path.join(userData, "recording-settings.json"),
	`${JSON.stringify({ recordingsFolder: recordingsDir })}\n`,
);
// The editor restores its own saved bounds, so ask for the viewport there rather
// than fighting a maximised window afterwards.
fs.writeFileSync(
	path.join(userData, "editor-window.json"),
	JSON.stringify({ x: 60, y: 40, ...VIEWPORT, maximized: false }),
);

// --- demo recording ----------------------------------------------------------
const demoVideo = path.join(recordingsDir, "Status page walkthrough.webm");
if (!fs.existsSync(demoVideo)) {
	execFileSync(FFMPEG, [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-loop",
		"1",
		"-framerate",
		"30",
		"-t",
		String(DEMO_SEC),
		"-i",
		DEMO_FRAME,
		"-c:v",
		"libvpx-vp9",
		"-b:v",
		"300k",
		"-pix_fmt",
		"yuv420p",
		demoVideo,
	]);
}
fs.writeFileSync(
	`${demoVideo}.markers.json`,
	JSON.stringify({ version: 1, markers: DEMO_FLAGS_MS }),
);

// --- launch ------------------------------------------------------------------
const app = await electron.launch({
	args: [
		path.join(ROOT, "dist-electron/main.js"),
		"--no-sandbox",
		"--disable-gpu",
		"--disable-gpu-compositing",
		"--lang=en-US",
		`--user-data-dir=${userData}`,
	],
	env: {
		...process.env,
		ELECTRON_USER_DATA_DIR: userData,
		CAPTURIA_FFMPEG_PATH: FFMPEG,
		HEADLESS: "false",
		LANG: "en_US.UTF-8",
		LC_ALL: "en_US.UTF-8",
		LANGUAGE: "en_US",
	},
	cwd: ROOT,
	timeout: 60_000,
});
app.process().stderr?.on("data", (d) => {
	if (process.env.VERBOSE) process.stderr.write(`[electron] ${d}`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const written = [];
async function shot(target, name, options = {}) {
	const file = path.join(OUT, `${name}.png`);
	await target.screenshot({ path: file, timeout: 30_000, ...options });
	written.push([name, fs.statSync(file).size]);
	console.log(`  → ${name}.png (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
}

/** A window that is click-through or unfocused never paints, and every capture of it hangs. */
async function makeCapturable(urlPart) {
	await app.evaluate(({ BrowserWindow }, part) => {
		const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(part));
		if (!win) return;
		win.setIgnoreMouseEvents(false);
		win.show();
		win.focus();
		win.moveTop();
	}, urlPart);
}

const hud = await app.firstWindow({ timeout: 60_000 });
await hud.waitForLoadState("domcontentloaded");
await sleep(2_500);

/** One native-bridge call, unwrapped the way `src/native/client.ts` unwraps it. */
const bridge = (action, payload) =>
	hud
		.evaluate(
			([a, p]) =>
				window.electronAPI.invokeNativeBridge({ domain: "aiEdition", action: a, payload: p }),
			[action, payload],
		)
		.then((r) => {
			if (!r?.ok) throw new Error(`${action}: ${r?.error?.message ?? "bridge call failed"}`);
			return r.data;
		});

/** Create a project, attach `video`, and place it on the timeline as one clip. */
async function seedProject(title, video, durationSec) {
	const created = await bridge("document.create", { title });
	const id = created.document.project.id;
	const added = await bridge("document.addAsset", { projectId: id, path: video, label: title });
	const doc = added.document;
	const asset = doc.assets.at(-1);
	asset.durationSec = durationSec;
	asset.video = { codec: "vp9", width: 872, height: 490, fps: 30 };
	doc.timeline.clips = [
		{
			id: `clip_${id}`,
			assetId: asset.id,
			sourceStartSec: 0,
			sourceEndSec: durationSec,
			timelineStartSec: 0,
			timelineEndSec: durationSec,
			wordRefs: [],
			origin: "system",
			reason: "",
		},
	];
	await bridge("document.save", { document: doc });
	return id;
}

try {
	// (f) Settings → Save recordings to. -------------------------------------
	if (wanted("recordings-folder")) {
		await makeCapturable("hud-overlay");
		await hud.evaluate(() =>
			document.querySelector("[data-testid='launch-device-settings-button']").click(),
		);
		const folder = hud.getByTestId("hud-recordings-folder");
		await folder.waitFor({ timeout: 15_000 });
		await folder.evaluate((el) => el.scrollIntoView({ block: "end" }));
		await sleep(500);
		// The capture settings above the row are the context that says "Settings",
		// but the panel also holds a LIVE WEBCAM PREVIEW. Clip to the rows just
		// above the folder so that never reaches the website.
		const panelBox = await hud.getByTestId("hud-device-settings").boundingBox();
		const folderBox = await folder.boundingBox();
		await shot(hud, "recordings-folder", {
			clip: {
				x: panelBox.x,
				y: Math.max(panelBox.y, folderBox.y - 150),
				width: panelBox.width,
				height:
					Math.min(folderBox.y + folderBox.height, panelBox.y + panelBox.height) -
					Math.max(panelBox.y, folderBox.y - 150),
			},
		});
		await hud.evaluate(() =>
			document.querySelector("[data-testid='hud-device-settings'] button").click(),
		);
	}

	// (a) The area overlay you drag a region out on. --------------------------
	if (wanted("area")) {
		await app.evaluate(
			async ({ BrowserWindow }, { root, vp }) => {
				const win = new BrowserWindow({
					...vp,
					show: true,
					backgroundColor: "#000000",
					webPreferences: { preload: `${root}/dist-electron/preload.mjs`, contextIsolation: true },
				});
				await win.loadFile(`${root}/dist/index.html`, {
					query: { windowType: "area-selector", displayId: "screens" },
				});
			},
			{ root: ROOT, vp: VIEWPORT },
		);
		const area = app.windows().find((w) => w.url().includes("area-selector"));
		if (area) {
			await area.waitForLoadState("domcontentloaded");
			await makeCapturable("area-selector");
			await sleep(1_500);
			// Drag the region out, exactly as a user does.
			await area.mouse.move(210, 150);
			await area.mouse.down();
			await area.mouse.move(1150, 680, { steps: 20 });
			await area.mouse.up();
			await sleep(800);
			await shot(area, "area-recording");
			await app.evaluate(({ BrowserWindow }) => {
				BrowserWindow.getAllWindows()
					.find((w) => w.webContents.getURL().includes("area-selector"))
					?.destroy();
			});
		}
	}

	// --- seed the projects the editor shots need -----------------------------
	await seedProject("Onboarding tour", demoVideo, DEMO_SEC);
	await seedProject("Release notes 2.1", demoVideo, DEMO_SEC);
	await seedProject("Status page walkthrough", demoVideo, DEMO_SEC);

	// switchToEditor closes the HUD page under the evaluate, so it can reject.
	await hud.evaluate(() => window.electronAPI.switchToEditor()).catch(() => undefined);
	const ed = await app.waitForEvent("window", {
		predicate: (w) => w.url().includes("windowType=editor"),
		timeout: 30_000,
	});
	await ed.waitForLoadState("domcontentloaded");
	// The WM hands back a frame size, not a content size, so converge on it.
	for (let i = 0; i < 4; i++) {
		const [w, h] = await ed.evaluate(() => [innerWidth, innerHeight]);
		if (w === VIEWPORT.width && h === VIEWPORT.height) break;
		await app.evaluate(
			({ BrowserWindow }, d) => {
				const win = BrowserWindow.getAllWindows().find((x) =>
					x.webContents.getURL().includes("windowType=editor"),
				);
				const [cw, ch] = win.getContentSize();
				win.setContentSize(cw + d[0], ch + d[1]);
				win.focus();
			},
			[VIEWPORT.width - w, VIEWPORT.height - h],
		);
		await sleep(600);
	}
	await makeCapturable("windowType=editor");
	await ed.waitForSelector("[data-clip-id]", { timeout: 45_000 });
	await sleep(3_000);

	/** Radix renders both popovers into this wrapper; clip around it with room for context. */
	const popover = ed.locator("[data-radix-popper-content-wrapper]").last();
	const around = async (locator, pad) => {
		const b = await locator.boundingBox();
		const x = Math.max(0, b.x - pad.left);
		const y = Math.max(0, b.y - pad.top);
		return {
			x,
			y,
			width: Math.min(VIEWPORT.width - x, b.width + pad.left + pad.right),
			height: Math.min(VIEWPORT.height - y, b.height + pad.top + pad.bottom),
		};
	};

	// (b) Saved looks — saved through the menu itself, so the list is real. -----
	if (wanted("saved-looks")) {
		const looks = ed.getByLabel("Saved looks").first();
		const nameField = ed.getByLabel("Preset name");
		const openLooks = async () => {
			for (let i = 0; i < 5; i++) {
				if (await nameField.isVisible().catch(() => false)) return;
				await looks.click();
				await sleep(800);
			}
			throw new Error("the saved-looks menu would not stay open");
		};
		for (const name of ["Docs — light frame", "Product demo"]) {
			await openLooks();
			await nameField.fill(name);
			await nameField.press("Enter");
			await sleep(1_000);
		}
		await openLooks();
		// Star the first one as the default for new projects.
		await ed.getByLabel("Default for new projects").first().click();
		await sleep(800);
		await shot(ed, "saved-looks", {
			clip: await around(popover, { left: 300, right: 20, top: 70, bottom: 30 }),
		});
		await ed.keyboard.press("Escape");
		await sleep(400);
	}

	// (g) Auto-enhance, with the flag pass live because the sidecar is real. ---
	const autoEnhance = ed.getByRole("button", { name: "Auto-enhance" });
	const flagZooms = ed.getByText("Zooms at flagged moments");
	if (wanted("auto-enhance")) {
		await autoEnhance.click();
		await sleep(800);
		await shot(ed, "auto-enhance", {
			clip: await around(popover, { left: 20, right: 40, top: 60, bottom: 40 }),
		});
		await ed.keyboard.press("Escape");
		await sleep(400);
	}

	// (g) …and what "Zooms at flagged moments" leaves on the timeline.
	if (wanted("flag-zooms")) {
		if (!(await flagZooms.isVisible())) await autoEnhance.click();
		await flagZooms.click();
		await sleep(3_000);
		const tools = await ed.getByRole("toolbar", { name: "Timeline tools" }).boundingBox();
		const tracks = await ed.locator('[class*="tlTracks"]').first().boundingBox();
		await shot(ed, "flag-zooms", {
			clip: {
				x: 0,
				y: tools.y - 10,
				width: VIEWPORT.width,
				height: Math.min(VIEWPORT.height, tracks.y + tracks.height + 10) - (tools.y - 10),
			},
		});
	}

	// (c) Right-click menu on a region pill. -----------------------------------
	if (wanted("region-menu")) {
		const pill = ed.locator("[data-pill-id]").first();
		await pill.click({ button: "right" });
		await sleep(800);
		await shot(ed, "region-menu", {
			clip: await around(ed.locator('[role="menu"]').last(), {
				left: 200,
				right: 200,
				top: 90,
				bottom: 30,
			}),
		});
		await ed.keyboard.press("Escape");
		await sleep(400);
	}

	// (d) Project list, posters grabbed by ffmpeg in main. ---------------------
	if (wanted("project-posters")) {
		await ed.getByLabel("Open project").click();
		await sleep(3_000);
		await shot(ed.getByRole("dialog"), "project-posters");
		await ed.keyboard.press("Escape");
		await sleep(400);
	}

	// (e) AI settings → Speech model. ------------------------------------------
	if (wanted("speech-model")) {
		await ed.getByRole("button", { name: "Capturia" }).click();
		await sleep(600);
		await ed.getByRole("menuitem", { name: "AI settings" }).click();
		await sleep(2_000);
		const section = ed.getByTestId("speech-model-settings");
		await section.scrollIntoViewIfNeeded();
		await sleep(600);
		await shot(section, "speech-model");
	}
} finally {
	await app.close().catch(() => undefined);
	fs.rmSync(userData, { recursive: true, force: true });
}

// Neither sharp nor pngquant is installed here, so the clips above are the whole
// size budget: every shot is cropped to the surface it documents.
console.log("\nwritten:");
for (const [name] of written) {
	console.log(
		`  ${name}.png  ${(fs.statSync(path.join(OUT, `${name}.png`)).size / 1024).toFixed(0)} KB`,
	);
}
