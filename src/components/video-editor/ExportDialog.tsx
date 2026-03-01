import { useEffect, useState } from 'react';
import { X, Download, Loader2, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import type { ExportProgress } from '@/lib/exporter';
import { useI18n } from '@/i18n';

interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  progress: ExportProgress | null;
  isExporting: boolean;
  error: string | null;
  onCancel?: () => void;
  exportFormat?: 'mp4' | 'gif';
  exportedFilePath?: string;
  batchProgress?: {
    current: number;
    total: number;
    aspectRatio: string;
  } | null;
  isMinimizing?: boolean;
  onMinimizeEnd?: () => void;
}

export function ExportDialog({
  isOpen,
  onClose,
  progress,
  isExporting,
  error,
  onCancel,
  exportFormat = 'mp4',
  exportedFilePath,
  batchProgress = null,
  isMinimizing = false,
  onMinimizeEnd,
}: ExportDialogProps) {
  const { t } = useI18n();
  const [showSuccess, setShowSuccess] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Reset showSuccess when a new export starts or dialog reopens
  useEffect(() => {
    if (isExporting) {
      setShowSuccess(false);
    }
  }, [isExporting]);

  // Reset showSuccess when dialog opens fresh
  useEffect(() => {
    if (isOpen && !isExporting && !progress) {
      setShowSuccess(false);
    }
  }, [isOpen, isExporting, progress]);

  useEffect(() => {
    if (!isExporting && progress && progress.percentage >= 100 && !error) {
      setShowSuccess(true);
      const timer = setTimeout(() => {
        setShowSuccess(false);
        onClose();
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [isExporting, progress, error, onClose]);

  useEffect(() => {
    if (!isOpen || !isExporting) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isOpen, isExporting]);

  if (!isOpen) return null;

  const formatLabel = exportFormat === 'gif' ? 'GIF' : 'Video';
  
  // Determine if we're in the compiling phase (frames done but still exporting)
  const isCompiling = isExporting && progress && progress.percentage >= 100 && exportFormat === 'gif';
  const isFinalizing = progress?.phase === 'finalizing';
  const renderProgress = progress?.renderProgress;
  const updatedAtMs = progress?.updatedAtMs ?? nowMs;
  const staleMs = Math.max(0, nowMs - updatedAtMs);
  const elapsedMs = progress?.elapsedMs ?? 0;
  const etaSeconds = progress?.estimatedTimeRemaining ?? 0;

  const formatElapsed = (valueMs: number) => {
    const totalSeconds = Math.max(0, Math.floor(valueMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  };

  const formatEta = (seconds: number) => {
    const safe = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(safe / 60);
    const remaining = safe % 60;
    return `${minutes}:${String(remaining).padStart(2, '0')}`;
  };

  const resolveActivityState = () => {
    if (staleMs < 3_000) return 'active';
    if (staleMs < 12_000) return 'waiting';
    return 'stalled';
  };

  const activityState = resolveActivityState();

  const resolvePhaseDetail = () => {
    const key = progress?.phaseDetailKey;
    if (!key) return '';
    return t(key);
  };

  const phaseDetailText = resolvePhaseDetail();
  
  // Get status message based on phase
  const getStatusMessage = () => {
    if (error) return t('export.statusTryAgain');
    if (isCompiling) {
      if (renderProgress !== undefined && renderProgress > 0) {
        return t('export.statusCompilingPct', { progress: renderProgress });
      }
      return t('export.statusCompiling');
    }
    if (isFinalizing) {
      if (phaseDetailText) {
        return t('export.statusFinalizingVideoStep', { step: phaseDetailText });
      }
      return exportFormat === 'gif' ? t('export.statusCompiling') : t('export.statusFinalizingVideo');
    }
    return t('export.statusMoment');
  };

  // Get title based on phase
  const getTitle = () => {
    if (error) return t('export.titleFailed');
    if (isCompiling) return t('export.titleCompilingGif');
    if (isFinalizing) {
      return exportFormat === 'gif' ? t('export.titleCompilingGif') : t('export.titleFinalizingVideo');
    }
    return t('export.title', { format: formatLabel });
  };

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/80 backdrop-blur-md z-50 transition-opacity duration-250 ${
          isMinimizing ? 'opacity-0' : 'animate-in fade-in duration-200'
        }`}
        onClick={onClose}
      />
      <div
        className="fixed top-1/2 left-1/2 z-[60] bg-[#09090b] rounded-2xl shadow-2xl border border-white/10 p-8 w-[90vw] max-w-md"
        style={{
          animation: isMinimizing
            ? 'export-minimize 250ms ease-in forwards'
            : 'export-maximize 250ms ease-out forwards',
        }}
        onAnimationEnd={() => {
          if (isMinimizing && onMinimizeEnd) onMinimizeEnd();
        }}
      >
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            {showSuccess ? (
              <>
                <div className="w-12 h-12 rounded-full bg-[#34B27B]/20 flex items-center justify-center ring-1 ring-[#34B27B]/50">
                  <Download className="w-6 h-6 text-[#34B27B]" />
                </div>
                <div>
                  <span className="text-xl font-bold text-slate-200 block">Export Complete</span>
                  <span className="text-sm text-slate-400">{t('export.ready', { format: formatLabel.toLowerCase() })}</span>
                </div>
              </>
            ) : (
              <>
                {isExporting ? (
                  <div className="w-12 h-12 rounded-full bg-[#34B27B]/10 flex items-center justify-center">
                    <Loader2 className="w-6 h-6 text-[#34B27B] animate-spin" />
                  </div>
                ) : (
                  <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center border border-white/10">
                    <Download className="w-6 h-6 text-slate-200" />
                  </div>
                )}
                <div>
                  <span className="text-xl font-bold text-slate-200 block">
                    {getTitle()}
                  </span>
                  <span className="text-sm text-slate-400">
                    {getStatusMessage()}
                  </span>
                </div>
              </>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="hover:bg-white/10 text-slate-400 hover:text-white rounded-full"
            title={isExporting ? 'Minimize' : 'Close'}
          >
            <X className="w-5 h-5" />
          </Button>
        </div>

        {error && (
          <div className="mb-6 animate-in slide-in-from-top-2">
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-start gap-3">
              <div className="p-1 bg-red-500/20 rounded-full">
                <X className="w-3 h-3 text-red-400" />
              </div>
              <p className="text-sm text-red-400 leading-relaxed">{error}</p>
            </div>
          </div>
        )}

        {isExporting && progress && (
          <div className="space-y-6">
            {batchProgress && batchProgress.total > 1 && (
              <div className="rounded-xl border border-[#34B27B]/30 bg-[#34B27B]/10 p-3">
                <div className="text-[10px] uppercase tracking-wider text-[#34B27B]">
                  {t('export.batchProgress', { current: batchProgress.current, total: batchProgress.total })}
                </div>
                <div className="mt-1 text-sm font-medium text-slate-200">
                  {batchProgress.aspectRatio}
                </div>
              </div>
            )}
            <div className="space-y-2">
              <div className="flex justify-between text-xs font-medium text-slate-400 uppercase tracking-wider">
                  <span>
                    {isCompiling
                      ? t('export.phaseCompiling')
                      : isFinalizing
                        ? t('export.phaseFinalizing')
                        : t('export.phaseRendering')}
                  </span>
                <span className="font-mono text-slate-200">
                  {isCompiling || (isFinalizing && exportFormat === 'gif') ? (
                    renderProgress !== undefined && renderProgress > 0 ? (
                      `${renderProgress}%`
                    ) : (
                      <span className="flex items-center gap-2">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        {t('common.processing')}
                      </span>
                    )
                  ) : (
                    `${progress.percentage.toFixed(0)}%`
                  )}
                </span>
              </div>
              <div className="h-2 bg-white/5 rounded-full overflow-hidden border border-white/5">
                {isCompiling || (isFinalizing && exportFormat === 'gif') ? (
                  // Show render progress if available, otherwise animated indeterminate bar
                  renderProgress !== undefined && renderProgress > 0 ? (
                    <div
                      className="h-full bg-[#34B27B] shadow-[0_0_10px_rgba(52,178,123,0.3)] transition-all duration-300 ease-out"
                      style={{ width: `${renderProgress}%` }}
                    />
                  ) : (
                    <div className="h-full w-full relative overflow-hidden">
                      <div 
                        className="absolute h-full w-1/3 bg-[#34B27B] shadow-[0_0_10px_rgba(52,178,123,0.3)]"
                        style={{
                          animation: 'indeterminate 1.5s ease-in-out infinite',
                        }}
                      />
                      <style>{`
                        @keyframes indeterminate {
                          0% { transform: translateX(-100%); }
                          100% { transform: translateX(400%); }
                        }
                      `}</style>
                    </div>
                  )
                ) : (
                  <div
                    className="h-full bg-[#34B27B] shadow-[0_0_10px_rgba(52,178,123,0.3)] transition-all duration-300 ease-out"
                    style={{ width: `${Math.min(progress.percentage, 100)}%` }}
                  />
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">
                  {isCompiling || isFinalizing ? t('common.status') : t('common.format')}
                </div>
                <div className="text-slate-200 font-medium text-sm">
                  {isCompiling
                    ? t('export.titleCompilingGif')
                    : isFinalizing
                      ? exportFormat === 'gif'
                        ? t('export.titleCompilingGif')
                        : t('export.titleFinalizingVideo')
                      : formatLabel}
                </div>
              </div>
              <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">{t('common.frames')}</div>
                <div className="text-slate-200 font-medium text-sm">
                  {progress.currentFrame} / {progress.totalFrames}
                </div>
              </div>
              <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">{t('export.elapsed')}</div>
                <div className="text-slate-200 font-medium text-sm">{formatElapsed(elapsedMs)}</div>
              </div>
              <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">{t('export.eta')}</div>
                <div className="text-slate-200 font-medium text-sm">
                  {isFinalizing ? t('common.processing') : formatEta(etaSeconds)}
                </div>
              </div>
              <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">{t('export.activity')}</div>
                <div className="text-slate-200 font-medium text-sm">
                  {activityState === 'active'
                    ? t('export.activityActive')
                    : activityState === 'waiting'
                      ? t('export.activityWaiting')
                      : t('export.activityStalled')}
                </div>
              </div>
            </div>

            {activityState === 'stalled' && (
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 text-amber-300 text-xs">
                {t('export.activityStalledHint', { seconds: Math.floor(staleMs / 1000) })}
              </div>
            )}

            {onCancel && (
              <div className="pt-2">
                <Button
                  onClick={onCancel}
                  variant="destructive"
                  className="w-full py-6 bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 hover:border-red-500/30 transition-all rounded-xl"
                >
                  {t('export.cancelExport')}
                </Button>
              </div>
            )}
          </div>
        )}

        {showSuccess && (
          <div className="text-center py-4 animate-in zoom-in-95 flex flex-col items-center gap-2">
            <p className="text-lg text-slate-200 font-medium">
              {t('export.saved', { format: formatLabel })}
            </p>
            {exportedFilePath && (
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    const result = await window.electronAPI.revealInFolder(exportedFilePath);
                    if (!result.success) {
                      toast.error(result.error || result.message || t('export.revealFailed'));
                    }
                  } catch (err) {
                    toast.error(String(err));
                  }
                }}
                className="mt-1 px-3 py-1.5 text-sm rounded-lg bg-white/10 hover:bg-white/20 text-slate-200 border border-white/10 gap-2"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                {t('export.showInFolder')}
              </Button>
            )}
            {exportedFilePath && (
              <span className="text-[10px] text-slate-500 break-all max-w-xs">
                {exportedFilePath.replace(/^.*[\\/]/, '')}
              </span>
            )}
          </div>
        )}
      </div>
    </>
  );
}
