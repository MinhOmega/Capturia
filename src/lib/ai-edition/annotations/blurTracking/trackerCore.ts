/**
 * The blur content tracker: given the rectangle a user drew at one instant, it
 * says where those pixels are at every later (or earlier) instant, or that they
 * are not visible.
 *
 * Motion model is **translation only**. Scrolling and window dragging move a
 * rigid patch; a resize or a browser zoom changes scale and is out of scope
 * (the track goes lost and the user corrects it). Nothing here touches the DOM,
 * a canvas or a clock: it is pure functions and one small state machine over
 * grayscale `Uint8Array`s, so the node lane can drive it with synthetic frames
 * and two runs over the same pixels produce identical output.
 *
 * Pipeline per analysed frame (`docs/specs/tracked-blur-regions.md` §1.3):
 *   1. gradient projection profiles of a band around the patch, correlated
 *      against the previous frame's, give a handful of shift candidates
 *      cheaply — scroll is a one-dimensional problem most of the time;
 *   2. zero-mean NCC of the *anchor* template verifies each candidate in a
 *      +/-3 px window at a patch-dependent scale, with quadrant scores for
 *      partial occlusion;
 *   3. a state machine turns the best score into found / tentative / lost.
 *
 * The template is never drift-updated. Screen content does not deform: it is
 * either the same pixels or not there, and a template that follows the match
 * is the classic way to walk off the content one pixel at a time (§1.10).
 */

/** A single-channel 8-bit image. `data.length === width * height`. */
export interface GrayImage {
	data: Uint8Array;
	width: number;
	height: number;
}

/** A rectangle in source pixels. May be fractional. */
export interface SourceRectPx {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * One decoded frame, in the two forms the tracker reads it: a whole-frame
 * thumbnail for the profile stage, and an on-demand crop for the NCC stage.
 * In the worker both are `OffscreenCanvas` draws; in tests both come from a
 * synthetic full-resolution array.
 */
export interface TrackerFrame {
	sourceWidth: number;
	sourceHeight: number;
	/** The whole frame, gray, at `BLUR_TRACKER_TUNING.coarseWidth`. */
	coarse: GrayImage;
	/**
	 * Gray pixels of `rect` (source px) drawn into `outWidth x outHeight`.
	 * `rect` is always inside the frame and both output sizes are >= 1.
	 */
	sample(rect: SourceRectPx, outWidth: number, outHeight: number): GrayImage;
}

/**
 * Every threshold the tracker uses, in one object so the tests and the
 * benchmark reference the same numbers the code does. None of it is
 * user-facing.
 */
export const BLUR_TRACKER_TUNING = {
	/** Width the whole frame is analysed at; height follows the aspect. */
	coarseWidth: 480,
	/** Grid interval, ms. */
	sampleIntervalMs: 100,
	/** Margin around the patch in the fine window, at fine scale. */
	fineMargin: 8,
	/** NCC refinement radius around each candidate, fine px. */
	refineRadius: 3,
	/** Below this template standard deviation the patch has nothing to track. */
	minTemplateStdDev: 6,
	/** A patch is never analysed below this many pixels on its short side. */
	minPatchSide: 16,
	/** ...nor below this on its long side. */
	minPatchLongSide: 48,
	/** Template area above which the patch scale steps down again, bounding NCC cost. */
	maxTemplatePixels: 160 * 96,
	/** Whole-patch NCC at or above this is a match. */
	foundScore: 0.7,
	/** A single quadrant this good rescues a mostly-occluded patch... */
	quadrantFoundScore: 0.8,
	/** ...as long as the whole patch is at least this similar. */
	quadrantWholeFloor: 0.3,
	/** Below this the content is gone, not merely disturbed. */
	tentativeScore: 0.45,
	/** Consecutive tentative samples before the track is declared lost. */
	maxTentativeStreak: 3,
	/** Re-acquisition needs this at the coarse scale... */
	reacquireCoarseScore: 0.8,
	/** ...and this at the fine scale. Stricter than FOUND on purpose. */
	reacquireFineScore: 0.75,
	/** A full 2-D coarse sweep runs every Nth lost sample. */
	reacquireFullSweepEvery: 5,
	/** Half-width of the 1-D re-acquisition search in x, coarse px. */
	reacquireColumnRadius: 4,
	/** Profile correlation below this is not a candidate. */
	minProfileCorrelation: 0.5,
	/** Profile shift candidates kept per axis. */
	verticalCandidates: 6,
	horizontalCandidates: 3,
	/** Upper bound on candidate offsets the coarse screening stage looks at. */
	maxCandidates: 24,
	/** Candidates that survive screening and get the full fine-scale refinement. */
	maxFineCandidates: 4,
	/** Half-width of the ranking pass around each candidate, screen px. */
	screenRadius: 1,
	/**
	 * Largest screening template the tracker will match, in pixels. The frame's
	 * coarse width is fixed at 480, so on a 480-wide recording the "coarse"
	 * scale is 1:1 and a wide patch makes the screening pass cost more than the
	 * fine pass it exists to cheapen. Another octave or two of downscale, chosen
	 * per patch, keeps it a screening stage.
	 */
	maxScreenTemplatePixels: 1024,
	/** The screening template is never taken below this on its short side. */
	minScreenTemplateSide: 4,
	/**
	 * Half-width of the relocation pass around each surviving candidate, coarse
	 * px. Wide enough that an axis whose profile peak was missed is still found
	 * from the other axis's candidate.
	 */
	screenRefineRadius: 4,
	/** Scores within this of the best are resolved towards the velocity prediction. */
	tieMargin: 0.05,
	/** Overlap shorter than this fraction of the profile is not scored. */
	minProfileOverlap: 0.25,
	/** Largest fine window the tracker will read, per axis, fine px. */
	maxFineWindow: 1400,
} as const;

export type TrackerState = "found" | "tentative" | "lost";

/** One analysed instant. Positions are the patch top-left in source pixels. */
export interface TrackerSample {
	timeMs: number;
	x: number;
	y: number;
	w: number;
	h: number;
	state: TrackerState;
	/** Whole-patch NCC of the winning offset, -1..1. */
	score: number;
	/** Best of the four quadrant NCCs at the winning offset. */
	maxQuadrantScore: number;
	/** This sample ended a lost span. The keyframe for it is pre-rolled one grid interval. */
	reacquired: boolean;
}

/** Opaque state of a tracker at one instant. See {@link BlurTracker.snapshot}. */
export interface TrackerSnapshot {
	x: number;
	y: number;
	velocityX: number;
	velocityY: number;
	state: TrackerState;
	tentativeStreak: number;
	lostSampleCount: number;
	lastTimeMs: number;
	previousCoarse: GrayImage | null;
}

export type TrackerCreateResult =
	| { ok: true; tracker: BlurTracker }
	| { ok: false; reason: "low-detail"; stdDev: number }
	| { ok: false; reason: "degenerate-rect"; stdDev: number }

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

/** Rec.601 luma with integer weights: `(77R + 150G + 29B) >> 8`. */
export function rgbaToGray(
	rgba: Uint8ClampedArray | Uint8Array,
	width: number,
	height: number,
): GrayImage {
	const data = new Uint8Array(width * height);
	for (let i = 0, p = 0; i < data.length; i++, p += 4) {
		data[i] = (77 * rgba[p] + 150 * rgba[p + 1] + 29 * rgba[p + 2]) >> 8;
	}
	return { data, width, height };
}

/**
 * 3x3 box filter with clamped borders. Suppresses compression ringing, which
 * is most of what separates two decodes of the same content, at a cost that
 * does not show up next to the NCC.
 */
export function boxBlur3(image: GrayImage): GrayImage {
	const { width, height, data } = image;
	if (width < 3 || height < 3) return { data: new Uint8Array(data), width, height };
	const out = new Uint8Array(width * height);
	const rowSum = new Uint16Array(width);
	for (let y = 0; y < height; y++) {
		const y0 = y === 0 ? 0 : y - 1;
		const y1 = y === height - 1 ? height - 1 : y + 1;
		for (let x = 0; x < width; x++) {
			rowSum[x] = data[y0 * width + x] + data[y * width + x] + data[y1 * width + x];
		}
		for (let x = 0; x < width; x++) {
			const x0 = x === 0 ? 0 : x - 1;
			const x1 = x === width - 1 ? width - 1 : x + 1;
			out[y * width + x] = ((rowSum[x0] + rowSum[x] + rowSum[x1]) / 9) | 0;
		}
	}
	return { data: out, width, height };
}

/** 2x2 box downscale. Odd edges keep their own pixels rather than being dropped. */
export function halveGray(image: GrayImage): GrayImage {
	const width = Math.max(1, image.width >> 1);
	const height = Math.max(1, image.height >> 1);
	const out = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		const row0 = 2 * y * image.width;
		const row1 = Math.min(image.height - 1, 2 * y + 1) * image.width;
		for (let x = 0; x < width; x++) {
			const x0 = 2 * x;
			const x1 = Math.min(image.width - 1, x0 + 1);
			out[y * width + x] =
				(image.data[row0 + x0] +
					image.data[row0 + x1] +
					image.data[row1 + x0] +
					image.data[row1 + x1] +
					2) >>
				2;
		}
	}
	return { data: out, width, height };
}

interface Integrals {
	sum: Float64Array;
	sumSq: Float64Array;
	stride: number;
}

/** Summed-area tables of an image and its square, padded by one row/column of zeros. */
export function integralImages(image: GrayImage): Integrals {
	const { width, height, data } = image;
	const stride = width + 1;
	const sum = new Float64Array(stride * (height + 1));
	const sumSq = new Float64Array(stride * (height + 1));
	for (let y = 0; y < height; y++) {
		let rowSum = 0;
		let rowSumSq = 0;
		const src = y * width;
		const dst = (y + 1) * stride;
		const above = y * stride;
		for (let x = 0; x < width; x++) {
			const value = data[src + x];
			rowSum += value;
			rowSumSq += value * value;
			sum[dst + x + 1] = sum[above + x + 1] + rowSum;
			sumSq[dst + x + 1] = sumSq[above + x + 1] + rowSumSq;
		}
	}
	return { sum, sumSq, stride };
}

function areaSum(
	table: Float64Array,
	stride: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): number {
	return (
		table[y1 * stride + x1] -
		table[y0 * stride + x1] -
		table[y1 * stride + x0] +
		table[y0 * stride + x0]
	);
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

interface Quadrant {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	sum: number;
	sumSq: number;
	count: number;
}

interface Template {
	image: GrayImage;
	sum: number;
	sumSq: number;
	count: number;
	stdDev: number;
	quadrants: Quadrant[];
}

function buildTemplate(image: GrayImage): Template {
	const { width, height, data } = image;
	const midX = Math.max(1, Math.min(width - 1, width >> 1));
	const midY = Math.max(1, Math.min(height - 1, height >> 1));
	const bounds =
		width >= 2 && height >= 2
			? [
					{ x0: 0, y0: 0, x1: midX, y1: midY },
					{ x0: midX, y0: 0, x1: width, y1: midY },
					{ x0: 0, y0: midY, x1: midX, y1: height },
					{ x0: midX, y0: midY, x1: width, y1: height },
				]
			: [{ x0: 0, y0: 0, x1: width, y1: height }];

	const quadrants: Quadrant[] = bounds.map((b) => {
		let sum = 0;
		let sumSq = 0;
		for (let y = b.y0; y < b.y1; y++) {
			const row = y * width;
			for (let x = b.x0; x < b.x1; x++) {
				const value = data[row + x];
				sum += value;
				sumSq += value * value;
			}
		}
		return { ...b, sum, sumSq, count: (b.x1 - b.x0) * (b.y1 - b.y0) };
	});

	let sum = 0;
	let sumSq = 0;
	for (let i = 0; i < data.length; i++) {
		sum += data[i];
		sumSq += data[i] * data[i];
	}
	const count = data.length;
	const mean = sum / count;
	const variance = Math.max(0, sumSq / count - mean * mean);
	return { image, sum, sumSq, count, stdDev: Math.sqrt(variance), quadrants };
}

function correlationFrom(
	cross: number,
	sumT: number,
	sumSqT: number,
	sumF: number,
	sumSqF: number,
	count: number,
): number {
	if (count <= 0) return 0;
	const meanT = sumT / count;
	const meanF = sumF / count;
	const varT = sumSqT / count - meanT * meanT;
	const varF = sumSqF / count - meanF * meanF;
	if (varT <= 1e-9 || varF <= 1e-9) return 0;
	const covariance = cross / count - meanT * meanF;
	const value = covariance / Math.sqrt(varT * varF);
	return value > 1 ? 1 : value < -1 ? -1 : value;
}

export interface NccScores {
	whole: number;
	maxQuadrant: number;
}

/**
 * Zero-mean NCC of `template` against `window` with the template's top-left at
 * `(u, v)`. The window's mean and variance at that offset come from the
 * integral images, so only the cross term costs `O(N)`.
 *
 * This is the inner loop of the whole feature: it runs at every refined offset
 * of every candidate of every analysed frame, so it stays flat and allocates
 * nothing. The quadrant breakdown is a separate call made once, at the winner.
 */
export function nccWhole(
	template: Template,
	window: GrayImage,
	integrals: Integrals,
	u: number,
	v: number,
): number {
	const t = template.image;
	const tw = t.width;
	const th = t.height;
	if (u < 0 || v < 0 || u + tw > window.width || v + th > window.height) return -1;

	const templateData = t.data;
	const windowData = window.data;
	const windowWidth = window.width;
	let cross = 0;
	for (let y = 0; y < th; y++) {
		const tRow = y * tw;
		const wRow = (y + v) * windowWidth + u;
		for (let x = 0; x < tw; x++) cross += templateData[tRow + x] * windowData[wRow + x];
	}

	const { sum, sumSq, stride } = integrals;
	return correlationFrom(
		cross,
		template.sum,
		template.sumSq,
		areaSum(sum, stride, u, v, u + tw, v + th),
		areaSum(sumSq, stride, u, v, u + tw, v + th),
		template.count,
	);
}

/**
 * The whole-patch score and the best of the four quadrant scores at one
 * offset. The quadrant scores are what keep a blur on when a dropdown covers
 * three quarters of the patch and the remaining quarter is clearly the same
 * content; they are only needed at the offset that won.
 */
export function nccAt(
	template: Template,
	window: GrayImage,
	integrals: Integrals,
	u: number,
	v: number,
): NccScores {
	const t = template.image;
	if (u < 0 || v < 0 || u + t.width > window.width || v + t.height > window.height) {
		return { whole: -1, maxQuadrant: -1 };
	}

	const { sum, sumSq, stride } = integrals;
	let wholeCross = 0;
	let maxQuadrant = -1;
	for (const quadrant of template.quadrants) {
		let cross = 0;
		for (let y = quadrant.y0; y < quadrant.y1; y++) {
			const tRow = y * t.width;
			const wRow = (y + v) * window.width + u;
			for (let x = quadrant.x0; x < quadrant.x1; x++) {
				cross += t.data[tRow + x] * window.data[wRow + x];
			}
		}
		wholeCross += cross;
		const score = correlationFrom(
			cross,
			quadrant.sum,
			quadrant.sumSq,
			areaSum(sum, stride, quadrant.x0 + u, quadrant.y0 + v, quadrant.x1 + u, quadrant.y1 + v),
			areaSum(sumSq, stride, quadrant.x0 + u, quadrant.y0 + v, quadrant.x1 + u, quadrant.y1 + v),
			quadrant.count,
		);
		if (score > maxQuadrant) maxQuadrant = score;
	}

	const whole = correlationFrom(
		wholeCross,
		template.sum,
		template.sumSq,
		areaSum(sum, stride, u, v, u + t.width, v + t.height),
		areaSum(sumSq, stride, u, v, u + t.width, v + t.height),
		template.count,
	);
	return { whole, maxQuadrant };
}

/**
 * The same score without integral images: cross term, window sum and window
 * sum of squares in one pass.
 *
 * Used by the screening stage, which looks at a couple of hundred offsets
 * scattered over the coarse frame. Building the frame's summed-area tables for
 * that costs more in allocation alone than computing the sums directly.
 */
export function nccWholeDirect(template: Template, image: GrayImage, u: number, v: number): number {
	const t = template.image;
	const tw = t.width;
	const th = t.height;
	if (u < 0 || v < 0 || u + tw > image.width || v + th > image.height) return -1;

	const templateData = t.data;
	const imageData = image.data;
	const imageWidth = image.width;
	let cross = 0;
	let sumF = 0;
	let sumSqF = 0;
	for (let y = 0; y < th; y++) {
		const tRow = y * tw;
		const iRow = (y + v) * imageWidth + u;
		for (let x = 0; x < tw; x++) {
			const f = imageData[iRow + x];
			cross += templateData[tRow + x] * f;
			sumF += f;
			sumSqF += f * f;
		}
	}
	return correlationFrom(cross, template.sum, template.sumSq, sumF, sumSqF, template.count);
}

// ---------------------------------------------------------------------------
// Projection profiles
// ---------------------------------------------------------------------------

/**
 * Mean horizontal gradient `|Y(x+1,y) - Y(x,y)|` per row, over the column band
 * `[x0, x1)`. Screen content has strong horizontal gradients at text and UI
 * edges, and a vertical scroll shifts this profile rigidly.
 *
 * The gradient is computed inside the band rather than over the whole frame:
 * the band is a fraction of the frame, and the full gradient array was pure
 * cost.
 */
export function rowProfile(image: GrayImage, x0: number, x1: number): Float64Array {
	const { width, height, data } = image;
	const left = Math.max(0, Math.min(width - 1, Math.floor(x0)));
	const right = Math.max(left + 1, Math.min(width, Math.ceil(x1)));
	const span = right - left;
	// The gradient needs x + 1, so the last column of the frame has none.
	const scanEnd = Math.min(right, width - 1);
	const profile = new Float64Array(height);
	for (let y = 0; y < height; y++) {
		const row = y * width;
		let total = 0;
		for (let x = left; x < scanEnd; x++) {
			const delta = data[row + x + 1] - data[row + x];
			total += delta < 0 ? -delta : delta;
		}
		profile[y] = total / span;
	}
	return profile;
}

/** The same gradient averaged per column, over the row band `[y0, y1)`. */
export function columnProfile(image: GrayImage, y0: number, y1: number): Float64Array {
	const { width, height, data } = image;
	const top = Math.max(0, Math.min(height - 1, Math.floor(y0)));
	const bottom = Math.max(top + 1, Math.min(height, Math.ceil(y1)));
	const span = bottom - top;
	const profile = new Float64Array(width);
	for (let y = top; y < bottom; y++) {
		const row = y * width;
		for (let x = 0; x < width - 1; x++) {
			const delta = data[row + x + 1] - data[row + x];
			profile[x] += delta < 0 ? -delta : delta;
		}
	}
	for (let x = 0; x < width; x++) profile[x] /= span;
	return profile;
}

function zeroMean(profile: Float64Array): Float64Array {
	let total = 0;
	for (let i = 0; i < profile.length; i++) total += profile[i];
	const mean = total / Math.max(1, profile.length);
	const out = new Float64Array(profile.length);
	for (let i = 0; i < profile.length; i++) out[i] = profile[i] - mean;
	return out;
}

export interface ProfileShift {
	shift: number;
	score: number;
}

/**
 * Normalised correlation of two zero-meaned profiles over every shift in
 * `[-maxShift, maxShift]`, returning the strongest local maxima.
 *
 * A positive shift means the content in `current` sits that many rows (or
 * columns) further along than in `previous` — the direction the patch moved.
 */
export function correlateProfiles(
	previous: Float64Array,
	current: Float64Array,
	maxShift: number,
	wanted: number,
	minScore: number,
	minOverlapFraction = BLUR_TRACKER_TUNING.minProfileOverlap,
): ProfileShift[] {
	const length = Math.min(previous.length, current.length);
	if (length === 0) return [];
	const p1 = zeroMean(previous);
	const p2 = zeroMean(current);
	const limit = Math.max(0, Math.min(maxShift, length - 1));
	const minOverlap = Math.max(2, Math.floor(length * minOverlapFraction));

	// Both energies are sums of squares over a contiguous range, so they come
	// from prefix sums and the inner loop is left with one multiply-add.
	const energy1Prefix = new Float64Array(length + 1);
	const energy2Prefix = new Float64Array(length + 1);
	for (let i = 0; i < length; i++) {
		energy1Prefix[i + 1] = energy1Prefix[i] + p1[i] * p1[i];
		energy2Prefix[i + 1] = energy2Prefix[i] + p2[i] * p2[i];
	}

	const scores = new Float64Array(2 * limit + 1);
	scores.fill(Number.NEGATIVE_INFINITY);
	for (let d = -limit; d <= limit; d++) {
		const from = Math.max(0, -d);
		const to = Math.min(length, length - d);
		if (to - from < minOverlap) continue;
		let cross = 0;
		for (let i = from; i < to; i++) cross += p1[i] * p2[i + d];
		const energy1 = energy1Prefix[to] - energy1Prefix[from];
		const energy2 = energy2Prefix[to + d] - energy2Prefix[from + d];
		if (energy1 <= 1e-12 || energy2 <= 1e-12) continue;
		scores[d + limit] = cross / Math.sqrt(energy1 * energy2);
	}

	const peaks: ProfileShift[] = [];
	for (let i = 0; i < scores.length; i++) {
		const score = scores[i];
		if (!Number.isFinite(score) || score < minScore) continue;
		const before = i > 0 ? scores[i - 1] : Number.NEGATIVE_INFINITY;
		const after = i < scores.length - 1 ? scores[i + 1] : Number.NEGATIVE_INFINITY;
		if (score >= before && score >= after) peaks.push({ shift: i - limit, score });
	}
	// Strongest first, then nearest zero, so the order never depends on the scan.
	peaks.sort((a, b) => b.score - a.score || Math.abs(a.shift) - Math.abs(b.shift));

	const kept: ProfileShift[] = [];
	for (const peak of peaks) {
		if (kept.length >= wanted) break;
		// Adjacent samples of one peak are the same candidate; +/-3 px refinement covers them.
		if (kept.some((other) => Math.abs(other.shift - peak.shift) <= 2)) continue;
		kept.push(peak);
	}
	return kept;
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

/**
 * The scale a patch is verified at: as coarse as the patch can afford, so a
 * small text cell is matched at full resolution and a whole window is matched
 * at an eighth. The area cap bounds the NCC cost for large boxes, but never at
 * the price of dropping the patch below the detail floor.
 */
export function resolvePatchScale(widthPx: number, heightPx: number): number {
	const { minPatchSide, minPatchLongSide, maxTemplatePixels } = BLUR_TRACKER_TUNING;
	const fits = (scale: number): boolean => {
		const w = widthPx * scale;
		const h = heightPx * scale;
		return Math.min(w, h) >= minPatchSide && Math.max(w, h) >= minPatchLongSide;
	};
	let scale = 1;
	for (let k = 1; k <= 3; k++) {
		const candidate = 2 ** -k;
		if (!fits(candidate)) break;
		scale = candidate;
	}
	while (
		widthPx * scale * (heightPx * scale) > maxTemplatePixels &&
		fits(scale / 2) &&
		scale > 2 ** -5
	) {
		scale /= 2;
	}
	return scale;
}

// ---------------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------------

/** One offset inside the fine window, in fine pixels, with its whole-patch score. */
interface FineOffset {
	u: number;
	v: number;
	whole: number;
}

interface Candidate {
	x: number;
	y: number;
	/**
	 * Never dropped by the screening stage. The "stay put" offset and the
	 * constant-velocity prediction are priors, not guesses: screening them out
	 * because a lookalike scored higher at the coarse scale is how a tracker
	 * jumps off a patch that a cursor happened to be sitting on.
	 */
	pinned?: boolean;
}

function clampRectInside(
	rect: SourceRectPx,
	sourceWidth: number,
	sourceHeight: number,
): SourceRectPx {
	const w = Math.min(rect.w, sourceWidth);
	const h = Math.min(rect.h, sourceHeight);
	return {
		x: Math.max(0, Math.min(sourceWidth - w, rect.x)),
		y: Math.max(0, Math.min(sourceHeight - h, rect.y)),
		w,
		h,
	};
}

export class BlurTracker {
	private readonly template: Template;
	/** The patch at the screening scale, plus how many halvings below coarse that is. */
	private readonly screenTemplate: Template | null;
	private readonly screenHalvings: number;
	private readonly patchWidthPx: number;
	private readonly patchHeightPx: number;
	private readonly sourceWidth: number;
	private readonly sourceHeight: number;
	private readonly patchScale: number;
	private readonly coarseScale: number;
	/** Scale the screening template and the screening image are held at. */
	private readonly screenScale: number;

	private x: number;
	private y: number;
	private velocityX = 0;
	private velocityY = 0;
	private state: TrackerState = "found";
	private tentativeStreak = 0;
	private lostSampleCount = 0;
	private lastTimeMs: number;
	private previousCoarse: GrayImage | null = null;
	/** The frame being analysed right now, at the screening scale. */
	private screenCache: { frame: TrackerFrame; image: GrayImage } | null = null;
	/** ...and blurred with integrals, built only when a re-acquisition sweep needs it. */
	private sweepCache: { frame: TrackerFrame; image: GrayImage; integrals: Integrals } | null = null;

	private constructor(args: {
		template: Template;
		screenTemplate: Template | null;
		screenHalvings: number;
		rect: SourceRectPx;
		frame: TrackerFrame;
		patchScale: number;
		anchorMs: number;
	}) {
		this.template = args.template;
		this.screenTemplate = args.screenTemplate;
		this.screenHalvings = args.screenHalvings;
		this.patchWidthPx = args.rect.w;
		this.patchHeightPx = args.rect.h;
		this.x = args.rect.x;
		this.y = args.rect.y;
		this.sourceWidth = args.frame.sourceWidth;
		this.sourceHeight = args.frame.sourceHeight;
		this.patchScale = args.patchScale;
		this.coarseScale = args.frame.coarse.width / args.frame.sourceWidth;
		this.screenScale = this.coarseScale / 2 ** args.screenHalvings;
		this.lastTimeMs = args.anchorMs;
		// The anchor frame is the previous frame for the first step; without it
		// that step has no profile candidates and a scroll larger than the +/-3
		// refinement would be missed at the very start of the track.
		this.previousCoarse = args.frame.coarse;
	}

	/**
	 * Samples the anchor patch and prepares a tracker for it, or refuses.
	 *
	 * A patch with almost no contrast (a blank area, a flat fill) cannot be
	 * matched: NCC against it is noise, and following noise produces a confident
	 * random walk. Refusing with a reason is the honest answer.
	 */
	static create(
		frame: TrackerFrame,
		anchorRect: SourceRectPx,
		anchorMs: number,
	): TrackerCreateResult {
		const rect = clampRectInside(anchorRect, frame.sourceWidth, frame.sourceHeight);
		if (!(rect.w >= 2) || !(rect.h >= 2)) {
			return { ok: false, reason: "degenerate-rect", stdDev: 0 };
		}

		const patchScale = resolvePatchScale(rect.w, rect.h);
		const template = buildTemplate(sampleBlurred(frame, rect, patchScale));
		if (template.stdDev < BLUR_TRACKER_TUNING.minTemplateStdDev) {
			return { ok: false, reason: "low-detail", stdDev: template.stdDev };
		}

		// The screening scale: the coarse scale, halved until the patch fits the
		// screening budget. The frame's coarse width is fixed at 480, so on a
		// 480-wide recording "coarse" is 1:1 and a wide patch would make screening
		// cost more than the fine pass it exists to cheapen.
		const coarseScale = frame.coarse.width / frame.sourceWidth;
		const { minScreenTemplateSide, maxScreenTemplatePixels } = BLUR_TRACKER_TUNING;
		let screenHalvings = 0;
		let screenScale = coarseScale;
		while (
			rect.w * screenScale * (rect.h * screenScale) > maxScreenTemplatePixels &&
			Math.min(rect.w, rect.h) * (screenScale / 2) >= minScreenTemplateSide &&
			screenHalvings < 4
		) {
			screenScale /= 2;
			screenHalvings++
		}

		const screenWidth = Math.round(rect.w * screenScale);
		const screenHeight = Math.round(rect.h * screenScale);
		// Below 8x3 there is not enough of the patch left for a sweep to mean
		// anything; re-acquisition falls back to a fine-scale strip.
		const screenTemplate =
			screenWidth >= 8 && screenHeight >= 3
				? buildTemplate(sampleBlurred(frame, rect, screenScale))
				: null;

		return {
			ok: true,
			tracker: new BlurTracker({
				template,
				screenTemplate,
				screenHalvings,
				rect,
				frame,
				patchScale,
				anchorMs,
			}),
		};
	}

	/**
	 * The whole mutable state of a track, so an interval can be replayed.
	 *
	 * Densification only knows an interval needs filling in *after* both of its
	 * ends have been analysed (§1.8), and the tracker is sequential: the frames
	 * in between have to be run with the state as it was at the start of the
	 * interval, not after it. Rewinding is what makes the densified result
	 * identical to having analysed every frame from the beginning.
	 */
	snapshot(): TrackerSnapshot {
		return {
			x: this.x,
			y: this.y,
			velocityX: this.velocityX,
			velocityY: this.velocityY,
			state: this.state,
			tentativeStreak: this.tentativeStreak,
			lostSampleCount: this.lostSampleCount,
			lastTimeMs: this.lastTimeMs,
			previousCoarse: this.previousCoarse,
		};
	}

	restore(snapshot: TrackerSnapshot): void {
		this.x = snapshot.x;
		this.y = snapshot.y;
		this.velocityX = snapshot.velocityX;
		this.velocityY = snapshot.velocityY;
		this.state = snapshot.state;
		this.tentativeStreak = snapshot.tentativeStreak;
		this.lostSampleCount = snapshot.lostSampleCount;
		this.lastTimeMs = snapshot.lastTimeMs;
		this.previousCoarse = snapshot.previousCoarse;
		this.screenCache = null;
		this.sweepCache = null;
	}

	/** Scale the fine template is held at, for the benchmark and the tests. */
	getPatchScale(): number {
		return this.patchScale;
	}

	/** The anchor template's standard deviation, 0..255. */
	getTemplateStdDev(): number {
		return this.template.stdDev;
	}

	/** The sample the anchor frame itself produces; a track always starts found. */
	anchorSample(): TrackerSample {
		return {
			timeMs: this.lastTimeMs,
			x: this.x,
			y: this.y,
			w: this.patchWidthPx,
			h: this.patchHeightPx,
			state: "found",
			score: 1,
			maxQuadrantScore: 1,
			reacquired: false,
		};
	}

	/** Analyses one frame and advances the state machine. */
	step(frame: TrackerFrame, timeMs: number): TrackerSample {
		const dt = timeMs - this.lastTimeMs;

		const result = this.state === "lost" ? this.reacquire(frame) : this.locate(frame, dt);

		this.previousCoarse = frame.coarse;
		this.screenCache = null;
		this.sweepCache = null;
		this.lastTimeMs = timeMs;

		return this.applyResult(result, timeMs, dt);
	}

	private applyResult(
		result: { x: number; y: number; whole: number; maxQuadrant: number } | null,
		timeMs: number,
		dt: number,
	): TrackerSample {
		const wasLost = this.state === "lost";
		const whole = result?.whole ?? -1;
		const maxQuadrant = result?.maxQuadrant ?? -1;

		const matched =
			result !== null &&
			(whole >= BLUR_TRACKER_TUNING.foundScore ||
				(maxQuadrant >= BLUR_TRACKER_TUNING.quadrantFoundScore &&
					whole >= BLUR_TRACKER_TUNING.quadrantWholeFloor));

		let reacquired = false;
		if (matched && result) {
			if (dt > 0 && !wasLost) {
				this.velocityX = (result.x - this.x) / dt;
				this.velocityY = (result.y - this.y) / dt;
			} else {
				this.velocityX = 0;
				this.velocityY = 0;
			}
			this.x = result.x;
			this.y = result.y;
			this.state = "found";
			this.tentativeStreak = 0;
			this.lostSampleCount = 0;
			reacquired = wasLost;
		} else if (
			!wasLost &&
			result !== null &&
			whole >= BLUR_TRACKER_TUNING.tentativeScore &&
			this.tentativeStreak < BLUR_TRACKER_TUNING.maxTentativeStreak
		) {
			// A cursor over the patch, a hover highlight, a selection tint. Hold the
			// rect where it was and wait for the next clean sample.
			this.tentativeStreak++
			this.state = "tentative";
		} else {
			if (!wasLost) this.lostSampleCount = 0;
			this.state = "lost";
			this.tentativeStreak = 0;
			this.velocityX = 0;
			this.velocityY = 0;
			this.lostSampleCount++
		}

		return {
			timeMs,
			x: this.x,
			y: this.y,
			w: this.patchWidthPx,
			h: this.patchHeightPx,
			state: this.state,
			score: whole,
			maxQuadrantScore: maxQuadrant,
			reacquired,
		};
	}

	/** Candidate shifts, in source px, from the profile correlation plus the velocity prediction. */
	private buildCandidates(frame: TrackerFrame, dt: number): Candidate[] {
		const coarse = frame.coarse;
		const scale = this.coarseScale;
		const predictedX = this.x + this.velocityX * dt;
		const predictedY = this.y + this.velocityY * dt;

		const verticalShifts: number[] = [0, predictedY - this.y];
		const horizontalShifts: number[] = [0, predictedX - this.x];

		const previous = this.previousCoarse;
		if (previous && previous.width === coarse.width && previous.height === coarse.height) {
			const patchX = this.x * scale;
			const patchY = this.y * scale;
			const patchW = this.patchWidthPx * scale;
			const patchH = this.patchHeightPx * scale;

			// Restricting the band to the patch's own columns makes the profile
			// belong to the patch's scroll container, not to the whole screen.
			const bandLeft = patchX - patchW / 2;
			const bandRight = patchX + patchW * 1.5;
			const previousRows = rowProfile(previous, bandLeft, bandRight);
			const currentRows = rowProfile(coarse, bandLeft, bandRight);
			for (const peak of correlateProfiles(
				previousRows,
				currentRows,
				Math.floor(coarse.height / 2),
				BLUR_TRACKER_TUNING.verticalCandidates,
				BLUR_TRACKER_TUNING.minProfileCorrelation,
			)) {
				verticalShifts.push(peak.shift / scale);
			}

			const bandTop = patchY - patchH;
			const bandBottom = patchY + patchH * 2;
			const previousColumns = columnProfile(previous, bandTop, bandBottom);
			const currentColumns = columnProfile(coarse, bandTop, bandBottom);
			for (const peak of correlateProfiles(
				previousColumns,
				currentColumns,
				Math.floor(coarse.width / 4),
				BLUR_TRACKER_TUNING.horizontalCandidates,
				BLUR_TRACKER_TUNING.minProfileCorrelation,
			)) {
				horizontalShifts.push(peak.shift / scale);
			}
		}

		const seen = new Set<string>();
		const candidates: Candidate[] = [];
		// The first two entries of each axis are the stay-put offset and the
		// velocity prediction, so the first two pairs are the priors.
		for (let vi = 0; vi < verticalShifts.length; vi++) {
			for (let hi = 0; hi < horizontalShifts.length; hi++) {
				const x = this.x + horizontalShifts[hi];
				const y = this.y + verticalShifts[vi];
				// Half a source pixel is finer than the +/-3 refinement can tell apart.
				const key = `${Math.round(x * 2)}:${Math.round(y * 2)}`;
				if (seen.has(key)) continue;
				if (x < 0 || y < 0 || x + this.patchWidthPx > this.sourceWidth) continue;
				if (y + this.patchHeightPx > this.sourceHeight) continue;
				seen.add(key);
				candidates.push(vi < 2 && hi < 2 ? { x, y, pinned: true } : { x, y });
				if (candidates.length >= BLUR_TRACKER_TUNING.maxCandidates) return candidates;
			}
		}
		return candidates;
	}

	/** Verifies the candidates in one fine window and returns the best offset. */
	private locate(
		frame: TrackerFrame,
		dt: number,
	): { x: number; y: number; whole: number; maxQuadrant: number } | null {
		const candidates = this.buildCandidates(frame, dt);
		if (candidates.length === 0) return null;

		const predictedX = this.x + this.velocityX * dt;
		const predictedY = this.y + this.velocityY * dt;
		const screened = this.screenCandidates(frame, candidates, predictedX, predictedY);
		return this.evaluateCandidates(frame, screened, predictedX, predictedY);
	}

	/** The coarse frame at the screening scale: halved as many times as the template was. */
	private screenImage(frame: TrackerFrame): GrayImage {
		if (this.screenCache?.frame === frame) return this.screenCache.image;
		let image = frame.coarse;
		for (let i = 0; i < this.screenHalvings; i++) image = halveGray(image);
		this.screenCache = { frame, image };
		return image;
	}

	/**
	 * The screening image blurred, with its integral images. Only the
	 * re-acquisition sweeps need this: they look at tens of thousands of offsets,
	 * where summed-area tables pay for themselves, while the per-frame screening
	 * looks at a couple of hundred and computes its sums directly.
	 */
	private screenAnalysis(frame: TrackerFrame): { image: GrayImage; integrals: Integrals } {
		if (this.sweepCache?.frame === frame) return this.sweepCache;
		const image = boxBlur3(this.screenImage(frame));
		const analysis = { frame, image, integrals: integralImages(image) };
		this.sweepCache = analysis;
		return analysis;
	}

	/**
	 * Ranks the profile's shift candidates by a coarse-scale NCC of the patch
	 * itself and keeps the best few for the fine stage.
	 *
	 * The profiles summarise each row to one number, so on a page of text they
	 * are close to periodic in the row pitch and the true shift can rank behind
	 * several aliases of it. Screening with the patch's own pixels breaks that
	 * tie for a few tens of thousands of operations, and it is what keeps the
	 * expensive fine refinement down to a handful of offsets.
	 */
	private screenCandidates(
		frame: TrackerFrame,
		candidates: Candidate[],
		predictedX: number,
		predictedY: number,
	): Candidate[] {
		const template = this.screenTemplate;
		if (!template || candidates.length <= BLUR_TRACKER_TUNING.maxFineCandidates) return candidates;

		const image = this.screenImage(frame);
		const scale = this.screenScale;
		const radius = BLUR_TRACKER_TUNING.screenRadius;
		const scored = candidates.map((candidate) => {
			const baseU = Math.round(candidate.x * scale);
			const baseV = Math.round(candidate.y * scale);
			let best = -1;
			for (let dv = -radius; dv <= radius; dv++) {
				for (let du = -radius; du <= radius; du++) {
					const score = nccWholeDirect(template, image, baseU + du, baseV + dv);
					if (score > best) best = score;
				}
			}
			return {
				candidate,
				score: best,
				distance: Math.hypot(candidate.x - predictedX, candidate.y - predictedY),
			};
		});
		scored.sort((a, b) => b.score - a.score || a.distance - b.distance);

		const kept: Candidate[] = [];
		for (const entry of scored) if (entry.candidate.pinned) kept.push(entry.candidate);
		for (const entry of scored) {
			if (kept.length >= BLUR_TRACKER_TUNING.maxFineCandidates) break;
			if (!entry.candidate.pinned) kept.push(entry.candidate);
		}

		// Second pass: walk each survivor to its best offset in a wider coarse
		// neighbourhood. The profiles are per-axis, so a move with a component on
		// both axes can leave one axis's peak out of the candidate list entirely;
		// this recovers it from the other axis's candidate for a few tens of
		// thousands of operations, and it is the "coarse" half of coarse-to-fine.
		const refineRadius = BLUR_TRACKER_TUNING.screenRefineRadius;
		const relocated: Candidate[] = [];
		const seen = new Set<string>();
		const push = (candidate: Candidate): void => {
			const key = `${Math.round(candidate.x)}:${Math.round(candidate.y)}`;
			if (seen.has(key)) return;
			seen.add(key);
			relocated.push(candidate);
		};
		for (const candidate of kept) {
			// The stay-put and prediction priors are kept as drawn as well as
			// relocated: a still frame must not be walked off its content.
			if (candidate.pinned) push(candidate);
			const baseU = Math.round(candidate.x * scale);
			const baseV = Math.round(candidate.y * scale);
			let bestScore = -1;
			let bestU = baseU;
			let bestV = baseV;
			for (let dv = -refineRadius; dv <= refineRadius; dv++) {
				for (let du = -refineRadius; du <= refineRadius; du++) {
					const score = nccWholeDirect(template, image, baseU + du, baseV + dv);
					if (score > bestScore) {
						bestScore = score;
						bestU = baseU + du;
						bestV = baseV + dv;
					}
				}
			}
			const x = bestU / scale;
			const y = bestV / scale;
			if (x < 0 || y < 0 || x + this.patchWidthPx > this.sourceWidth) continue;
			if (y + this.patchHeightPx > this.sourceHeight) continue;
			push({ x, y, pinned: candidate.pinned });
		}
		return relocated;
	}

	private evaluateCandidates(
		frame: TrackerFrame,
		candidates: Candidate[],
		predictedX: number,
		predictedY: number,
	): { x: number; y: number; whole: number; maxQuadrant: number } | null {
		const scale = this.patchScale;
		const marginPx = BLUR_TRACKER_TUNING.fineMargin / scale;
		// Farthest-from-prediction candidates are dropped first when the union of
		// the search windows would be too large to read in one go.
		const ordered = [...candidates].sort(
			(a, b) =>
				Math.hypot(a.x - predictedX, a.y - predictedY) -
				Math.hypot(b.x - predictedX, b.y - predictedY),
		);

		const kept: Candidate[] = [];
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const candidate of ordered) {
			const nextMinX = Math.min(minX, candidate.x - marginPx);
			const nextMinY = Math.min(minY, candidate.y - marginPx);
			const nextMaxX = Math.max(maxX, candidate.x + this.patchWidthPx + marginPx);
			const nextMaxY = Math.max(maxY, candidate.y + this.patchHeightPx + marginPx);
			const spanX = (nextMaxX - nextMinX) * scale;
			const spanY = (nextMaxY - nextMinY) * scale;
			if (
				kept.length > 0 &&
				(spanX > BLUR_TRACKER_TUNING.maxFineWindow || spanY > BLUR_TRACKER_TUNING.maxFineWindow)
			) {
				continue;
			}
			kept.push(candidate);
			minX = nextMinX;
			minY = nextMinY;
			maxX = nextMaxX;
			maxY = nextMaxY;
		}
		if (kept.length === 0) return null;

		const window = this.readWindow(frame, minX, minY, maxX, maxY);
		if (!window) return null;

		const radius = BLUR_TRACKER_TUNING.refineRadius;

		// Every offset within +/-radius of every candidate is a lot of NCC for a
		// score surface that the 3x3 blur has already made smooth. Sample it on a
		// stride-2 lattice first, then walk +/-1 around the winner: the same
		// +/-radius reach for a third of the work.
		// Held in an object: narrowing of a plain `let` written only inside the
		// closure below collapses to `never` at the reads.
		const search: { best: FineOffset | null } = { best: null };
		const consider = (u: number, v: number): void => {
			const whole = nccWhole(this.template, window.image, window.integrals, u, v);
			if (whole <= -1) return;
			const best = search.best;
			if (best === null || whole > best.whole + BLUR_TRACKER_TUNING.tieMargin) {
				search.best = { u, v, whole };
				return;
			}
			// Within the tie margin the offset nearest the constant-velocity
			// prediction wins, which is what keeps a scroll from jittering between
			// two equally good rows of the same text.
			if (whole > best.whole - BLUR_TRACKER_TUNING.tieMargin) {
				const bestDistance = Math.hypot(
					window.originX + best.u / scale - predictedX,
					window.originY + best.v / scale - predictedY,
				);
				const distance = Math.hypot(
					window.originX + u / scale - predictedX,
					window.originY + v / scale - predictedY,
				);
				if (distance < bestDistance || (distance === bestDistance && whole > best.whole)) {
					search.best = { u, v, whole };
				}
			}
		};

		// The lattice reaches +/-(radius - 1); the +/-1 walk around its winner
		// then reaches +/-radius, which is the refinement window the tuning names.
		const stride = Math.max(1, radius - 1);
		for (const candidate of kept) {
			const baseU = Math.round((candidate.x - window.originX) * scale);
			const baseV = Math.round((candidate.y - window.originY) * scale);
			for (let dv = -stride; dv <= stride; dv += stride) {
				for (let du = -stride; du <= stride; du += stride) consider(baseU + du, baseV + dv);
			}
		}
		const lattice = search.best;
		if (lattice === null) {
			return null;
		}
		for (let dv = -1; dv <= 1; dv++) {
			for (let du = -1; du <= 1; du++) {
				if (du === 0 && dv === 0) continue;
				consider(lattice.u + du, lattice.v + dv);
			}
		}

		const winner = search.best ?? lattice;
		const scores = nccAt(this.template, window.image, window.integrals, winner.u, winner.v);
		return {
			x: window.originX + winner.u / scale,
			y: window.originY + winner.v / scale,
			whole: scores.whole,
			maxQuadrant: scores.maxQuadrant,
		};
	}

	private readWindow(
		frame: TrackerFrame,
		minX: number,
		minY: number,
		maxX: number,
		maxY: number,
	): { image: GrayImage; integrals: Integrals; originX: number; originY: number } | null {
		const scale = this.patchScale;
		const originX = Math.max(0, Math.floor(minX));
		const originY = Math.max(0, Math.floor(minY));
		const endX = Math.min(this.sourceWidth, Math.ceil(maxX));
		const endY = Math.min(this.sourceHeight, Math.ceil(maxY));
		const widthPx = endX - originX;
		const heightPx = endY - originY;
		if (widthPx <= 0 || heightPx <= 0) return null;

		const outWidth = Math.max(1, Math.round(widthPx * scale));
		const outHeight = Math.max(1, Math.round(heightPx * scale));
		if (outWidth < this.template.image.width || outHeight < this.template.image.height) return null;

		const image = boxBlur3(
			frame.sample({ x: originX, y: originY, w: widthPx, h: heightPx }, outWidth, outHeight),
		);
		return { image, integrals: integralImages(image), originX, originY };
	}

	/**
	 * While lost: every sample a 1-D sweep along the scroll axis at the last
	 * known column, and every fifth sample a full 2-D sweep of the coarse frame
	 * for a window that was dragged or a tab that came back.
	 *
	 * Both need a coarse hit *and* a fine verification. The thresholds are
	 * stricter than FOUND on purpose: latching onto a different row of similar
	 * text is the worst failure this feature has, and a lost blur is honest
	 * while a wrong one is not.
	 */
	private reacquire(
		frame: TrackerFrame,
	): { x: number; y: number; whole: number; maxQuadrant: number } | null {
		const fullSweep = this.lostSampleCount % BLUR_TRACKER_TUNING.reacquireFullSweepEvery === 0;
		const guess = this.screenTemplate
			? this.sweepCoarse(frame, fullSweep)
			: this.sweepFineStrip(frame);
		if (!guess) return null;

		const verified = this.evaluateCandidates(frame, [guess], guess.x, guess.y);
		if (!verified) return null;
		if (verified.whole < BLUR_TRACKER_TUNING.reacquireFineScore) return null;
		return verified;
	}

	private sweepCoarse(frame: TrackerFrame, fullSweep: boolean): Candidate | null {
		const template = this.screenTemplate;
		if (!template) return null;
		const { image: coarse, integrals } = this.screenAnalysis(frame);
		const scale = this.screenScale;
		const maxU = coarse.width - template.image.width;
		const maxV = coarse.height - template.image.height;
		if (maxU < 0 || maxV < 0) return null;

		const centreU = Math.round(this.x * scale);
		const fromU = fullSweep ? 0 : Math.max(0, centreU - BLUR_TRACKER_TUNING.reacquireColumnRadius);
		const toU = fullSweep
			? maxU
			: Math.min(maxU, centreU + BLUR_TRACKER_TUNING.reacquireColumnRadius);

		let best: { u: number; v: number; score: number } | null = null;
		for (let v = 0; v <= maxV; v++) {
			for (let u = fromU; u <= toU; u++) {
				const scores = nccAt(template, coarse, integrals, u, v);
				if (best === null || scores.whole > best.score) best = { u, v, score: scores.whole };
			}
		}
		if (!best || best.score < BLUR_TRACKER_TUNING.reacquireCoarseScore) return null;
		return { x: best.u / scale, y: best.v / scale };
	}

	/**
	 * Fallback for a patch too small to survive the coarse scale: slide the fine
	 * template down a full-height strip at the last known column.
	 */
	private sweepFineStrip(frame: TrackerFrame): Candidate | null {
		const scale = this.patchScale;
		const marginPx = BLUR_TRACKER_TUNING.fineMargin / scale;
		const window = this.readWindow(
			frame,
			this.x - marginPx,
			0,
			this.x + this.patchWidthPx + marginPx,
			this.sourceHeight,
		);
		if (!window) return null;
		const maxU = window.image.width - this.template.image.width;
		const maxV = window.image.height - this.template.image.height;
		if (maxU < 0 || maxV < 0) return null;

		let best: { u: number; v: number; score: number } | null = null;
		for (let v = 0; v <= maxV; v++) {
			for (let u = 0; u <= maxU; u++) {
				const scores = nccAt(this.template, window.image, window.integrals, u, v);
				if (best === null || scores.whole > best.score) best = { u, v, score: scores.whole };
			}
		}
		if (!best || best.score < BLUR_TRACKER_TUNING.reacquireCoarseScore) return null;
		return { x: window.originX + best.u / scale, y: window.originY + best.v / scale };
	}
}

/**
 * Samples a source rect at `scale`, with a two-pixel bleed where the frame
 * allows it, blurs, then crops the bleed off. Without the bleed the template's
 * border pixels would be blurred against a clamped edge while the same pixels
 * inside a search window are blurred against their real neighbours, which
 * costs real NCC on a short patch.
 */
function sampleBlurred(frame: TrackerFrame, rect: SourceRectPx, scale: number): GrayImage {
	const bleedPx = 2 / scale;
	const x0 = Math.max(0, rect.x - bleedPx);
	const y0 = Math.max(0, rect.y - bleedPx);
	const x1 = Math.min(frame.sourceWidth, rect.x + rect.w + bleedPx);
	const y1 = Math.min(frame.sourceHeight, rect.y + rect.h + bleedPx);

	const width = Math.max(1, Math.round(rect.w * scale));
	const height = Math.max(1, Math.round(rect.h * scale));
	const paddedWidth = Math.max(width, Math.round((x1 - x0) * scale));
	const paddedHeight = Math.max(height, Math.round((y1 - y0) * scale));

	const padded = boxBlur3(
		frame.sample({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, paddedWidth, paddedHeight),
	);
	const offsetX = Math.min(paddedWidth - width, Math.round((rect.x - x0) * scale));
	const offsetY = Math.min(paddedHeight - height, Math.round((rect.y - y0) * scale));
	return cropGray(padded, Math.max(0, offsetX), Math.max(0, offsetY), width, height);
}

/** Copies a sub-rectangle out of a gray image. */
export function cropGray(
	image: GrayImage,
	x: number,
	y: number,
	width: number,
	height: number,
): GrayImage {
	const out = new Uint8Array(width * height);
	for (let row = 0; row < height; row++) {
		const from = (y + row) * image.width + x;
		out.set(image.data.subarray(from, from + width), row * width);
	}
	return { data: out, width, height };
}
