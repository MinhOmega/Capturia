// Two contracts are asserted here, and neither is about pixels.
//
// 1. SEQUENCING — a batch stops at the first failure, and a cancel stops the
//    BATCH rather than just the file in flight. The result has to say which
//    files are real, because "three ratios, the second failed" is otherwise a
//    folder the user has to guess at.
//
// 2. PATH AGREEMENT — the names a batch writes must survive the approval policy
//    in `electron/exportPolicy.ts`, which refuses an unregistered path QUIETLY
//    on the `write-export-to-path` route: the symptom is a file that simply
//    never appears. `subtitleSidecarPath` has to land on the same stem, so the
//    three rules (derive / approve / sidecar) are pinned against each other
//    here rather than trusted to stay in step.

import nodePath from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovedExportPaths, batchExportPaths } from "../../../electron/exportPolicy";
import { subtitleSidecarPath } from "../ai-edition/captions/subtitles";
import { EXPORT_CANCELLED_TOKEN, runBatchExport } from "./batchExport";

describe("runBatchExport sequencing", () => {
	it("runs every destination in order when all succeed", async () => {
		const seen: string[] = [];
		const result = await runBatchExport(["/o/a.mp4", "/o/b.mp4", "/o/c.mp4"], async (dest) => {
			seen.push(dest);
		});

		expect(seen).toEqual(["/o/a.mp4", "/o/b.mp4", "/o/c.mp4"]);
		expect(result.completed).toEqual(["/o/a.mp4", "/o/b.mp4", "/o/c.mp4"]);
		expect(result.failure).toBeUndefined();
		expect(result.skipped).toEqual([]);
	});

	it("stops at a mid-batch failure and reports which files are real", async () => {
		const attempted: string[] = [];
		const result = await runBatchExport(["/o/a.mp4", "/o/b.mp4", "/o/c.mp4"], async (dest) => {
			attempted.push(dest);
			if (dest === "/o/b.mp4") throw new Error("encoder said no");
		});

		// The third was never started — the user is not left wondering whether a
		// file that does not exist was supposed to.
		expect(attempted).toEqual(["/o/a.mp4", "/o/b.mp4"]);
		expect(result.completed).toEqual(["/o/a.mp4"]);
		expect(result.stoppedAt).toBe("/o/b.mp4");
		expect(result.skipped).toEqual(["/o/c.mp4"]);
		expect(result.failure).toEqual({ kind: "error", message: "encoder said no" });
	});

	it("stops the whole batch on a cancel, not just the file in flight", async () => {
		const attempted: string[] = [];
		const result = await runBatchExport(["/o/a.mp4", "/o/b.mp4", "/o/c.mp4"], async (dest) => {
			attempted.push(dest);
			if (dest === "/o/b.mp4") throw new Error(`export failed: ${EXPORT_CANCELLED_TOKEN}`);
		});

		expect(attempted).toEqual(["/o/a.mp4", "/o/b.mp4"]);
		expect(result.completed).toEqual(["/o/a.mp4"]);
		expect(result.skipped).toEqual(["/o/c.mp4"]);
		// Classified as a cancel so the dialog goes back to the form instead of
		// raising an error panel over a decision the user made on purpose.
		expect(result.failure?.kind).toBe("cancelled");
	});

	it("treats an empty destination list as a no-op rather than an error", async () => {
		const result = await runBatchExport([], async () => {
			throw new Error("must not run");
		});
		expect(result).toEqual({ completed: [], skipped: [] });
	});
});

describe("batchExportPaths", () => {
	it("suffixes before the extension, one file per ratio, in order", () => {
		expect(batchExportPaths("/o/demo.mp4", ["16:9", "9:16", "1:1"], nodePath.posix)).toEqual([
			"/o/demo-16x9.mp4",
			"/o/demo-9x16.mp4",
			"/o/demo-1x1.mp4",
		]);
	});

	it("keeps the container extension a GIF batch needs", () => {
		expect(batchExportPaths("/o/demo.gif", ["1:1"], nodePath.posix)).toEqual(["/o/demo-1x1.gif"]);
	});

	it("drops a token that is not a W:H shape, so nothing can escape the folder", () => {
		// The renderer supplies these. A separator, a traversal or an extension in a
		// "ratio" must not become part of a filename.
		expect(
			batchExportPaths(
				"/o/demo.mp4",
				["../../etc/passwd", "16:9", "/abs", "9:16.mp4", "native", ""],
				nodePath.posix,
			),
		).toEqual(["/o/demo-16x9.mp4"]);
	});

	it("collapses two tokens that reduce to the same destination", () => {
		// Otherwise two jobs would race for one file and the second would silently
		// overwrite the first.
		expect(batchExportPaths("/o/demo.mp4", ["16:9", "16:9"], nodePath.posix)).toEqual([
			"/o/demo-16x9.mp4",
		]);
	});

	it("refuses a base path with no approvable container extension", () => {
		expect(batchExportPaths("/o/demo.txt", ["16:9"], nodePath.posix)).toEqual([]);
	});
});

describe("batch destinations survive the approval policy", () => {
	it("approves every derived path and its subtitle sidecars", () => {
		const approvals = new ApprovedExportPaths(nodePath.posix);
		const derived = batchExportPaths("/o/demo.mp4", ["16:9", "9:16", "1:1"], nodePath.posix);
		expect(derived).toHaveLength(3);

		for (const destination of derived) {
			// This is the call the save-dialog handler makes for each sibling.
			expect(approvals.approve(destination)).toBe(destination);
		}

		for (const destination of derived) {
			expect(approvals.isApproved(destination)).toBe(true);
			// The sidecar writer derives its own name from the video path. If that
			// derivation ever drifts from `approve`'s, the subtitles vanish without
			// an error — so assert the two land on the same string.
			expect(approvals.isApproved(subtitleSidecarPath(destination, "srt"))).toBe(true);
			expect(approvals.isApproved(subtitleSidecarPath(destination, "vtt"))).toBe(true);
		}
	});

	it("does not approve a sibling the user never picked", () => {
		const approvals = new ApprovedExportPaths(nodePath.posix);
		for (const destination of batchExportPaths("/o/demo.mp4", ["16:9"], nodePath.posix)) {
			approvals.approve(destination);
		}
		// Approving the 16:9 output must not make the un-chosen 9:16 name writable.
		expect(approvals.isApproved("/o/demo-9x16.mp4")).toBe(false);
		expect(approvals.isApproved("/o/demo.mp4")).toBe(false);
	});
});
