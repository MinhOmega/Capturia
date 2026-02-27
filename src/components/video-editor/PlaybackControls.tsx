import { useMemo } from "react";
import { Button } from "../ui/button";
import { Play, Pause, Maximize2, Minimize2, ZoomIn } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const SPEED_OPTIONS = [0.25, 0.5, 1, 1.5, 2, 3, 4, 8, 16, 32];

function formatVisibleRange(ms: number): string {
  if (ms < 1) return `${Math.round(ms * 1000)}μs`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

interface TimelineZoomInfo {
  visibleMs: number;
  totalMs: number;
  minVisibleMs: number;
}

interface PlaybackControlsProps {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onTogglePlayPause: () => void;
  onSeek: (time: number) => void;
  playbackSpeed?: number;
  previewPlaybackRate?: number;
  onPreviewPlaybackRateChange?: (rate: number) => void;
  timelineZoomInfo?: TimelineZoomInfo | null;
  onTimelineZoomChange?: (visibleMs: number) => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

export default function PlaybackControls({
  isPlaying,
  currentTime,
  duration,
  onTogglePlayPause,
  onSeek,
  playbackSpeed = 1,
  previewPlaybackRate = 1,
  onPreviewPlaybackRateChange,
  timelineZoomInfo,
  onTimelineZoomChange,
  isFullscreen = false,
  onToggleFullscreen,
}: PlaybackControlsProps) {
  const { t } = useI18n();
  function formatTime(seconds: number) {
    if (!isFinite(seconds) || isNaN(seconds) || seconds < 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function handleSeekChange(e: React.ChangeEvent<HTMLInputElement>) {
    onSeek(parseFloat(e.target.value));
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  // Logarithmic zoom slider: maps 0–1000 integer range to log scale between minVisible and totalMs
  // Slider value 0 = max zoom in (minVisible), 1000 = max zoom out (totalMs)
  const zoomSlider = useMemo(() => {
    if (!timelineZoomInfo) return null;
    const { visibleMs, totalMs, minVisibleMs } = timelineZoomInfo;
    if (totalMs <= 0 || minVisibleMs >= totalMs) return null;
    const logMin = Math.log(minVisibleMs);
    const logMax = Math.log(totalMs);
    const logCurrent = Math.log(Math.max(minVisibleMs, Math.min(totalMs, visibleMs)));
    // Invert: slider left = zoomed in, slider right = zoomed out
    const normalized = (logCurrent - logMin) / (logMax - logMin);
    return {
      value: Math.round((1 - normalized) * 1000),
      label: formatVisibleRange(visibleMs),
      logMin,
      logMax,
    };
  }, [timelineZoomInfo]);

  const handleZoomSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!timelineZoomInfo || !zoomSlider || !onTimelineZoomChange) return;
    const sliderVal = parseInt(e.target.value, 10);
    const normalized = 1 - sliderVal / 1000;
    const logMs = zoomSlider.logMin + normalized * (zoomSlider.logMax - zoomSlider.logMin);
    onTimelineZoomChange(Math.exp(logMs));
  };

  const zoomProgress = zoomSlider ? (zoomSlider.value / 1000) * 100 : 0;

  return (
    <div className="flex items-center gap-2 px-1 py-0.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 shadow-xl transition-all duration-300 hover:bg-black/70 hover:border-white/20">
      <Button
        onClick={onTogglePlayPause}
        size="icon"
        className={cn(
          "w-8 h-8 rounded-full transition-all duration-200 border border-white/10",
          isPlaying
            ? "bg-white/10 text-white hover:bg-white/20"
            : "bg-white text-black hover:bg-white/90 hover:scale-105 shadow-[0_0_15px_rgba(255,255,255,0.3)]"
        )}
        aria-label={isPlaying ? t("playback.pause") : t("playback.play")}
      >
        {isPlaying ? (
          <Pause className="w-3.5 h-3.5 fill-current" />
        ) : (
          <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
        )}
      </Button>

      <span className="text-[9px] font-medium text-slate-300 tabular-nums w-[30px] text-right">
        {formatTime(currentTime)}
      </span>

      <div className="flex-1 relative h-6 flex items-center group">
        {/* Custom Track Background */}
        <div className="absolute left-0 right-0 h-0.5 bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-[#34B27B] rounded-full"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Interactive Input */}
        <input
          type="range"
          min="0"
          max={duration || 100}
          value={currentTime}
          onChange={handleSeekChange}
          step="0.01"
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
        />

        {/* Custom Thumb (visual only, follows progress) */}
        <div
          className="absolute w-2.5 h-2.5 bg-white rounded-full shadow-lg pointer-events-none group-hover:scale-125 transition-transform duration-100"
          style={{
            left: `${progress}%`,
            transform: 'translateX(-50%)'
          }}
        />
      </div>

      <span className="text-[9px] font-medium text-slate-500 tabular-nums w-[30px]">
        {formatTime(duration)}
      </span>

      {/* Timeline zoom slider with label */}
      {zoomSlider && (
        <div className="flex items-center gap-1.5 shrink-0" title={t("playback.timelineZoom")}>
          <ZoomIn className="w-3 h-3 text-slate-500 shrink-0" />
          <div className="relative w-16 h-5 flex items-center group/zoom">
            {/* Track */}
            <div className="absolute left-0 right-0 h-[3px] bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-[#34B27B]/60 rounded-full"
                style={{ width: `${zoomProgress}%` }}
              />
            </div>
            {/* Interactive input */}
            <input
              type="range"
              min="0"
              max="1000"
              value={zoomSlider.value}
              onChange={handleZoomSliderChange}
              step="1"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
            />
            {/* Thumb */}
            <div
              className="absolute w-2 h-2 bg-white rounded-full shadow pointer-events-none group-hover/zoom:scale-125 transition-transform duration-100"
              style={{
                left: `${zoomProgress}%`,
                transform: 'translateX(-50%)'
              }}
            />
          </div>
          <span className="text-[8px] font-medium text-slate-500 tabular-nums shrink-0 w-[32px]">
            {zoomSlider.label}
          </span>
        </div>
      )}

      {/* Speed dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "text-[9px] font-medium px-1.5 py-0.5 rounded tabular-nums shrink-0 cursor-pointer outline-none transition-colors",
              previewPlaybackRate === 1
                ? "text-slate-400 bg-white/5 hover:bg-white/10"
                : "text-[#34B27B] bg-[#34B27B]/10 hover:bg-[#34B27B]/20"
            )}
            title={t("playback.previewSpeed")}
          >
            {previewPlaybackRate}x
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[80px] bg-[#09090b] border-white/10">
          {SPEED_OPTIONS.map((speed) => (
            <DropdownMenuItem
              key={speed}
              onClick={() => onPreviewPlaybackRateChange?.(speed)}
              className={cn(
                "text-[11px] tabular-nums cursor-pointer",
                speed === previewPlaybackRate
                  ? "text-[#34B27B] font-semibold"
                  : "text-slate-300"
              )}
            >
              {speed}x
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Segment speed indicator (shown only when different from 1x) */}
      {playbackSpeed !== 1 && (
        <span className="text-[8px] font-medium text-slate-500 tabular-nums shrink-0">
          seg:{playbackSpeed}x
        </span>
      )}

      {/* Fullscreen toggle */}
      {onToggleFullscreen && (
        <Button
          onClick={onToggleFullscreen}
          size="icon"
          className="w-7 h-7 rounded-full bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white border-0 transition-colors"
          aria-label={isFullscreen ? t("playback.exitFullscreen") : t("playback.fullscreen")}
        >
          {isFullscreen ? (
            <Minimize2 className="w-3 h-3" />
          ) : (
            <Maximize2 className="w-3 h-3" />
          )}
        </Button>
      )}
    </div>
  );
}
