/**
 * Pure helpers that turn an export/save failure into a multi-line diagnostic
 * message (rendered with `whitespace-pre-line` in the export dialog). Ported
 * from upstream OpenScreen `VideoEditor.tsx` (156e9c1e), made label-injectable
 * so the editor can pass translated labels.
 */

export type ExportFormatLabel = 'GIF' | 'Video';

export interface ExportDiagnostics {
  formatLabel: ExportFormatLabel;
  reason?: string;
  sourcePath?: string | null;
  width?: number;
  height?: number;
  frameRate?: number;
  codec?: string;
  bitrate?: number;
  /** Override for tests; defaults to `typeof VideoEncoder !== 'undefined'`. */
  videoEncoderAvailable?: boolean;
}

export interface ExportDiagnosticLabels {
  /** `{{format}}` is replaced with the format label. */
  exportFailed: string;
  /** `{{format}}` is replaced with the format label. */
  saveFailed: string;
  reason: string;
  source: string;
  output: string;
  codec: string;
  bitrate: string;
  videoEncoder: string;
  available: string;
  unavailable: string;
}

export const DEFAULT_EXPORT_DIAGNOSTIC_LABELS: ExportDiagnosticLabels = {
  exportFailed: '{{format}} export failed',
  saveFailed: '{{format}} export save failed',
  reason: 'Reason',
  source: 'Source',
  output: 'Output',
  codec: 'Codec',
  bitrate: 'Bitrate',
  videoEncoder: 'VideoEncoder',
  available: 'available',
  unavailable: 'unavailable',
};

function fillFormat(template: string, formatLabel: string): string {
  return template.replace(/\{\{format\}\}/g, formatLabel);
}

/** Base name of a path or `file://` URL; "unknown" when absent. */
export function getFileNameForDiagnostics(filePath?: string | null): string {
  if (!filePath) return 'unknown';

  try {
    const url = new URL(filePath);
    if (url.protocol === 'file:') {
      return decodeURIComponent(url.pathname).split(/[\\/]/).pop() || filePath;
    }
  } catch {
    // Treat non-URL values as filesystem paths.
  }

  return filePath.split(/[\\/]/).pop() || filePath;
}

function isVideoEncoderAvailable(): boolean {
  return typeof VideoEncoder !== 'undefined';
}

export function buildExportDiagnosticMessage(
  diagnostics: ExportDiagnostics,
  labels: Partial<ExportDiagnosticLabels> = {},
): string {
  const l = { ...DEFAULT_EXPORT_DIAGNOSTIC_LABELS, ...labels };
  const encoderAvailable = diagnostics.videoEncoderAvailable ?? isVideoEncoderAvailable();
  const details = [
    diagnostics.reason ? `${l.reason}: ${diagnostics.reason}` : null,
    `${l.source}: ${getFileNameForDiagnostics(diagnostics.sourcePath)}`,
    diagnostics.width && diagnostics.height
      ? `${l.output}: ${diagnostics.width}x${diagnostics.height}${
          diagnostics.frameRate ? ` @ ${diagnostics.frameRate} fps` : ''
        }`
      : null,
    diagnostics.codec ? `${l.codec}: ${diagnostics.codec}` : null,
    diagnostics.bitrate ? `${l.bitrate}: ${Math.round(diagnostics.bitrate / 1_000_000)} Mbps` : null,
    `${l.videoEncoder}: ${encoderAvailable ? l.available : l.unavailable}`,
  ].filter(Boolean);

  return `${fillFormat(l.exportFailed, diagnostics.formatLabel)}\n${details.join('\n')}`;
}

export function buildSaveDiagnosticMessage(
  formatLabel: ExportFormatLabel,
  reason?: string,
  labels: Partial<ExportDiagnosticLabels> = {},
): string {
  const l = { ...DEFAULT_EXPORT_DIAGNOSTIC_LABELS, ...labels };
  return `${fillFormat(l.saveFailed, formatLabel)}${reason ? `\n${l.reason}: ${reason}` : ''}`;
}
