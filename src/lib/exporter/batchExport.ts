// Sequencing for a multi-aspect batch export: N single-file exports, one after
// another, sharing one save dialog.
//
// It is deliberately NOT a second exporter. `exportOne` is the existing
// single-file path (native export + subtitle sidecars) with one destination
// bound in; everything this module owns is the ORDER, the stop condition, and
// the accounting of which files are real when a run ends early.
//
// Sequential on purpose. The native compositor exports through one GPU pipeline
// and one cancel flag (`crates/compositor/src/cancel.rs`), so two concurrent
// exports would contend for both — and a cancel could not say which one it meant.

/** The compositor rejects with this token when the frame walk saw the cancel flag.
 *  Matched on the message because that is all that survives the napi -> IPC hops;
 *  it is untranslated precisely so the test is language-proof. */
export const EXPORT_CANCELLED_TOKEN = "EXPORT_CANCELLED";

export function isCancellation(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes(EXPORT_CANCELLED_TOKEN);
}

export interface BatchExportResult {
	/** Destinations that finished and are complete files on disk, in write order. */
	completed: string[];
	/** The destination that did not finish. Absent when the whole batch succeeded.
	 *  The compositor's cleanup facade (`partial_output.rs`) removes this file on any
	 *  `Err`, cancel included, so it is a path that should NOT exist afterwards. */
	stoppedAt?: string;
	/** Destinations never attempted because the run stopped first. */
	skipped: string[];
	/** Why it stopped. Absent when every destination finished. */
	failure?: { kind: "cancelled" | "error"; message: string };
}

/**
 * Run one export per destination, in order, stopping at the first failure.
 *
 * A cancel stops the BATCH, not just the file in flight: the user asked for the
 * run to end, and starting the next ratio because the previous one "merely" got
 * cancelled is the bug this exists to prevent. Same for an error — continuing
 * past one would bury the message under later progress and leave the user unable
 * to tell which of N files are trustworthy, which is exactly what `completed`
 * and `skipped` are for.
 */
export async function runBatchExport(
	destinations: readonly string[],
	exportOne: (destination: string, index: number) => Promise<void>,
): Promise<BatchExportResult> {
	const completed: string[] = [];
	for (let index = 0; index < destinations.length; index += 1) {
		const destination = destinations[index];
		try {
			await exportOne(destination, index);
			completed.push(destination);
		} catch (error) {
			return {
				completed,
				stoppedAt: destination,
				skipped: destinations.slice(index + 1),
				failure: {
					kind: isCancellation(error) ? "cancelled" : "error",
					message: error instanceof Error ? error.message : String(error),
				},
			};
		}
	}
	return { completed, skipped: [] };
}
