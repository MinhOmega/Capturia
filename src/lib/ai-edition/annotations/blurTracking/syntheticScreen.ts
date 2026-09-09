import {
	BLUR_TRACKER_TUNING,
	type GrayImage,
	type SourceRectPx,
	type TrackerFrame,
} from "./trackerCore";

/**
 * A drawable fake screen for the tracker tests: static chrome, a pane of
 * text-like rows that scrolls, and one marked cell whose position is known
 * exactly at every offset.
 *
 * It exists so the tracker can be driven over pixels with ground truth instead
 * of over a recording where "the right answer" is itself a measurement. Two
 * properties matter and both are deliberate:
 *
 * - the chrome does **not** move with the pane, so a tracker that correlates
 *   the whole frame instead of the patch's own columns fails these tests;
 * - rows are drawn from one small glyph alphabet in different orders, so they
 *   look alike the way real text does. That similarity is what the
 *   kill-criterion test in `trackerCore.test.ts` measures the score margin
 *   against; making the rows obviously different would make that test a lie.
 *
 * Test-only. Nothing in the app imports it.
 */

/** xorshift32. Small, fast, and identical on every machine, which is the point. */
function createRandom(seed: number): () => number {
	let state = seed >>> 0 || 0x9e3779b9;
	return () => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 0x1_0000_0000;
	};
}

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 9;
const GLYPH_ALPHABET_SIZE = 26;

/** One alphabet of glyph bitmaps, shared by every row, as a font would be. */
function buildAlphabet(seed: number): Uint8Array[] {
	const random = createRandom(seed);
	const glyphs: Uint8Array[] = [];
	for (let i = 0; i < GLYPH_ALPHABET_SIZE; i++) {
		const bitmap = new Uint8Array(GLYPH_WIDTH * GLYPH_HEIGHT);
		// A stem plus a few strokes: enough structure that two glyphs differ, few
		// enough dark pixels that a row reads as text rather than as a block.
		const stem = i % GLYPH_WIDTH;
		for (let y = 1; y < GLYPH_HEIGHT - 1; y++) bitmap[y * GLYPH_WIDTH + stem] = 1;
		const strokes = 2 + Math.floor(random() * 3);
		for (let s = 0; s < strokes; s++) {
			const y = 1 + Math.floor(random() * (GLYPH_HEIGHT - 2));
			const from = Math.floor(random() * GLYPH_WIDTH);
			const to = Math.min(GLYPH_WIDTH, from + 2 + Math.floor(random() * 3));
			for (let x = from; x < to; x++) bitmap[y * GLYPH_WIDTH + x] = 1;
		}
		glyphs.push(bitmap);
	}
	return glyphs;
}

export interface SyntheticScreenOptions {
	/** Source frame size. Defaults to a 1280x720 recording. */
	width?: number;
	height?: number;
	seed?: number;
	/** Rows in the scrolling pane. */
	rowCount?: number;
	rowHeight?: number;
	/** Index of the row the marked cell sits on. */
	cellRow?: number;
	/**
	 * Rows all get the same word lengths, so nothing but the glyph sequence
	 * tells them apart. This is the similar-rows case.
	 */
	uniformWordLengths?: boolean;
}

export interface RenderOptions {
	/** Source px the pane content has moved down. Negative scrolls up. */
	scrollY?: number;
	scrollX?: number;
	/** Gaussian noise standard deviation, in levels. */
	noise?: number;
	/** Seed for the noise, so a second render of the same frame is not the same noise. */
	noiseSeed?: number;
	/** A cursor blob drawn over the page. */
	cursor?: { x: number; y: number; size?: number } | null;
	/** Opaque panels over the page (a dropdown, a tooltip, a menu). */
	occluder?: SourceRectPx | SourceRectPx[] | null;
	/** Redraw the rows from a different glyph sequence, as a virtualised list would. */
	rerenderSeed?: number;
}

export interface SyntheticScreen {
	width: number;
	height: number;
	/** The marked cell at `scrollY = 0`. Its position at offset s is `y + s`. */
	cellRect: SourceRectPx;
	/** Where the marked cell is at a given scroll offset. */
	cellRectAt(scrollY: number, scrollX?: number): SourceRectPx;
	render(options?: RenderOptions): GrayImage;
}

const PAGE_BACKGROUND = 238;
const CHROME_BAR = 64;
const SIDEBAR = 206;
const PANE_BACKGROUND = 250;
const TEXT = 42;
const CELL_BACKGROUND = 222;

export function createSyntheticScreen(options: SyntheticScreenOptions = {}): SyntheticScreen {
	const width = options.width ?? 1280;
	const height = options.height ?? 720;
	const seed = options.seed ?? 12345;
	const rowHeight = options.rowHeight ?? 24;
	const rowCount = options.rowCount ?? 60;
	const cellRow = options.cellRow ?? 12;

	const chromeHeight = 48;
	const sidebarWidth = 160;
	const paneX = sidebarWidth + 24;
	const paneY = chromeHeight + 16;
	const paneWidth = width - paneX - 24;
	const paneHeight = height - paneY - 16;

	const alphabet = buildAlphabet(seed);

	/** Word lengths and glyph indices for one row, stable for a given glyph seed. */
	function rowWords(rowIndex: number, glyphSeed: number): number[][] {
		const random = createRandom((glyphSeed * 2654435761 + rowIndex * 40503) >>> 0);
		const words: number[][] = [];
		for (let w = 0; w < 6; w++) {
			const length = options.uniformWordLengths ? 4 + (w % 3) : 3 + Math.floor(random() * 6);
			const glyphs: number[] = [];
			for (let g = 0; g < length; g++) glyphs.push(Math.floor(random() * GLYPH_ALPHABET_SIZE));
			words.push(glyphs);
		}
		return words;
	}

	const cellRect: SourceRectPx = {
		x: paneX + 40,
		y: paneY + cellRow * rowHeight + 2,
		w: 220,
		h: rowHeight - 4,
	};

	function cellRectAt(scrollY: number, scrollX = 0): SourceRectPx {
		return { ...cellRect, x: cellRect.x + scrollX, y: cellRect.y + scrollY };
	}

	function render(renderOptions: RenderOptions = {}): GrayImage {
		const scrollY = renderOptions.scrollY ?? 0;
		const scrollX = renderOptions.scrollX ?? 0;
		const data = new Uint8Array(width * height);
		data.fill(PAGE_BACKGROUND);

		const setPixel = (x: number, y: number, value: number): void => {
			if (x < 0 || y < 0 || x >= width || y >= height) return;
			data[y * width + x] = value;
		};
		const fillRect = (
			x: number,
			y: number,
			w: number,
			h: number,
			value: number,
			clip?: { x0: number; y0: number; x1: number; y1: number },
		): void => {
			const x0 = Math.max(clip?.x0 ?? 0, Math.round(x));
			const y0 = Math.max(clip?.y0 ?? 0, Math.round(y));
			const x1 = Math.min(clip?.x1 ?? width, Math.round(x + w));
			const y1 = Math.min(clip?.y1 ?? height, Math.round(y + h));
			for (let py = y0; py < y1; py++) data.fill(value, py * width + x0, py * width + x1);
		};

		// Static chrome: a title bar with tabs and a sidebar with entries. None of
		// it moves with the pane.
		fillRect(0, 0, width, chromeHeight, CHROME_BAR);
		for (let tab = 0; tab < 5; tab++) fillRect(24 + tab * 140, 12, 120, 24, 96 + tab * 6);
		fillRect(0, chromeHeight, sidebarWidth, height - chromeHeight, SIDEBAR);
		for (let entry = 0; entry < 12; entry++) {
			fillRect(16, chromeHeight + 16 + entry * 40, 120, 14, 150 + ((entry * 7) % 40));
		}

		fillRect(paneX, paneY, paneWidth, paneHeight, PANE_BACKGROUND);

		const glyphSeed = renderOptions.rerenderSeed ?? seed;
		const paneRight = paneX + paneWidth;
		const paneBottom = paneY + paneHeight;
		for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
			const rowTop = paneY + rowIndex * rowHeight + scrollY;
			if (rowTop + rowHeight < paneY || rowTop > paneBottom) continue;
			if (rowIndex === cellRow) {
				// Clipped to the pane, like a real scroll container: a row scrolled
				// past the top edge is genuinely not on screen any more.
				fillRect(cellRect.x + scrollX, rowTop + 2, cellRect.w, cellRect.h, CELL_BACKGROUND, {
					x0: paneX,
					y0: paneY,
					x1: paneRight,
					y1: paneBottom,
				});
			}
			let penX = paneX + 16 + scrollX;
			const baseline = rowTop + Math.floor((rowHeight - GLYPH_HEIGHT) / 2);
			for (const word of rowWords(rowIndex, glyphSeed)) {
				for (const glyphIndex of word) {
					const bitmap = alphabet[glyphIndex];
					for (let gy = 0; gy < GLYPH_HEIGHT; gy++) {
						const py = baseline + gy;
						if (py < paneY || py >= paneBottom) continue;
						for (let gx = 0; gx < GLYPH_WIDTH; gx++) {
							if (!bitmap[gy * GLYPH_WIDTH + gx]) continue;
							const px = penX + gx;
							if (px < paneX || px >= paneRight) continue;
							setPixel(px, py, TEXT);
						}
					}
					penX += GLYPH_WIDTH + 1;
				}
				penX += 5;
			}
		}

		const occluders = renderOptions.occluder;
		for (const occluder of Array.isArray(occluders) ? occluders : occluders ? [occluders] : []) {
			fillRect(occluder.x, occluder.y, occluder.w, occluder.h, 30);
			// A panel with its own content, not a flat fill: a flat rectangle has no
			// variance and would flatter the tracker.
			for (let line = 0; line * 14 + 6 < occluder.h; line++) {
				fillRect(occluder.x + 6, occluder.y + 6 + line * 14, Math.max(8, occluder.w - 16), 6, 190);
			}
		}

		const cursor = renderOptions.cursor;
		if (cursor) {
			const size = cursor.size ?? 20;
			for (let dy = 0; dy < size; dy++) {
				for (let dx = 0; dx < size - dy; dx++) {
					setPixel(cursor.x + dx, cursor.y + dy, dx + dy < 2 ? 255 : 20);
				}
			}
		}

		const sigma = renderOptions.noise ?? 0;
		if (sigma > 0) {
			const random = createRandom((renderOptions.noiseSeed ?? 1) * 2246822519);
			for (let i = 0; i < data.length; i++) {
				// Box-Muller, one of the two outputs; deterministic for a given seed.
				const u1 = Math.max(1e-9, random());
				const u2 = random();
				const value = data[i] + Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma;
				data[i] = value < 0 ? 0 : value > 255 ? 255 : value | 0;
			}
		}

		return { data, width, height };
	}

	return { width, height, cellRect, cellRectAt, render };
}

/** Box-average downscale of a source rect into `outWidth x outHeight`. */
export function sampleGray(
	source: GrayImage,
	rect: SourceRectPx,
	outWidth: number,
	outHeight: number,
): GrayImage {
	const out = new Uint8Array(outWidth * outHeight);
	for (let j = 0; j < outHeight; j++) {
		const sy0 = rect.y + (j * rect.h) / outHeight;
		const sy1 = rect.y + ((j + 1) * rect.h) / outHeight;
		const fromY = Math.max(0, Math.min(source.height - 1, Math.floor(sy0)));
		const toY = Math.max(fromY + 1, Math.min(source.height, Math.ceil(sy1)));
		for (let i = 0; i < outWidth; i++) {
			const sx0 = rect.x + (i * rect.w) / outWidth;
			const sx1 = rect.x + ((i + 1) * rect.w) / outWidth;
			const fromX = Math.max(0, Math.min(source.width - 1, Math.floor(sx0)));
			const toX = Math.max(fromX + 1, Math.min(source.width, Math.ceil(sx1)));
			let total = 0;
			let count = 0;
			for (let y = fromY; y < toY; y++) {
				const row = y * source.width;
				for (let x = fromX; x < toX; x++) {
					total += source.data[row + x];
					count++;
				}
			}
			out[j * outWidth + i] = count > 0 ? Math.round(total / count) : 0;
		}
	}
	return { data: out, width: outWidth, height: outHeight };
}

/**
 * Wraps a full-resolution gray frame as a {@link TrackerFrame}, the way the
 * worker wraps a decoded `VideoFrame`.
 */
export function createTrackerFrame(source: GrayImage): TrackerFrame {
	const coarseWidth = Math.min(source.width, BLUR_TRACKER_TUNING.coarseWidth);
	const coarseHeight = Math.max(1, Math.round((source.height * coarseWidth) / source.width));
	const coarse = sampleGray(
		source,
		{ x: 0, y: 0, w: source.width, h: source.height },
		coarseWidth,
		coarseHeight,
	);
	return {
		sourceWidth: source.width,
		sourceHeight: source.height,
		coarse,
		sample: (rect, outWidth, outHeight) => sampleGray(source, rect, outWidth, outHeight),
	};
}
