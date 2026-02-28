import { Loader2, CheckCircle2, XCircle, ChevronUp } from 'lucide-react';
import type { ExportProgress } from '@/lib/exporter';
import { useI18n } from '@/i18n';

interface ExportProgressFloatProps {
  progress: ExportProgress | null;
  isExporting: boolean;
  error: string | null;
  exportFormat: 'mp4' | 'gif';
  batchProgress?: {
    current: number;
    total: number;
    aspectRatio: string;
  } | null;
  onClick: () => void;
}

export function ExportProgressFloat({
  progress,
  isExporting,
  error,
  exportFormat,
  batchProgress,
  onClick,
}: ExportProgressFloatProps) {
  const { t } = useI18n();

  const isCompiling = isExporting && progress && progress.percentage >= 100 && exportFormat === 'gif';
  const isFinalizing = progress?.phase === 'finalizing';
  const renderProgress = progress?.renderProgress;
  const percentage = isCompiling || (isFinalizing && exportFormat === 'gif')
    ? (renderProgress !== undefined && renderProgress > 0 ? renderProgress : undefined)
    : progress?.percentage ?? 0;

  const getPhaseLabel = () => {
    if (error) return t('export.titleFailed');
    if (isCompiling) return t('export.titleCompilingGif');
    if (isFinalizing) return exportFormat === 'gif' ? t('export.titleCompilingGif') : t('export.titleFinalizingVideo');
    return t('export.phaseRendering');
  };

  const formatEta = (seconds: number) => {
    const safe = Math.max(0, Math.floor(seconds));
    const m = Math.floor(safe / 60);
    const s = safe % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const isDone = !isExporting && progress && progress.percentage >= 100 && !error;

  return (
    <div
      onClick={onClick}
      className="fixed bottom-6 right-6 z-40 cursor-pointer select-none animate-in slide-in-from-bottom-4 duration-300"
    >
      <div className="bg-[#0a0a0c] border border-white/10 rounded-xl shadow-2xl shadow-black/40 px-4 py-3 min-w-[280px] max-w-[340px] hover:border-white/20 transition-colors">
        {/* Header row */}
        <div className="flex items-center gap-3 mb-2">
          {error ? (
            <XCircle className="w-5 h-5 text-red-400 shrink-0" />
          ) : isDone ? (
            <CheckCircle2 className="w-5 h-5 text-[#34B27B] shrink-0" />
          ) : (
            <Loader2 className="w-5 h-5 text-[#34B27B] animate-spin shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-slate-200 truncate">
              {isDone ? t('export.complete') : getPhaseLabel()}
            </div>
            <div className="text-[11px] text-slate-500">
              {error
                ? t('export.statusTryAgain')
                : isDone
                  ? t('export.ready', { format: exportFormat === 'gif' ? 'gif' : 'video' })
                  : batchProgress && batchProgress.total > 1
                    ? t('export.batchProgress', { current: batchProgress.current, total: batchProgress.total })
                    : progress?.estimatedTimeRemaining != null && progress.estimatedTimeRemaining > 0
                      ? `ETA ${formatEta(progress.estimatedTimeRemaining)}`
                      : progress
                        ? `${progress.currentFrame} / ${progress.totalFrames} frames`
                        : t('common.processing')}
            </div>
          </div>
          <ChevronUp className="w-4 h-4 text-slate-500 shrink-0" />
        </div>

        {/* Progress bar */}
        <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
          {percentage !== undefined ? (
            <div
              className={`h-full rounded-full transition-all duration-300 ease-out ${
                error ? 'bg-red-500' : isDone ? 'bg-[#34B27B]' : 'bg-[#34B27B]'
              }`}
              style={{ width: `${Math.min(percentage, 100)}%` }}
            />
          ) : (
            <div className="h-full w-full relative overflow-hidden">
              <div
                className="absolute h-full w-1/3 bg-[#34B27B] rounded-full"
                style={{ animation: 'indeterminate 1.5s ease-in-out infinite' }}
              />
              <style>{`
                @keyframes indeterminate {
                  0% { transform: translateX(-100%); }
                  100% { transform: translateX(400%); }
                }
              `}</style>
            </div>
          )}
        </div>

        {/* Percentage label */}
        {percentage !== undefined && (
          <div className="mt-1 text-right">
            <span className="text-[11px] font-mono text-slate-400">
              {percentage.toFixed(0)}%
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
