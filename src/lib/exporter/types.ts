export interface ExportProgress {
	currentFrame: number;
	totalFrames: number;
	percentage: number;
	estimatedTimeRemaining: number; // seconds
	phase?: "preparing" | "extracting" | "finalizing";
	renderProgress?: number; // 0-100, GIF render phase
}

export type ExportQuality = "medium" | "good" | "source";

// GIF Export Types
export type ExportFormat = "mp4" | "gif";

/** Video codec for the MP4 container. GIF is a single codec, so this doesn't
 *  apply to it. (`vp9` is offered by the type but the native exporter rejects
 *  it with a clear message — there is no hardware AMF equivalent and the
 *  software path measured too slow to ship.) */
export type ExportVideoCodec = "h264" | "h265" | "vp9";

export type GifFrameRate = 15 | 20 | 25 | 30;

export type GifSizePreset = "medium" | "large" | "original";

export const GIF_SIZE_PRESETS: Record<GifSizePreset, { maxHeight: number; label: string }> = {
	medium: { maxHeight: 720, label: "Medium (720p)" },
	large: { maxHeight: 1080, label: "Large (1080p)" },
	original: { maxHeight: Infinity, label: "Original" },
};

export const GIF_FRAME_RATES: { value: GifFrameRate }[] = [
	{ value: 15 },
	{ value: 20 },
	{ value: 25 },
	{ value: 30 },
];
