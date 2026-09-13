import type {
	CursorCapabilities,
	CursorRecordingData,
	CursorTelemetryPoint,
} from "../../../src/native/contracts";
import type { TelemetryCursorAdapter } from "../cursor/telemetryCursorAdapter";

interface CursorServiceOptions {
	adapter: TelemetryCursorAdapter;
}

export class CursorService {
	constructor(private readonly options: CursorServiceOptions) {}

	async getCapabilities(): Promise<CursorCapabilities> {
		return this.options.adapter.getCapabilities();
	}

	async getTelemetry(videoPath?: string | null): Promise<CursorTelemetryPoint[]> {
		const result = await this.options.adapter.getTelemetry(videoPath);
		if (!result.success) {
			throw new Error(result.message || result.error || "Failed to load cursor telemetry");
		}

		return result.samples;
	}

	async getRecordingData(videoPath?: string | null): Promise<CursorRecordingData> {
		return this.options.adapter.getRecordingData(videoPath);
	}
}
