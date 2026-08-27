import { CAPTION_MODEL_APPROX_BYTES, CAPTION_MODEL_ID, ORT_WASM_PUBLIC_DIR } from './captionConstants';

/**
 * Renderer-side view of the Whisper model cache managed by
 * `electron/ipc/captionHandlers.ts`: where the files are, whether they are
 * present, and a download helper with progress + cancellation.
 */

export interface CaptionModelStatus {
  modelId: string;
  /** All required files are on disk. */
  present: boolean;
  /** Absolute directory that contains `<modelId>/...` (main-process path). */
  dir: string;
  downloadedBytes: number;
  /** Approximate size of the full download (used for progress and the prompt). */
  totalBytes: number;
  missingFiles: string[];
}

export interface CaptionModelProgress {
  modelId: string;
  file: string;
  fileIndex: number;
  fileCount: number;
  downloadedBytes: number;
  totalBytes: number;
}

/** Minimal slice of `window.electronAPI` this module needs (mockable in tests). */
export interface CaptionModelApi {
  captionModelDirUrl?: string;
  getCaptionModelStatus: (modelId?: string) => Promise<{ success: boolean; status?: CaptionModelStatus; message?: string }>;
  downloadCaptionModel: (modelId?: string) => Promise<{ success: boolean; aborted?: boolean; message?: string }>;
  cancelCaptionModelDownload: () => Promise<{ success: boolean }>;
  onCaptionModelProgress: (callback: (progress: CaptionModelProgress) => void) => () => void;
}

function resolveApi(api?: CaptionModelApi): CaptionModelApi | null {
  if (api) return api;
  if (typeof window === 'undefined') return null;
  const candidate = window.electronAPI as unknown as Partial<CaptionModelApi> | undefined;
  if (!candidate || typeof candidate.getCaptionModelStatus !== 'function') return null;
  return candidate as CaptionModelApi;
}

/** True when the desktop shell exposes the model manager (Electron + preload). */
export function isWhisperWebAvailable(api?: CaptionModelApi): boolean {
  const resolved = resolveApi(api);
  return Boolean(resolved?.captionModelDirUrl);
}

/** `file://` URL (trailing slash) of the model root, or null outside Electron. */
export function getCaptionModelDirUrl(api?: CaptionModelApi): string | null {
  const url = resolveApi(api)?.captionModelDirUrl;
  return url ? (url.endsWith('/') ? url : `${url}/`) : null;
}

/**
 * Base URL of the bundled ONNX Runtime wasm files. They are emitted next to the
 * renderer bundle (`dist/ort/`, see the `ort-wasm` plugin in vite.config.ts), so
 * resolving against the page URL works for both `http://localhost` (dev) and
 * `file://.../dist/index.html` (packaged).
 */
export function getOrtWasmBaseUrl(pageHref: string = window.location.href): string {
  return new URL(ORT_WASM_PUBLIC_DIR, pageHref).href;
}

export async function getCaptionModelStatus(api?: CaptionModelApi): Promise<CaptionModelStatus | null> {
  const resolved = resolveApi(api);
  if (!resolved) return null;
  const result = await resolved.getCaptionModelStatus(CAPTION_MODEL_ID);
  if (!result.success || !result.status) return null;
  return result.status;
}

export interface EnsureCaptionModelOptions {
  api?: CaptionModelApi;
  /**
   * Asked once when the model is missing. Resolve `true` to download, `false` to
   * skip (the caller then reports "model not available").
   */
  confirmDownload: (status: CaptionModelStatus) => Promise<boolean>;
  onProgress?: (progress: CaptionModelProgress) => void;
  signal?: AbortSignal;
}

export type EnsureCaptionModelOutcome =
  | { state: 'ready' }
  | { state: 'declined' }
  | { state: 'aborted' }
  | { state: 'failed'; message: string };

/**
 * Makes sure the model files are on disk: no-op when present, otherwise prompts
 * (via `confirmDownload`) and streams the download with progress. Cancellation
 * goes through `signal` -> `cancelCaptionModelDownload`.
 */
export async function ensureCaptionModel(options: EnsureCaptionModelOptions): Promise<EnsureCaptionModelOutcome> {
  const api = resolveApi(options.api);
  if (!api) {
    return { state: 'failed', message: 'Caption model manager is not available in this window.' };
  }

  const status = await getCaptionModelStatus(api);
  if (status?.present) return { state: 'ready' };

  const promptStatus: CaptionModelStatus = status ?? {
    modelId: CAPTION_MODEL_ID,
    present: false,
    dir: '',
    downloadedBytes: 0,
    totalBytes: CAPTION_MODEL_APPROX_BYTES,
    missingFiles: [],
  };
  const accepted = await options.confirmDownload(promptStatus);
  if (!accepted) return { state: 'declined' };
  if (options.signal?.aborted) return { state: 'aborted' };

  const unsubscribe = options.onProgress ? api.onCaptionModelProgress(options.onProgress) : () => undefined;
  const onAbort = () => {
    void api.cancelCaptionModelDownload();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await api.downloadCaptionModel(CAPTION_MODEL_ID);
    if (result.success) return { state: 'ready' };
    if (result.aborted || options.signal?.aborted) return { state: 'aborted' };
    return { state: 'failed', message: result.message || 'Caption model download failed.' };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    unsubscribe();
  }
}

/** Human-friendly "12.3 MB" formatting for progress toasts. */
export function formatMegabytes(bytes: number): string {
  return `${(Math.max(0, bytes) / 1_000_000).toFixed(1)} MB`;
}
