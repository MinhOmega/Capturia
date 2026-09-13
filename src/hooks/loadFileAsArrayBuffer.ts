import { MAX_IN_MEMORY_SOURCE_BYTES } from "@/lib/exporter/sourceFileLimits";

/**
 * Loads a video file as an ArrayBuffer via the local (Electron IPC) or remote loader.
 * contentType is empty for local IPC reads, which carry no Content-Type.
 */
export async function loadFileAsArrayBuffer(
	videoUrl: string,
): Promise<{ data: ArrayBuffer; contentType: string }> {
	const isRemoteUrl = /^(https?:|blob:|data:)/i.test(videoUrl);

	if (!isRemoteUrl && window.electronAPI) {
		// This path loads the entire file into an ArrayBuffer for decodeAudioData,
		// and readBinaryFile also copies the bytes in the main process during IPC,
		// so a large recording would exhaust memory and crash. Callers must route
		// oversized files elsewhere (useAudioPeaks streams peaks via
		// computePeaksFromFileStreaming); this guard is a safety net for any
		// caller that does not.
		const info = await window.electronAPI.getReadableFileInfo?.(videoUrl);
		if (info?.success && typeof info.size === "number" && info.size > MAX_IN_MEMORY_SOURCE_BYTES) {
			throw new Error("Recording is too large to load into memory for waveform rendering.");
		}
		const result = await window.electronAPI.readBinaryFile(videoUrl);
		if (!result.success || !result.data) {
			throw new Error(result.message || result.error || "Failed to read source video");
		}
		return { data: result.data, contentType: "" };
	}

	const response = await fetch(videoUrl);
	if (!response.ok) {
		throw new Error(`Failed to fetch source video: ${response.status} ${response.statusText}`);
	}
	const blob = await response.blob();
	return { data: await blob.arrayBuffer(), contentType: blob.type };
}
