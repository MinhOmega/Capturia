import { describe, expect, it } from "vitest";
import {
	createSyntheticScreen,
	createTrackerFrame,
	type SyntheticScreen,
	sampleGray,
} from "./syntheticScreen";
import type { SourceRectPx } from "./trackerCore";
import {
	BLUR_TRACKER_TUNING,
	BlurTracker,
	boxBlur3,
	columnProfile,
	correlateProfiles,
	cropGray,
	type GrayImage,
	integralImages,
	nccAt,
	nccWhole,
	nccWholeDirect,
	resolvePatchScale,
	rowProfile,
	type TrackerSample,
} from "./trackerCore";

/**
 * The tracker over synthetic screens with known ground truth
 * (`docs/specs/tracked-blur-regions.md` §4.1).
 *
 * Every case here is a failure the feature must not ship with: following the
 * wrong row of similar text, drifting off a patch under a cursor, claiming a
 * blur is on content that is covered, or producing different keyframes on a
 * second run of the same frames.
 */

function trackerFor(screen: SyntheticScreen, options: { noise?: number } = {}): BlurTracker {
	const anchor = screen.render({ scrollY: 0, noise: options.noise, noiseSeed: 1 });
	const created = BlurTracker.create(createTrackerFrame(anchor), screen.cellRect, 0);
	if (!created.ok) throw new Error(`tracker refused the anchor: ${created.reason}`);
	return created.tracker;
}

/** Steps the tracker over a list of scroll offsets, one grid interval apart. */
function runScroll(
	tracker: BlurTracker,
	screen: SyntheticScreen,
	offsets: Array<{ y: number; x?: number }>,
	render: (offset: { y: number; x?: number }, index: number) => GrayImage = (offset) =>
		screen.render({ scrollY: offset.y, scrollX: offset.x }),
): TrackerSample[] {
	const samples: TrackerSample[] = [];
	let timeMs = 0;
	offsets.forEach((offset, index) => {
		timeMs += BLUR_TRACKER_TUNING.sampleIntervalMs;
		samples.push(tracker.step(createTrackerFrame(render(offset, index)), timeMs));
	});
	return samples;
}

function errorPx(sample: TrackerSample, truth: SourceRectPx): number {
	return Math.max(Math.abs(sample.x - truth.x), Math.abs(sample.y - truth.y));
}

describe("image helpers", () => {
	it("box-blurs with clamped borders and leaves a flat image flat", () => {
		const flat: GrayImage = { data: new Uint8Array(25).fill(200), width: 5, height: 5 };
		expect(Array.from(boxBlur3(flat).data)).toEqual(Array.from(flat.data));
	});

	it("returns a copy for images too small to filter", () => {
		const tiny: GrayImage = { data: new Uint8Array([1, 2]), width: 2, height: 1 };
		const blurred = boxBlur3(tiny);
		expect(Array.from(blurred.data)).toEqual([1, 2]);
		expect(blurred.data).not.toBe(tiny.data);
	});

	it("builds integral images that answer any rectangle sum", () => {
		const image: GrayImage = {
			data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
			width: 3,
			height: 3,
		};
		const { sum, sumSq, stride } = integralImages(image);
		const area = (x0: number, y0: number, x1: number, y1: number) =>
			sum[y1 * stride + x1] - sum[y0 * stride + x1] - sum[y1 * stride + x0] + sum[y0 * stride + x0];
		expect(area(0, 0, 3, 3)).toBe(45);
		expect(area(1, 1, 3, 3)).toBe(5 + 6 + 8 + 9);
		expect(sumSq[3 * stride + 3]).toBe(285);
	});

	it("crops a sub-rectangle out of a gray image", () => {
		const image: GrayImage = {
			data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
			width: 3,
			height: 3,
		};
		expect(Array.from(cropGray(image, 1, 1, 2, 2).data)).toEqual([5, 6, 8, 9]);
	});
});

describe("projection profiles", () => {
	const image: GrayImage = {
		// Two dark columns on a light background: the column profile spikes at the edges.
		data: new Uint8Array(8 * 4).fill(200),
		width: 8,
		height: 4,
	};
	for (let y = 0; y < 4; y++) {
		image.data[y * 8 + 3] = 20;
		image.data[y * 8 + 4] = 20;
	}

	it("reports the same gradient energy on every row of a vertically uniform image", () => {
		const profile = rowProfile(image, 0, 8);
		expect(new Set(Array.from(profile))).toHaveProperty("size", 1);
	});

	it("spikes the column profile at the edges of the dark band", () => {
		const profile = columnProfile(image, 0, 4);
		expect(profile[2]).toBeGreaterThan(profile[0]);
		expect(profile[4]).toBeGreaterThan(profile[0]);
		expect(profile[6]).toBe(0);
	});

	it("finds the shift between a profile and a translated copy of itself", () => {
		const source = new Float64Array(64);
		for (let i = 0; i < 64; i++) source[i] = Math.sin(i / 3) + Math.sin(i / 7.5) * 2;
		for (const shift of [-9, -3, 0, 4, 11]) {
			const shifted = new Float64Array(64);
			for (let i = 0; i < 64; i++) {
				const from = i - shift;
				shifted[i] = from >= 0 && from < 64 ? source[from] : 0;
			}
			const peaks = correlateProfiles(source, shifted, 20, 3, 0.5);
			expect(peaks.length, `shift ${shift}`).toBeGreaterThan(0);
			expect(peaks[0].shift, `shift ${shift}`).toBe(shift);
		}
	});

	it("scores nothing when the overlap is shorter than the minimum", () => {
		const profile = new Float64Array(20);
		for (let i = 0; i < 20; i++) profile[i] = i % 3;
		expect(correlateProfiles(profile, profile, 19, 3, 0.5)).not.toContainEqual(
			expect.objectContaining({ shift: 19 }),
		);
	});
});

describe("normalised cross-correlation", () => {
	const screen = createSyntheticScreen();
	const frame = screen.render();
	const cell = screen.cellRect;
	const window = boxBlur3(
		sampleGray(
			frame,
			{ x: cell.x - 8, y: cell.y - 8, w: cell.w + 16, h: cell.h + 16 },
			cell.w + 16,
			cell.h + 16,
		),
	);
	const integrals = integralImages(window);
	const created = BlurTracker.create(createTrackerFrame(frame), cell, 0);
	if (!created.ok) throw new Error("refused");

	it("peaks at the offset the template was taken from", () => {
		// The tracker's own template is private; go through a one-step track on an
		// unmoved frame, which must land exactly where it started.
		const sample = created.tracker.step(createTrackerFrame(frame), 100);
		expect(sample.state).toBe("found");
		expect(sample.score).toBeGreaterThan(0.99);
		expect(errorPx(sample, cell)).toBe(0);
	});

	it("agrees between the integral and the integral-free forms", () => {
		const template = boxBlur3(sampleGray(frame, cell, cell.w, cell.h));
		const probe = {
			image: template,
			sum: template.data.reduce((total, value) => total + value, 0),
			sumSq: template.data.reduce((total, value) => total + value * value, 0),
			count: template.data.length,
			stdDev: 1,
			quadrants: [
				{ x0: 0, y0: 0, x1: template.width, y1: template.height, sum: 0, sumSq: 0, count: 0 },
			],
		};
		probe.quadrants[0].sum = probe.sum;
		probe.quadrants[0].sumSq = probe.sumSq;
		probe.quadrants[0].count = probe.count;
		for (const [u, v] of [
			[8, 8],
			[5, 11],
			[12, 3],
		]) {
			expect(nccWhole(probe, window, integrals, u, v)).toBeCloseTo(
				nccWholeDirect(probe, window, u, v),
				9,
			);
			expect(nccAt(probe, window, integrals, u, v).whole).toBeCloseTo(
				nccWhole(probe, window, integrals, u, v),
				9,
			);
		}
	});

	it("answers -1 for an offset that runs off the window", () => {
		const template = boxBlur3(sampleGray(frame, cell, cell.w, cell.h));
		const probe = {
			image: template,
			sum: 0,
			sumSq: 0,
			count: template.data.length,
			stdDev: 1,
			quadrants: [
				{ x0: 0, y0: 0, x1: template.width, y1: template.height, sum: 0, sumSq: 0, count: 1 },
			],
		};
		expect(nccWhole(probe, window, integrals, -1, 0)).toBe(-1);
		expect(nccWhole(probe, window, integrals, 0, 9999)).toBe(-1);
		expect(nccAt(probe, window, integrals, -1, 0)).toEqual({ whole: -1, maxQuadrant: -1 });
	});
});

describe("patch scale", () => {
	it("tracks a small text cell at full resolution and a whole window at an eighth", () => {
		expect(resolvePatchScale(200, 16)).toBe(1);
		expect(resolvePatchScale(900, 600)).toBe(1 / 8);
	});

	it("never drops the patch below the detail floor to satisfy the area cap", () => {
		const scale = resolvePatchScale(1600, 20);
		expect(20 * scale).toBeGreaterThanOrEqual(BLUR_TRACKER_TUNING.minPatchSide);
	});

	it("steps down until the template area is bounded when the patch can afford it", () => {
		const scale = resolvePatchScale(1600, 900);
		expect(1600 * scale * (900 * scale)).toBeLessThanOrEqual(BLUR_TRACKER_TUNING.maxTemplatePixels);
	});
});

describe("template validity", () => {
	it("refuses a patch with too little detail to track", () => {
		const screen = createSyntheticScreen();
		const frame = createTrackerFrame(screen.render());
		// Inside the pane but away from any row: flat background.
		const blank: SourceRectPx = { x: 900, y: 620, w: 200, h: 40 };
		const result = BlurTracker.create(frame, blank, 0);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("low-detail");
		expect(result.stdDev).toBeLessThan(BLUR_TRACKER_TUNING.minTemplateStdDev);
	});

	it("accepts a textured patch and reports its standard deviation", () => {
		const screen = createSyntheticScreen();
		const result = BlurTracker.create(createTrackerFrame(screen.render()), screen.cellRect, 0);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.tracker.getTemplateStdDev()).toBeGreaterThan(
			BLUR_TRACKER_TUNING.minTemplateStdDev,
		);
		expect(result.tracker.getPatchScale()).toBe(1);
	});

	it("refuses a degenerate rectangle", () => {
		const screen = createSyntheticScreen();
		const frame = createTrackerFrame(screen.render());
		const result = BlurTracker.create(frame, { x: 100, y: 100, w: 0, h: 20 }, 0);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("degenerate-rect");
	});
});

describe("known scroll", () => {
	it("recovers vertical offsets exactly", () => {
		const screen = createSyntheticScreen();
		const tracker = trackerFor(screen);
		const steps = [1, 3, 8, 25, 60, 130];
		const offsets: Array<{ y: number }> = [];
		for (const step of steps) offsets.push({ y: (offsets.at(-1)?.y ?? 0) + step });
		const samples = runScroll(tracker, screen, offsets);

		samples.forEach((sample, index) => {
			const truth = screen.cellRectAt(offsets[index].y);
			expect(sample.state, `after +${steps[index]} px`).toBe("found");
			expect(errorPx(sample, truth), `after +${steps[index]} px`).toBeLessThanOrEqual(1);
			expect(sample.score).toBeGreaterThanOrEqual(BLUR_TRACKER_TUNING.foundScore);
		});
	});

	it("recovers horizontal offsets exactly", () => {
		const screen = createSyntheticScreen();
		const tracker = trackerFor(screen);
		const offsets = [
			{ y: 0, x: -40 },
			{ y: 0, x: -28 },
			{ y: 0, x: 12 },
		];
		const samples = runScroll(tracker, screen, offsets);
		samples.forEach((sample, index) => {
			const truth = screen.cellRectAt(0, offsets[index].x);
			expect(sample.state).toBe("found");
			expect(errorPx(sample, truth)).toBeLessThanOrEqual(1);
		});
	});

	// The profiles are per-axis, so a move with a component on both axes can
	// leave one axis's peak out of the candidate list. The coarse relocation pass
	// is what recovers it; without that pass a step of 8 x 6 px is lost.
	it.each([
		[4, 3],
		[8, 6],
		[12, 8],
		[24, 16],
	])("recovers a diagonal move of %i x %i px per sample", (dy, dx) => {
		const screen = createSyntheticScreen();
		const tracker = trackerFor(screen);
		const offsets = Array.from({ length: 5 }, (_unused, index) => ({
			y: dy * (index + 1),
			x: dx * (index + 1),
		}));
		const samples = runScroll(tracker, screen, offsets);
		samples.forEach((sample, index) => {
			const truth = screen.cellRectAt(offsets[index].y, offsets[index].x);
			expect(sample.state, `sample ${index}`).toBe("found");
			expect(errorPx(sample, truth), `sample ${index}`).toBeLessThanOrEqual(1);
		});
	});

	it("follows a window dragged in one jump and then held still", () => {
		const screen = createSyntheticScreen();
		const tracker = trackerFor(screen);
		const offsets = [{ y: 0, x: 0 }, ...Array.from({ length: 4 }, () => ({ y: 96, x: 64 }))];
		const samples = runScroll(tracker, screen, offsets);
		samples.forEach((sample, index) => {
			const truth = screen.cellRectAt(offsets[index].y, offsets[index].x);
			expect(sample.state, `sample ${index}`).toBe("found");
			expect(errorPx(sample, truth), `sample ${index}`).toBeLessThanOrEqual(1);
		});
	});

	it("holds a still frame in place instead of drifting", () => {
		const screen = createSyntheticScreen();
		const tracker = trackerFor(screen);
		const samples = runScroll(
			tracker,
			screen,
			Array.from({ length: 10 }, () => ({ y: 0 })),
		);
		for (const sample of samples) {
			expect(sample.state).toBe("found");
			expect(errorPx(sample, screen.cellRect)).toBe(0);
		}
	});
});

describe("off-screen and back", () => {
	it("goes lost while the content is off the pane and re-acquires when it returns", () => {
		const screen = createSyntheticScreen();
		const tracker = trackerFor(screen);
		const away = [-100, -200, -320, -420, -420, -420, -420, -420];
		const back = [-320, -200, -100, 0];
		const samples = runScroll(
			tracker,
			screen,
			[...away, ...back].map((y) => ({ y })),
		);

		// While the cell is on the pane the track is exact.
		expect(samples[0].state).toBe("found");
		expect(samples[1].state).toBe("found");
		// Off the pane it must end up lost rather than following something else.
		expect(samples.slice(3, away.length).some((sample) => sample.state === "lost")).toBe(true);
		expect(samples[away.length - 1].state).toBe("lost");

		// Coming back it re-acquires, and where it lands is the real cell.
		const reacquired = samples.findIndex(
			(sample, index) => index >= away.length && sample.reacquired,
		);
		expect(reacquired).toBeGreaterThan(-1);
		const truth = screen.cellRectAt([...away, ...back][reacquired]);
		expect(errorPx(samples[reacquired], truth)).toBeLessThanOrEqual(1);

		// ...and the last samples are back on the content.
		const last = samples.at(-1)!;
		expect(last.state).toBe("found");
		expect(errorPx(last, screen.cellRect)).toBeLessThanOrEqual(1);
	});

	it("holds the last known rectangle while lost", () => {
		const screen = createSyntheticScreen();
		const tracker = trackerFor(screen);
		const samples = runScroll(
			tracker,
			screen,
			[-100, -420, -420, -420, -420, -420].map((y) => ({ y })),
		);
		const lost = samples.filter((sample) => sample.state === "lost");
		expect(lost.length).toBeGreaterThan(0);
		for (const sample of lost) {
			expect(sample.x).toBe(lost[0].x);
			expect(sample.y).toBe(lost[0].y);
			expect(sample.w).toBe(screen.cellRect.w);
			expect(sample.h).toBe(screen.cellRect.h);
		}
	});
});

describe("robustness", () => {
	it("tracks through gaussian noise at sigma 8", () => {
		const screen = createSyntheticScreen();
		const tracker = trackerFor(screen, { noise: 8 });
		const offsets = [20, 40, 60, 80, 100].map((y) => ({ y }));
		const samples = runScroll(tracker, screen, offsets, (offset, index) =>
			screen.render({ scrollY: offset.y, noise: 8, noiseSeed: 100 + index }),
		);
		samples.forEach((sample, index) => {
			expect(sample.state).toBe("found");
			expect(sample.score).toBeGreaterThanOrEqual(0.8);
			expect(errorPx(sample, screen.cellRectAt(offsets[index].y))).toBeLessThanOrEqual(1);
		});
	});

	it("never loses the patch to a cursor crossing it", () => {
		const screen = createSyntheticScreen();
		const tracker = trackerFor(screen);
		const cell = screen.cellRect;
		const samples = runScroll(
			tracker,
			screen,
			Array.from({ length: 6 }, () => ({ y: 0 })),
			(_offset, index) =>
				screen.render({ cursor: { x: cell.x + 30 + index * 30, y: cell.y - 2, size: 20 } }),
		);
		expect(samples.some((sample) => sample.state === "lost")).toBe(false);
		expect(samples.filter((sample) => sample.state === "tentative").length).toBeLessThanOrEqual(2);
		for (const sample of samples) expect(errorPx(sample, cell)).toBeLessThanOrEqual(1);
	});
});

describe("partial occlusion", () => {
	const screen = createSyntheticScreen();
	const cell = screen.cellRect;
	const midX = cell.x + cell.w / 2;
	const midY = cell.y + cell.h / 2;
	/** Left half plus the top-right quarter: three quadrants gone, one clean. */
	const threeQuarters: SourceRectPx[] = [
		{ x: cell.x - 8, y: cell.y - 6, w: cell.w / 2 + 8, h: cell.h + 12 },
		{ x: midX, y: cell.y - 6, w: cell.w / 2 + 8, h: midY - cell.y + 6 },
	];
	const whole: SourceRectPx[] = [{ x: cell.x - 8, y: cell.y - 6, w: cell.w + 16, h: cell.h + 12 }];

	it("keeps the blur on when one quadrant is still the same content", () => {
		const tracker = trackerFor(screen);
		const samples = runScroll(
			tracker,
			screen,
			Array.from({ length: 3 }, () => ({ y: 0 })),
			() => screen.render({ occluder: threeQuarters }),
		);
		for (const sample of samples) {
			expect(sample.state).toBe("found");
			expect(sample.maxQuadrantScore).toBeGreaterThanOrEqual(
				BLUR_TRACKER_TUNING.quadrantFoundScore,
			);
			expect(sample.score).toBeLessThan(BLUR_TRACKER_TUNING.foundScore);
			expect(errorPx(sample, cell)).toBe(0);
		}
	});

	it("goes lost after the tentative streak when the patch is covered entirely", () => {
		const tracker = trackerFor(screen);
		const samples = runScroll(
			tracker,
			screen,
			Array.from({ length: 5 }, () => ({ y: 0 })),
			() => screen.render({ occluder: whole }),
		);
		expect(samples.slice(0, BLUR_TRACKER_TUNING.maxTentativeStreak).map((s) => s.state)).toEqual(
			Array(BLUR_TRACKER_TUNING.maxTentativeStreak).fill("tentative"),
		);
		expect(samples.at(-1)!.state).toBe("lost");
	});

	it("comes back when the occluder is removed", () => {
		const tracker = trackerFor(screen);
		runScroll(
			tracker,
			screen,
			Array.from({ length: 5 }, () => ({ y: 0 })),
			() => screen.render({ occluder: whole }),
		);
		const samples = runScroll(
			tracker,
			screen,
			Array.from({ length: 2 }, () => ({ y: 0 })),
			() => screen.render({}),
		);
		expect(samples[0].state).toBe("found");
		expect(samples[0].reacquired).toBe(true);
		expect(errorPx(samples[0], cell)).toBe(0);
	});
});

describe("similar rows (kill criterion)", () => {
	const screen = createSyntheticScreen({ uniformWordLengths: true, rowHeight: 24, rowCount: 40 });

	it("follows the correct row when the pane scrolls by one and a half rows", () => {
		const tracker = trackerFor(screen);
		const offsets = Array.from({ length: 8 }, (_unused, index) => ({ y: 36 * (index + 1) }));
		const samples = runScroll(tracker, screen, offsets);
		samples.forEach((sample, index) => {
			const truth = screen.cellRectAt(offsets[index].y);
			expect(sample.state, `sample ${index}`).toBe("found");
			expect(errorPx(sample, truth), `sample ${index}`).toBeLessThanOrEqual(1);
		});
	});

	/**
	 * The kill criterion (§5): if the right row cannot beat the best wrong row by
	 * at least 0.1 the core failure mode is unbounded and the feature ships wrong
	 * blurs. Measured directly on the score surface, not inferred from a track.
	 */
	it("beats the best wrong row by a clear margin", () => {
		const anchor = screen.render({ scrollY: 0 });
		const scrolled = screen.render({ scrollY: 36 });
		const cell = screen.cellRect;
		const template = boxBlur3(sampleGray(anchor, cell, cell.w, cell.h));
		const strip = boxBlur3(
			sampleGray(scrolled, { x: cell.x, y: 0, w: cell.w, h: screen.height }, cell.w, screen.height),
		);
		const integrals = integralImages(strip);
		const probe = {
			image: template,
			sum: template.data.reduce((total, value) => total + value, 0),
			sumSq: template.data.reduce((total, value) => total + value * value, 0),
			count: template.data.length,
			stdDev: 1,
			quadrants: [
				{
					x0: 0,
					y0: 0,
					x1: template.width,
					y1: template.height,
					sum: 0,
					sumSq: 0,
					count: template.data.length,
				},
			],
		};

		const truthY = screen.cellRectAt(36).y;
		let bestRight = -1;
		let bestWrong = -1;
		for (let v = 0; v + template.height <= strip.height; v++) {
			const score = nccWhole(probe, strip, integrals, 0, v);
			// "Wrong" means a different row, not a pixel or two off the right one.
			if (Math.abs(v - truthY) <= 12) bestRight = Math.max(bestRight, score);
			else bestWrong = Math.max(bestWrong, score);
		}

		expect(bestRight).toBeGreaterThanOrEqual(BLUR_TRACKER_TUNING.foundScore);
		expect(bestRight - bestWrong).toBeGreaterThanOrEqual(0.1);
	});

	it("does not re-acquire on a row that only nearly matches", () => {
		// A lookalike must clear both the coarse and the fine re-acquisition bars.
		expect(BLUR_TRACKER_TUNING.reacquireCoarseScore).toBeGreaterThan(
			BLUR_TRACKER_TUNING.foundScore,
		);
		expect(BLUR_TRACKER_TUNING.reacquireFineScore).toBeGreaterThan(BLUR_TRACKER_TUNING.foundScore);

		// Re-rendering the rows with different glyphs leaves a page that looks the
		// same and is not the same content: the tracker must stay lost.
		const tracker = trackerFor(screen);
		runScroll(
			tracker,
			screen,
			Array.from({ length: 6 }, () => ({ y: -420 })),
		);
		const samples = runScroll(
			tracker,
			screen,
			Array.from({ length: 6 }, () => ({ y: 0 })),
			() => screen.render({ scrollY: 0, rerenderSeed: 999 }),
		);
		for (const sample of samples) expect(sample.state).toBe("lost");
	});
});

describe("determinism", () => {
	it("produces identical samples on a second run over the same frames", () => {
		const screen = createSyntheticScreen();
		const offsets = [8, 24, 24, 60, -400, -400, -400, 0, 30].map((y) => ({ y }));
		const first = runScroll(trackerFor(screen), screen, offsets);
		const second = runScroll(trackerFor(screen), screen, offsets);
		expect(second).toEqual(first);
	});

	it("does not depend on how the frames were produced, only on their pixels", () => {
		const screen = createSyntheticScreen();
		const offsets = [12, 36, 90].map((y) => ({ y }));
		const rendered = offsets.map((offset) => screen.render({ scrollY: offset.y }));
		const first = runScroll(trackerFor(screen), screen, offsets, (_o, index) => rendered[index]);
		const second = runScroll(trackerFor(screen), screen, offsets, (_o, index) => ({
			// Same pixels, a fresh buffer.
			data: Uint8Array.from(rendered[index].data),
			width: rendered[index].width,
			height: rendered[index].height,
		}));
		expect(second).toEqual(first);
	});
});
