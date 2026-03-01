

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { cn } from "@/lib/utils";

import VideoPlayback, { VideoPlaybackRef } from "./VideoPlayback";
import { PreviewAspectCropOverlay } from "./PreviewAspectCropOverlay";
import PlaybackControls from "./PlaybackControls";
import TimelineEditor from "./timeline/TimelineEditor";
import { SettingsPanel } from "./SettingsPanel";
import { ExportDialog } from "./ExportDialog";
import { ExportProgressFloat } from "./ExportProgressFloat";

import type { Span } from "dnd-timeline";
import {
  DEFAULT_ZOOM_DEPTH,
  clampFocusToDepth,
  DEFAULT_CROP_REGION,
  DEFAULT_ANNOTATION_POSITION,
  DEFAULT_ANNOTATION_SIZE,
  DEFAULT_ANNOTATION_STYLE,
  DEFAULT_FIGURE_DATA,
  type ZoomDepth,
  type ZoomFocus,
  type ZoomRegion,
  type TrimRegion,
  type VideoSegment,
  type AudioEditRegion,
  type AnnotationRegion,
  type CropRegion,
  type FigureData,
  type ProjectState,
} from "./types";
import {
  VideoExporter,
  GifExporter,
  type ExportProgress,
  type ExportQuality,
  type ExportSettings,
  type ExportFormat,
  type GifFrameRate,
  type GifSizePreset,
  GIF_SIZE_PRESETS,
  calculateOutputDimensions,
  calculateMp4ExportPlan,
} from "@/lib/exporter";
import { ASPECT_RATIOS, type AspectRatio, getAspectRatioValue } from "@/utils/aspectRatioUtils";
import { getAssetPath } from "@/lib/assetPath";
import { useShortcuts } from "@/contexts/ShortcutsContext";
import { matchesShortcut } from "@/lib/shortcuts";
import { useI18n } from "@/i18n";
import { DEFAULT_CURSOR_STYLE, type CursorStyleConfig, type CursorTrack, type CursorTrackEvent } from "@/lib/cursor";
import { cropRegionEquals, getCenteredAspectCropRegion, normalizeAspectCropRegion } from "@/lib/crop/aspectCrop";
import { generateAutoZoomDrafts } from "@/lib/autoEdit/screenStudioAutoZoom";
import type { RoughCutSuggestion, SubtitleCue } from "@/lib/analysis/types";
import { normalizeSubtitleCues } from "@/lib/analysis/subtitleTrack";
import { normalizeRoughCutSuggestions } from "@/lib/analysis/roughCutEngine";
import { applyRoughCutSuggestionsToAudioEdits } from "@/lib/analysis/roughCutApply";
import {
  clearStaleSelectedZoomIdForAspect,
  getSelectedZoomIdForAspect,
  getZoomRegionsForAspect,
  setSelectedZoomIdForAspect,
  setZoomRegionsForAspect,
  type SelectedZoomIdByAspect,
  type ZoomRegionsByAspect,
} from "@/lib/zoom/aspectZoomState";
import {
  normalizeTrimRanges,
  sourceToEffectiveMs,
  effectiveToSourceMs,
  getEffectiveDurationMs,
  sourceToEffectiveMsWithSegments,
  effectiveToSourceMsWithSegments,
  getEffectiveDurationMsWithSegments,
  segmentsToTrimRegions,
  findSegmentAtSourceTime,
} from "@/lib/trim/timeMapping";
import { VideoMouseAnalyzer } from "@/lib/analysis/videoMouseAnalyzer";

const WALLPAPER_COUNT = 18;
const WALLPAPER_PATHS = Array.from({ length: WALLPAPER_COUNT }, (_, i) => `/wallpapers/wallpaper${i + 1}.jpg`);

function resolvePreviewFrameRate(sourceFrameRate?: number): number {
  if (!Number.isFinite(sourceFrameRate)) return 60;
  const normalized = Math.round(sourceFrameRate || 60);
  if (normalized < 30) return 30;
  // Keep editor preview capped to 60fps for consistent UI responsiveness.
  if (normalized > 60) return 60;
  return normalized;
}

function normalizeSelectedAspectRatios(selected: AspectRatio[]): AspectRatio[] {
  const selectedSet = new Set(selected);
  return ASPECT_RATIOS.filter((ratio) => selectedSet.has(ratio));
}

function resolveAspectCropRegion(
  regionsByAspect: Partial<Record<AspectRatio, CropRegion>>,
  ratio: AspectRatio,
  sourceAspectRatio: number,
): CropRegion {
  const targetAspectRatio = getAspectRatioValue(ratio);
  const region = regionsByAspect[ratio];
  if (!region) {
    return getCenteredAspectCropRegion(sourceAspectRatio, targetAspectRatio);
  }
  return normalizeAspectCropRegion(region, sourceAspectRatio, targetAspectRatio);
}

function fromFileUrl(input: string): string {
  if (!input) return input;
  if (!input.startsWith('file://')) return input;

  try {
    const parsed = new URL(input);
    return decodeURIComponent(parsed.pathname || '');
  } catch {
    return input.replace(/^file:\/\//, '');
  }
}

function normalizeCursorTrack(input: unknown): CursorTrack | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as {
    samples?: unknown[];
    events?: unknown[];
    source?: unknown;
    space?: unknown;
    stats?: unknown;
    capture?: unknown;
  };
  if (!Array.isArray(raw.samples) || raw.samples.length === 0) return null;

  const samples = raw.samples
    .map((sample) => {
      if (!sample || typeof sample !== "object") return null;
      const row = sample as {
        timeMs?: unknown;
        x?: unknown;
        y?: unknown;
        click?: unknown;
        visible?: unknown;
        cursorKind?: unknown;
      };
      const timeMs = Number(row.timeMs);
      const x = Number(row.x);
      const y = Number(row.y);
      if (!Number.isFinite(timeMs) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
      const cursorKind: "arrow" | "ibeam" = row.cursorKind === "ibeam" ? "ibeam" : "arrow";
      return {
        timeMs: Math.max(0, Math.round(timeMs)),
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y)),
        click: Boolean(row.click),
        visible: row.visible === false ? false : true,
        cursorKind,
      };
    })
    .filter((sample): sample is NonNullable<typeof sample> => Boolean(sample))
    .sort((a, b) => a.timeMs - b.timeMs);

  if (samples.length === 0) return null;
  const rawSpace = raw.space as { mode?: unknown; displayId?: unknown; bounds?: unknown } | undefined;
  const bounds = rawSpace?.bounds as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | undefined;
  const parsedSpace =
    bounds
      && Number.isFinite(Number(bounds.x))
      && Number.isFinite(Number(bounds.y))
      && Number.isFinite(Number(bounds.width))
      && Number.isFinite(Number(bounds.height))
      && Number(bounds.width) > 0
      && Number(bounds.height) > 0
      ? {
          mode: rawSpace?.mode === "source-display" ? "source-display" as const : "virtual-desktop" as const,
          displayId: typeof rawSpace?.displayId === "string" ? rawSpace.displayId : undefined,
          bounds: {
            x: Number(bounds.x),
            y: Number(bounds.y),
            width: Number(bounds.width),
            height: Number(bounds.height),
          },
        }
      : undefined;

  const rawStats = raw.stats as { sampleCount?: unknown; clickCount?: unknown } | undefined;
  const parsedStats = rawStats
    ? {
        sampleCount: Number.isFinite(Number(rawStats.sampleCount)) ? Math.max(0, Math.floor(Number(rawStats.sampleCount))) : undefined,
        clickCount: Number.isFinite(Number(rawStats.clickCount)) ? Math.max(0, Math.floor(Number(rawStats.clickCount))) : undefined,
      }
    : undefined;

  const rawCapture = raw.capture as { sourceId?: unknown; width?: unknown; height?: unknown } | undefined;
  const parsedCapture = rawCapture
    ? {
        sourceId: typeof rawCapture.sourceId === "string" ? rawCapture.sourceId : undefined,
        width: Number.isFinite(Number(rawCapture.width)) ? Math.max(2, Math.floor(Number(rawCapture.width))) : undefined,
        height: Number.isFinite(Number(rawCapture.height)) ? Math.max(2, Math.floor(Number(rawCapture.height))) : undefined,
      }
    : undefined;

  const parsedEvents = Array.isArray(raw.events)
    ? raw.events
      .map((event) => {
        if (!event || typeof event !== "object") return null;
        const row = event as {
          type?: unknown;
          startMs?: unknown;
          endMs?: unknown;
          point?: unknown;
          startPoint?: unknown;
          endPoint?: unknown;
          bounds?: unknown;
        };

        const eventType: CursorTrackEvent["type"] | null = row.type === "selection" ? "selection" : row.type === "click" ? "click" : null;
        const startMs = Number(row.startMs);
        const endMs = Number(row.endMs);
        const point = row.point as { x?: unknown; y?: unknown } | undefined;
        const pointX = Number(point?.x);
        const pointY = Number(point?.y);
        if (!eventType || !Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(pointX) || !Number.isFinite(pointY)) {
          return null;
        }

        const normalizePoint = (source?: { x?: unknown; y?: unknown }) => {
          const x = Number(source?.x);
          const y = Number(source?.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
          return {
            x: Math.min(1, Math.max(0, x)),
            y: Math.min(1, Math.max(0, y)),
          };
        };

        const bounds = row.bounds as {
          minX?: unknown;
          minY?: unknown;
          maxX?: unknown;
          maxY?: unknown;
        } | undefined;
        const minX = Number(bounds?.minX);
        const minY = Number(bounds?.minY);
        const maxX = Number(bounds?.maxX);
        const maxY = Number(bounds?.maxY);
        const parsedBounds = [minX, minY, maxX, maxY].every(Number.isFinite)
          ? {
            minX: Math.min(1, Math.max(0, minX)),
            minY: Math.min(1, Math.max(0, minY)),
            maxX: Math.max(Math.min(1, Math.max(0, minX)), Math.min(1, Math.max(0, maxX))),
            maxY: Math.max(Math.min(1, Math.max(0, minY)), Math.min(1, Math.max(0, maxY))),
            width: 0,
            height: 0,
          }
          : undefined;
        if (parsedBounds) {
          parsedBounds.width = parsedBounds.maxX - parsedBounds.minX;
          parsedBounds.height = parsedBounds.maxY - parsedBounds.minY;
        }

        const normalizedEvent: CursorTrackEvent = {
          type: eventType,
          startMs: Math.max(0, Math.round(startMs)),
          endMs: Math.max(Math.max(0, Math.round(startMs)), Math.round(endMs)),
          point: {
            x: Math.min(1, Math.max(0, pointX)),
            y: Math.min(1, Math.max(0, pointY)),
          },
        };
        const parsedStartPoint = normalizePoint(row.startPoint as { x?: unknown; y?: unknown } | undefined);
        if (parsedStartPoint) {
          normalizedEvent.startPoint = parsedStartPoint;
        }
        const parsedEndPoint = normalizePoint(row.endPoint as { x?: unknown; y?: unknown } | undefined);
        if (parsedEndPoint) {
          normalizedEvent.endPoint = parsedEndPoint;
        }
        if (parsedBounds) {
          normalizedEvent.bounds = parsedBounds;
        }
        return normalizedEvent;
      })
      .filter((event): event is NonNullable<typeof event> => Boolean(event))
      .sort((a, b) => a.startMs - b.startMs)
    : undefined;

  return {
    samples,
    events: parsedEvents,
    source: raw.source === "synthetic" ? "synthetic" : "recorded",
    space: parsedSpace,
    stats: parsedStats,
    capture: parsedCapture,
  };
}

export default function VideoEditor() {
  const { t, locale } = useI18n();
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [videoFilePath, setVideoFilePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [segments, setSegments] = useState<VideoSegment[]>([]);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [wallpaper, setWallpaper] = useState<string>(WALLPAPER_PATHS[0]);
  const [shadowIntensity, setShadowIntensity] = useState(0);
  const [showBlur, setShowBlur] = useState(false);
  const [motionBlurEnabled, setMotionBlurEnabled] = useState(false);
  const [seekStepSeconds, setSeekStepSeconds] = useState(5);
  const [previewPlaybackRate, setPreviewPlaybackRate] = useState(1);
  const [timelineZoomInfo, setTimelineZoomInfo] = useState<{ visibleMs: number; totalMs: number; minVisibleMs: number } | null>(null);
  const timelineZoomStepRef = useRef<((direction: 1 | -1) => void) | null>(null);
  const timelineZoomSetRef = useRef<((visibleMs: number) => void) | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenControlsVisible, setFullscreenControlsVisible] = useState(true);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const fullscreenHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [borderRadius, setBorderRadius] = useState(0);
  const [padding, setPadding] = useState(50);
  const [sourceVideoDimensions, setSourceVideoDimensions] = useState<{ width: number; height: number } | null>(null);
  const [cropRegionsByAspect, setCropRegionsByAspect] = useState<Partial<Record<AspectRatio, CropRegion>>>({
    '16:9': DEFAULT_CROP_REGION,
  });
  const [zoomRegionsByAspect, setZoomRegionsByAspect] = useState<ZoomRegionsByAspect>({});
  const [selectedZoomIdByAspect, setSelectedZoomIdByAspect] = useState<SelectedZoomIdByAspect>({});
  const [audioEditRegions, setAudioEditRegions] = useState<AudioEditRegion[]>([]);
  const [annotationRegions, setAnnotationRegions] = useState<AnnotationRegion[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('16:9');
  const [exportAspectRatios, setExportAspectRatios] = useState<AspectRatio[]>(['16:9']);
  const [activeBatchExport, setActiveBatchExport] = useState<{
    current: number;
    total: number;
    aspectRatio: AspectRatio;
  } | null>(null);
  const [exportQuality, setExportQuality] = useState<ExportQuality>('source');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('mp4');
  const [gifFrameRate, setGifFrameRate] = useState<GifFrameRate>(15);
  const [gifLoop, setGifLoop] = useState(true);
  const [gifSizePreset, setGifSizePreset] = useState<GifSizePreset>('medium');
  const [sourceFrameRate, setSourceFrameRate] = useState<number | undefined>(undefined);
  const [sourceHasAudio, setSourceHasAudio] = useState(true);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [audioGain, setAudioGain] = useState(1);
  const [audioNormalizeLoudness, setAudioNormalizeLoudness] = useState(true);
  const [audioTargetLufs, setAudioTargetLufs] = useState(-16);
  const [audioLimiterDb, setAudioLimiterDb] = useState(-1);
  const [cursorTrack, setCursorTrack] = useState<CursorTrack | null>(null);
  const [cursorStyle, setCursorStyle] = useState<CursorStyleConfig>(DEFAULT_CURSOR_STYLE);
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [roughCutSuggestions, setRoughCutSuggestions] = useState<RoughCutSuggestion[]>([]);
  const [analysisJobId, setAnalysisJobId] = useState<string | null>(null);
  const [analysisInProgress, setAnalysisInProgress] = useState(false);
  const analysisPollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [cursorAnalysisProgress, setCursorAnalysisProgress] = useState<number | null>(null);
  const cursorAnalyzerRef = useRef<VideoMouseAnalyzer | null>(null);

  const { shortcuts: keyShortcuts, isMac: isMacPlatform } = useShortcuts();
  const keyShortcutsRef = useRef(keyShortcuts);
  keyShortcutsRef.current = keyShortcuts;
  const isMacRef = useRef(isMacPlatform);
  isMacRef.current = isMacPlatform;

  const videoPlaybackRef = useRef<VideoPlaybackRef>(null);
  const nextZoomIdRef = useRef(1);
  const nextSegIdRef = useRef(2);
  const nextAnnotationIdRef = useRef(1);
  const nextAnnotationZIndexRef = useRef(1); // Track z-index for stacking order
  const projectRestoredRef = useRef(false); // Guards wallpaper init race (one-shot: reset after first effects)
  const videoLoadedRef = useRef(false); // Prevents loadVideo re-trigger on locale change
  const exporterRef = useRef<{ cancel: () => void } | null>(null);
  const exportCancelledRef = useRef(false);
  const autoEditInitializedAspectsRef = useRef<Set<AspectRatio>>(new Set());
  const sourceAspectRatio = useMemo(() => {
    const fallback = 16 / 9;
    if (sourceVideoDimensions && sourceVideoDimensions.width > 0 && sourceVideoDimensions.height > 0) {
      return sourceVideoDimensions.width / sourceVideoDimensions.height;
    }
    const video = videoPlaybackRef.current?.video;
    if (video && video.videoWidth > 0 && video.videoHeight > 0) {
      return video.videoWidth / video.videoHeight;
    }
    return fallback;
  }, [sourceVideoDimensions]);
  const normalizedExportAspectRatios = useMemo(
    () => normalizeSelectedAspectRatios(exportAspectRatios),
    [exportAspectRatios],
  );
  const activeCropRegion = useMemo(
    () => resolveAspectCropRegion(cropRegionsByAspect, aspectRatio, sourceAspectRatio),
    [aspectRatio, cropRegionsByAspect, sourceAspectRatio],
  );
  const zoomRegions = useMemo(
    () => getZoomRegionsForAspect(zoomRegionsByAspect, aspectRatio),
    [zoomRegionsByAspect, aspectRatio],
  );
  const selectedZoomId = useMemo(
    () => getSelectedZoomIdForAspect(selectedZoomIdByAspect, aspectRatio),
    [selectedZoomIdByAspect, aspectRatio],
  );
  const showAspectCropOverlay = exportFormat === "mp4" && normalizedExportAspectRatios.includes(aspectRatio);

  // --- Segment-derived values ---
  const totalDurationMs = useMemo(() => Math.max(0, duration * 1000), [duration]);

  // Initialize segments when duration becomes known.
  // Also clamp restored segments if the WebM duration probe found a shorter actual duration
  // (segments saved with the inflated duration would extend past the real content end).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (totalDurationMs <= 0) return;
    if (segments.length === 0) {
      setSegments([{
        id: 'seg-1',
        startMs: 0,
        endMs: totalDurationMs,
        deleted: false,
        speed: 1,
      }]);
    } else {
      // Clamp segments that extend past actual duration (WebM duration fix)
      const lastSeg = segments[segments.length - 1];
      if (lastSeg && lastSeg.endMs > totalDurationMs + 500) {
        setSegments(prev => {
          const clamped = prev
            .filter(s => s.startMs < totalDurationMs)
            .map(s => s.endMs > totalDurationMs ? { ...s, endMs: totalDurationMs } : s);
          return clamped.length > 0 ? clamped : [{
            id: 'seg-1', startMs: 0, endMs: totalDurationMs, deleted: false, speed: 1,
          }];
        });
      }
    }
  }, [totalDurationMs]);

  // Derive trimRegions from deleted segments (backward compatibility)
  const trimRegions: TrimRegion[] = useMemo(
    () => segmentsToTrimRegions(segments),
    [segments],
  );
  const normalizedTrims = useMemo(
    () => normalizeTrimRanges(trimRegions, totalDurationMs),
    [trimRegions, totalDurationMs],
  );
  const normalizedTrimsRef = useRef(normalizedTrims);
  normalizedTrimsRef.current = normalizedTrims;

  // Segments ref for playback handlers
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  // Current segment's speed (for playback indicator)
  const currentSegmentSpeed = useMemo(() => {
    const seg = findSegmentAtSourceTime(currentTime * 1000, segments);
    return seg && !seg.deleted ? seg.speed : 1;
  }, [currentTime, segments]);

  const effectiveDuration = useMemo(
    () => {
      if (segments.length > 0) {
        return getEffectiveDurationMsWithSegments(segments) / 1000;
      }
      return normalizedTrims.length > 0 ? getEffectiveDurationMs(totalDurationMs, normalizedTrims) / 1000 : duration;
    },
    [segments, totalDurationMs, normalizedTrims, duration],
  );
  const effectiveCurrentTime = useMemo(
    () => {
      if (segments.length > 0) {
        return sourceToEffectiveMsWithSegments(currentTime * 1000, segments) / 1000;
      }
      return normalizedTrims.length > 0 ? sourceToEffectiveMs(currentTime * 1000, normalizedTrims) / 1000 : currentTime;
    },
    [currentTime, segments, normalizedTrims],
  );

  // Map zoom / annotation / subtitle / audio-edit regions to effective space for the timeline.
  // When segments exist (with per-segment speed), use segment-aware conversion; otherwise fall
  // back to the simpler trim-only conversion.
  const effectiveZoomRegions = useMemo(() => {
    if (segments.length > 0) {
      return zoomRegions.map((r) => ({
        ...r,
        startMs: sourceToEffectiveMsWithSegments(r.startMs, segments),
        endMs: sourceToEffectiveMsWithSegments(r.endMs, segments),
      }));
    }
    if (normalizedTrims.length === 0) return zoomRegions;
    return zoomRegions.map((r) => ({
      ...r,
      startMs: sourceToEffectiveMs(r.startMs, normalizedTrims),
      endMs: sourceToEffectiveMs(r.endMs, normalizedTrims),
    }));
  }, [zoomRegions, segments, normalizedTrims]);

  const effectiveAnnotationRegions = useMemo(() => {
    if (segments.length > 0) {
      return annotationRegions.map((r) => ({
        ...r,
        startMs: sourceToEffectiveMsWithSegments(r.startMs, segments),
        endMs: sourceToEffectiveMsWithSegments(r.endMs, segments),
      }));
    }
    if (normalizedTrims.length === 0) return annotationRegions;
    return annotationRegions.map((r) => ({
      ...r,
      startMs: sourceToEffectiveMs(r.startMs, normalizedTrims),
      endMs: sourceToEffectiveMs(r.endMs, normalizedTrims),
    }));
  }, [annotationRegions, segments, normalizedTrims]);

  const effectiveSubtitleCues = useMemo(() => {
    if (segments.length > 0) {
      return subtitleCues.map((c) => ({
        ...c,
        startMs: sourceToEffectiveMsWithSegments(c.startMs, segments),
        endMs: sourceToEffectiveMsWithSegments(c.endMs, segments),
      }));
    }
    if (normalizedTrims.length === 0) return subtitleCues;
    return subtitleCues.map((c) => ({
      ...c,
      startMs: sourceToEffectiveMs(c.startMs, normalizedTrims),
      endMs: sourceToEffectiveMs(c.endMs, normalizedTrims),
    }));
  }, [subtitleCues, segments, normalizedTrims]);

  const effectiveAudioEditRegions = useMemo(() => {
    if (segments.length > 0) {
      return audioEditRegions.map((r) => ({
        ...r,
        startMs: sourceToEffectiveMsWithSegments(r.startMs, segments),
        endMs: sourceToEffectiveMsWithSegments(r.endMs, segments),
      }));
    }
    if (normalizedTrims.length === 0) return audioEditRegions;
    return audioEditRegions.map((r) => ({
      ...r,
      startMs: sourceToEffectiveMs(r.startMs, normalizedTrims),
      endMs: sourceToEffectiveMs(r.endMs, normalizedTrims),
    }));
  }, [audioEditRegions, segments, normalizedTrims]);

  const setZoomRegionsForActiveAspect = useCallback((updater: (regions: ZoomRegion[]) => ZoomRegion[]) => {
    setZoomRegionsByAspect((previous) => {
      const current = getZoomRegionsForAspect(previous, aspectRatio);
      const next = updater(current);
      return setZoomRegionsForAspect(previous, aspectRatio, next);
    });
  }, [aspectRatio]);

  const setSelectedZoomIdForActiveAspect = useCallback((nextSelectedZoomId: string | null) => {
    setSelectedZoomIdByAspect((previous) =>
      setSelectedZoomIdForAspect(previous, aspectRatio, nextSelectedZoomId),
    );
  }, [aspectRatio]);

  const setCropRegionForAspect = useCallback((ratio: AspectRatio, region: CropRegion) => {
    setCropRegionsByAspect((previous) => {
      const normalized = normalizeAspectCropRegion(region, sourceAspectRatio, getAspectRatioValue(ratio));
      const existing = previous[ratio];
      if (existing && cropRegionEquals(existing, normalized)) {
        return previous;
      }
      return {
        ...previous,
        [ratio]: normalized,
      };
    });
  }, [sourceAspectRatio]);

  const handleActiveCropRegionChange = useCallback((region: CropRegion) => {
    setCropRegionForAspect(aspectRatio, region);
  }, [aspectRatio, setCropRegionForAspect]);

  // Helper to convert file path to proper file:// URL
  const toFileUrl = (filePath: string): string => {
    if (!filePath) return filePath;
    if (filePath.startsWith("local-media://") || filePath.startsWith("file://")) return filePath;

    // Normalize path separators to forward slashes
    const normalized = filePath.replace(/\\/g, '/');
    const encoded = encodeURI(normalized);

    // Use local-media:// custom protocol to serve local files. In dev mode
    // the renderer runs on http://localhost which blocks file:// as cross-origin.
    // A dummy "host" is required because standard schemes treat the first path
    // component as the hostname (e.g. local-media:///home → host="home").
    if (encoded.match(/^[a-zA-Z]:/)) {
      return `local-media://host/${encoded}`;
    }

    if (encoded.startsWith('/')) {
      return `local-media://host${encoded}`;
    }

    return encoded;
  };

  useEffect(() => {
    async function loadVideo() {
      // Only load once — prevents re-trigger on locale change
      if (videoLoadedRef.current) return;
      videoLoadedRef.current = true;
      try {
        const result = await window.electronAPI.getCurrentVideoPath();
        
        if (result.success && result.path) {
          const videoUrl = toFileUrl(result.path);
          setVideoPath(videoUrl);
          setVideoFilePath(result.path);
          setSourceFrameRate(
            Number.isFinite(result.metadata?.frameRate) ? result.metadata?.frameRate : undefined,
          );
          const metadataWithCursor = result.metadata as {
            cursorTrack?: unknown;
            hasMicrophoneAudio?: unknown;
          } | undefined;
          setCursorTrack(normalizeCursorTrack(metadataWithCursor?.cursorTrack));
          if (typeof metadataWithCursor?.hasMicrophoneAudio === "boolean") {
            setSourceHasAudio(metadataWithCursor.hasMicrophoneAudio);
            setAudioEnabled(metadataWithCursor.hasMicrophoneAudio);
          } else {
            setSourceHasAudio(true);
            setAudioEnabled(true);
          }

          // Restore project state if available
          try {
            const saved = await window.electronAPI.loadProjectState(result.path);
            const savedState = saved.state as ProjectState | undefined;
            if (saved.success && savedState?.version === 1) {
              const s = savedState;

              // Helper: extract numeric suffix from IDs like "seg-5" or "zoom-12"
              const maxIdNum = (items: { id: string }[], prefix: string) =>
                items.reduce((max, it) => {
                  const m = it.id.match(new RegExp(`^${prefix}(\\d+)$`));
                  return m ? Math.max(max, parseInt(m[1], 10)) : max;
                }, 0);

              // Restore segments — re-ID duplicates to guarantee uniqueness
              if (Array.isArray(s.segments) && s.segments.length > 0) {
                const seen = new Set<string>();
                let maxSeg = maxIdNum(s.segments, 'seg-');
                const fixedSegs = s.segments.map(seg => {
                  if (seen.has(seg.id)) {
                    return { ...seg, id: `seg-${++maxSeg}` };
                  }
                  seen.add(seg.id);
                  return seg;
                });
                setSegments(fixedSegs);
                nextSegIdRef.current = maxSeg + 1;
              }

              // Restore zoom regions — deduplicate exact duplicates, then re-ID remaining ID collisions
              if (s.zoomRegionsByAspect && typeof s.zoomRegionsByAspect === 'object') {
                const fixedByAspect: Record<string, ZoomRegion[]> = {};
                let globalMaxZoom = 0;
                for (const [aspect, regions] of Object.entries(s.zoomRegionsByAspect as Record<string, ZoomRegion[]>)) {
                  if (!Array.isArray(regions)) continue;
                  // Remove exact content duplicates (same id + startMs + endMs + depth)
                  const contentKeys = new Set<string>();
                  const deduped = regions.filter(r => {
                    const key = `${r.id}|${r.startMs}|${r.endMs}|${r.depth}|${r.focus?.cx}|${r.focus?.cy}`;
                    if (contentKeys.has(key)) return false;
                    contentKeys.add(key);
                    return true;
                  });
                  // Re-ID any remaining ID collisions
                  let maxZ = maxIdNum(deduped, 'zoom-');
                  const seenIds = new Set<string>();
                  const fixed = deduped.map(r => {
                    if (seenIds.has(r.id)) {
                      return { ...r, id: `zoom-${++maxZ}` };
                    }
                    seenIds.add(r.id);
                    return r;
                  });
                  fixedByAspect[aspect] = fixed;
                  globalMaxZoom = Math.max(globalMaxZoom, maxZ);
                }
                setZoomRegionsByAspect(fixedByAspect);
                nextZoomIdRef.current = globalMaxZoom + 1;
              }

              // Restore annotation regions and sync counters
              if (Array.isArray(s.annotationRegions)) {
                setAnnotationRegions(s.annotationRegions);
                const maxAnno = maxIdNum(s.annotationRegions, 'anno-');
                if (maxAnno > 0) nextAnnotationIdRef.current = maxAnno + 1;
                const maxZ = s.annotationRegions.reduce(
                  (max: number, a: { zIndex?: number }) => Math.max(max, a.zIndex ?? 0), 0,
                );
                if (maxZ > 0) nextAnnotationZIndexRef.current = maxZ + 1;
              }
              if (Array.isArray(s.audioEditRegions)) setAudioEditRegions(s.audioEditRegions);
              if (s.cropRegionsByAspect && typeof s.cropRegionsByAspect === 'object') {
                setCropRegionsByAspect(s.cropRegionsByAspect as Partial<Record<AspectRatio, CropRegion>>);
              }
              if (typeof s.aspectRatio === 'string') setAspectRatio(s.aspectRatio as AspectRatio);
              if (typeof s.wallpaper === 'string') setWallpaper(s.wallpaper);
              if (typeof s.shadowIntensity === 'number') setShadowIntensity(s.shadowIntensity);
              if (typeof s.showBlur === 'boolean') setShowBlur(s.showBlur);
              if (typeof s.motionBlurEnabled === 'boolean') setMotionBlurEnabled(s.motionBlurEnabled);
              if (typeof s.borderRadius === 'number') setBorderRadius(s.borderRadius);
              if (typeof s.padding === 'number') setPadding(s.padding);
              if (typeof s.audioEnabled === 'boolean') setAudioEnabled(s.audioEnabled);
              if (typeof s.audioGain === 'number') setAudioGain(s.audioGain);
              if (typeof s.audioNormalizeLoudness === 'boolean') setAudioNormalizeLoudness(s.audioNormalizeLoudness);
              if (typeof s.audioTargetLufs === 'number') setAudioTargetLufs(s.audioTargetLufs);
              if (typeof s.audioLimiterDb === 'number') setAudioLimiterDb(s.audioLimiterDb);
              if (typeof s.exportQuality === 'string') setExportQuality(s.exportQuality as ExportQuality);
              if (typeof s.exportFormat === 'string') setExportFormat(s.exportFormat as ExportFormat);
              if (typeof s.seekStepSeconds === 'number') setSeekStepSeconds(s.seekStepSeconds);
              if (typeof s.previewPlaybackRate === 'number') setPreviewPlaybackRate(s.previewPlaybackRate);
              // Restore cursor style (v1.1)
              if (s.cursorStyle && typeof s.cursorStyle === 'object') {
                setCursorStyle(prev => ({ ...prev, ...s.cursorStyle } as CursorStyleConfig));
              }
              // Restore subtitle cues (v1.1) — preserves manual edits
              if (Array.isArray(s.subtitleCues) && s.subtitleCues.length > 0) {
                setSubtitleCues(s.subtitleCues as SubtitleCue[]);
              }
              // Restore GIF export settings (v1.1)
              if (typeof s.gifFrameRate === 'number') setGifFrameRate(s.gifFrameRate as GifFrameRate);
              if (typeof s.gifLoop === 'boolean') setGifLoop(s.gifLoop);
              if (typeof s.gifSizePreset === 'string') setGifSizePreset(s.gifSizePreset as GifSizePreset);
              // Restore batch export aspect ratios (v1.1)
              if (Array.isArray(s.exportAspectRatios) && s.exportAspectRatios.length > 0) {
                setExportAspectRatios(s.exportAspectRatios as AspectRatio[]);
              }
              // Restore timeline zoom level (v1.1)
              if (typeof s.timelineZoomVisibleMs === 'number' && s.timelineZoomVisibleMs > 0) {
                const savedZoom = s.timelineZoomVisibleMs;
                // Defer until TimelineEditor mounts and registers its zoomSetRef
                setTimeout(() => {
                  timelineZoomSetRef.current?.(savedZoom);
                }, 200);
              }
              // Mark that project state was restored (guards wallpaper init race)
              projectRestoredRef.current = true;
              // Defer playhead restore until video is loaded
              if (typeof s.playheadPosition === 'number' && s.playheadPosition > 0) {
                requestAnimationFrame(() => {
                  const video = videoPlaybackRef.current?.video;
                  if (video) {
                    video.currentTime = s.playheadPosition;
                  }
                });
              }
            }
          } catch {
            // Corrupt or missing project state — ignore
          }
        } else {
          setVideoFilePath(null);
          setError(t('editor.noVideo'));
        }
      } catch (err) {
        setError(t("editor.loadVideoError", { message: String(err) }));
      } finally {
        setLoading(false);
      }
    }
    loadVideo();
  }, [t]);

  // Debounced auto-save project state (2s delay)
  // Use ref for currentTime to avoid re-triggering on every playback frame
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;
  const lastSavedHashRef = useRef<string>('');
  useEffect(() => {
    if (!videoFilePath) return;
    const timer = setTimeout(() => {
      const state: ProjectState = {
        version: 1,
        savedAt: Date.now(),
        videoFilePath,
        segments,
        zoomRegionsByAspect: zoomRegionsByAspect as Record<string, ZoomRegion[]>,
        annotationRegions,
        audioEditRegions,
        cropRegionsByAspect: cropRegionsByAspect as Record<string, CropRegion>,
        aspectRatio,
        wallpaper,
        shadowIntensity,
        showBlur,
        motionBlurEnabled,
        borderRadius,
        padding,
        audioEnabled,
        audioGain,
        audioNormalizeLoudness,
        audioTargetLufs,
        audioLimiterDb,
        exportQuality,
        exportFormat,
        seekStepSeconds,
        previewPlaybackRate,
        playheadPosition: currentTimeRef.current,
        cursorStyle,
        subtitleCues: subtitleCues as ProjectState['subtitleCues'],
        gifFrameRate,
        gifLoop,
        gifSizePreset,
        exportAspectRatios,
        timelineZoomVisibleMs: timelineZoomInfo?.visibleMs,
      };
      const hash = JSON.stringify(state);
      if (hash === lastSavedHashRef.current) return;
      lastSavedHashRef.current = hash;
      window.electronAPI.saveProjectState(videoFilePath, state).catch(() => {});
    }, 2000);
    return () => clearTimeout(timer);
  }, [
    videoFilePath, segments, zoomRegionsByAspect, annotationRegions,
    audioEditRegions, cropRegionsByAspect, aspectRatio, wallpaper,
    shadowIntensity, showBlur, motionBlurEnabled, borderRadius, padding,
    audioEnabled, audioGain, audioNormalizeLoudness, audioTargetLufs,
    audioLimiterDb, exportQuality, exportFormat, seekStepSeconds,
    previewPlaybackRate, cursorStyle, subtitleCues, gifFrameRate,
    gifLoop, gifSizePreset, exportAspectRatios, timelineZoomInfo,
  ]);

  // ── Undo / Redo history ──
  // Tracks snapshots of core editable state (segments, zoom, annotations, audio edits).
  // Pushes the PREVIOUS state onto the undo stack whenever tracked state changes.
  interface EditorSnapshot {
    segments: VideoSegment[];
    zoomRegionsByAspect: ZoomRegionsByAspect;
    annotationRegions: AnnotationRegion[];
    audioEditRegions: AudioEditRegion[];
  }
  const MAX_UNDO_HISTORY = 50;
  const undoStackRef = useRef<EditorSnapshot[]>([]);
  const redoStackRef = useRef<EditorSnapshot[]>([]);
  const isRestoringHistoryRef = useRef(false);
  const prevEditableRef = useRef<EditorSnapshot | null>(null);
  const historyReadyRef = useRef(false);

  // Track state changes and push to undo stack
  useEffect(() => {
    const current: EditorSnapshot = { segments, zoomRegionsByAspect, annotationRegions, audioEditRegions };

    // Skip when restoring from undo/redo
    if (isRestoringHistoryRef.current) {
      isRestoringHistoryRef.current = false;
      prevEditableRef.current = current;
      return;
    }

    // Wait until segments are loaded (initial load or project restore)
    if (!historyReadyRef.current) {
      prevEditableRef.current = current;
      if (segments.length > 0) historyReadyRef.current = true;
      return;
    }

    // Push previous state to undo stack
    if (prevEditableRef.current) {
      undoStackRef.current.push(prevEditableRef.current);
      if (undoStackRef.current.length > MAX_UNDO_HISTORY) undoStackRef.current.shift();
      redoStackRef.current = []; // New user action clears redo
    }
    prevEditableRef.current = current;
  }, [segments, zoomRegionsByAspect, annotationRegions, audioEditRegions]);

  const handleUndo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;
    const snapshot = undoStackRef.current.pop()!;
    // Save current state to redo stack
    redoStackRef.current.push({ segments, zoomRegionsByAspect, annotationRegions, audioEditRegions });
    // Restore snapshot
    isRestoringHistoryRef.current = true;
    setSegments(snapshot.segments);
    setZoomRegionsByAspect(snapshot.zoomRegionsByAspect);
    setAnnotationRegions(snapshot.annotationRegions);
    setAudioEditRegions(snapshot.audioEditRegions);
  }, [segments, zoomRegionsByAspect, annotationRegions, audioEditRegions]);

  const handleRedo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    const snapshot = redoStackRef.current.pop()!;
    // Save current state to undo stack
    undoStackRef.current.push({ segments, zoomRegionsByAspect, annotationRegions, audioEditRegions });
    // Restore snapshot
    isRestoringHistoryRef.current = true;
    setSegments(snapshot.segments);
    setZoomRegionsByAspect(snapshot.zoomRegionsByAspect);
    setAnnotationRegions(snapshot.annotationRegions);
    setAudioEditRegions(snapshot.audioEditRegions);
  }, [segments, zoomRegionsByAspect, annotationRegions, audioEditRegions]);

  // Initialize default wallpaper with resolved asset path
  // Skip if project state was already restored (avoids overwriting saved wallpaper)
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const resolvedPath = await getAssetPath('wallpapers/wallpaper1.jpg');
        if (mounted && !projectRestoredRef.current) {
          setWallpaper(resolvedPath);
        }
      } catch (err) {
        // If resolution fails, keep the fallback
        console.warn('Failed to resolve default wallpaper path:', err);
      }
    })();
    return () => { mounted = false };
  }, []);

  // Reset projectRestoredRef after initial effects have processed.
  // This is a one-shot flag: true during first render cycle (so wallpaper init
  // and sidecar loader can check it), then reset so future re-triggers work normally.
  useEffect(() => {
    if (projectRestoredRef.current) {
      const timer = setTimeout(() => { projectRestoredRef.current = false; }, 500);
      return () => clearTimeout(timer);
    }
  }, []);

  function togglePlayPause() {
    const playback = videoPlaybackRef.current;
    const video = playback?.video;
    if (!playback || !video) return;

    if (isPlaying) {
      playback.pause();
    } else {
      // If hovering with ghost cursor, commit so playback starts from hover position
      commitHoverPreview();
      playback.play().catch(err => console.error('Video play failed:', err));
    }
  }

  function handleSeek(time: number) {
    const video = videoPlaybackRef.current?.video;
    if (!video) return;
    // time comes from the UI in effective seconds; convert to source
    const segs = segmentsRef.current;
    if (segs.length > 0) {
      video.currentTime = effectiveToSourceMsWithSegments(time * 1000, segs) / 1000;
    } else {
      const trims = normalizedTrimsRef.current;
      if (trims.length > 0) {
        video.currentTime = effectiveToSourceMs(time * 1000, trims) / 1000;
      } else {
        video.currentTime = time;
      }
    }
  }

  // Refs for the keydown handler (stale-closure avoidance — useEffect has [] deps)
  const effectiveCurrentTimeRef = useRef(effectiveCurrentTime);
  effectiveCurrentTimeRef.current = effectiveCurrentTime;
  const effectiveDurationRef = useRef(effectiveDuration);
  effectiveDurationRef.current = effectiveDuration;
  const seekStepSecondsRef = useRef(seekStepSeconds);
  seekStepSecondsRef.current = seekStepSeconds;
  const handleSeekRef = useRef(handleSeek);
  handleSeekRef.current = handleSeek;
  const previewPlaybackRateRef = useRef(previewPlaybackRate);
  previewPlaybackRateRef.current = previewPlaybackRate;
  const handleUndoRef = useRef(handleUndo);
  handleUndoRef.current = handleUndo;
  const handleRedoRef = useRef(handleRedo);
  handleRedoRef.current = handleRedo;

  // Hover preview: temporarily seek video to hover position (only when paused).
  // We suppress onTimeUpdate while previewing so the real playhead doesn't move.
  const hoverPreviewActiveRef = useRef(false);
  const savedCurrentTimeRef = useRef<number | null>(null);
  const handleTimeUpdate = useCallback((time: number) => {
    if (hoverPreviewActiveRef.current) return; // suppress during hover
    setCurrentTime(time);
  }, []);
  // Commit hover preview: accept current video position as the real playhead
  // (used when user clicks timeline, starts dragging, or presses play)
  const commitHoverPreview = useCallback(() => {
    if (!hoverPreviewActiveRef.current) return;
    hoverPreviewActiveRef.current = false;
    savedCurrentTimeRef.current = null;
    // Immediately sync React state so PlaybackCursor jumps to the hover position
    const video = videoPlaybackRef.current?.video;
    if (video) {
      setCurrentTime(video.currentTime);
    }
  }, []);

  // Hover preview seek queue: wait for each seek to complete before starting the next.
  // This prevents seeks from piling up and skipping frames during slow mouse movement.
  const hoverSeekBusyRef = useRef(false);
  const hoverSeekPendingRef = useRef<number | null>(null);

  const forceTextureUpdate = useCallback(() => {
    try {
      const sprite = videoPlaybackRef.current?.videoSprite;
      if (sprite?.texture?.source && 'update' in sprite.texture.source) {
        (sprite.texture.source as { update: () => void }).update();
      }
    } catch { /* ignore */ }
  }, []);

  const executeHoverSeek = useCallback((sourceTimeSec: number) => {
    const video = videoPlaybackRef.current?.video;
    if (!video) return;
    hoverSeekBusyRef.current = true;
    const onSeeked = () => {
      forceTextureUpdate();
      hoverSeekBusyRef.current = false;
      // Process pending seek if one arrived while we were busy
      const pending = hoverSeekPendingRef.current;
      if (pending !== null) {
        hoverSeekPendingRef.current = null;
        executeHoverSeek(pending);
      }
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.currentTime = sourceTimeSec;
  }, [forceTextureUpdate]);

  const handleHoverPreview = useCallback((effectiveTimeMs: number | null) => {
    if (isPlaying) return;
    const video = videoPlaybackRef.current?.video;
    if (!video) return;

    if (effectiveTimeMs === null) {
      // Cancel any pending seek
      hoverSeekPendingRef.current = null;
      if (hoverPreviewActiveRef.current) {
        hoverPreviewActiveRef.current = false;
        const saved = savedCurrentTimeRef.current;
        savedCurrentTimeRef.current = null;
        if (saved !== null) {
          video.addEventListener('seeked', forceTextureUpdate, { once: true });
          video.currentTime = saved;
        }
      }
      return;
    }
    if (!hoverPreviewActiveRef.current) {
      savedCurrentTimeRef.current = video.currentTime;
      hoverPreviewActiveRef.current = true;
    }

    // Convert effective time to source time
    let sourceTimeSec: number;
    const segs = segmentsRef.current;
    if (segs.length > 0) {
      sourceTimeSec = effectiveToSourceMsWithSegments(effectiveTimeMs, segs) / 1000;
    } else {
      const trims = normalizedTrimsRef.current;
      if (trims.length > 0) {
        sourceTimeSec = effectiveToSourceMs(effectiveTimeMs, trims) / 1000;
      } else {
        sourceTimeSec = effectiveTimeMs / 1000;
      }
    }

    if (hoverSeekBusyRef.current) {
      // A seek is in progress — queue this one (latest wins)
      hoverSeekPendingRef.current = sourceTimeSec;
    } else {
      executeHoverSeek(sourceTimeSec);
    }
  }, [isPlaying, executeHoverSeek, forceTextureUpdate]);

  const handleSelectZoom = useCallback((id: string | null) => {
    setSelectedZoomIdForActiveAspect(id);
    if (id) setSelectedSegmentId(null);
  }, [setSelectedZoomIdForActiveAspect]);

  const handleSelectSegment = useCallback((id: string | null) => {
    setSelectedSegmentId(id);
    if (id) {
      setSelectedZoomIdForActiveAspect(null);
      setSelectedAnnotationId(null);
    }
  }, [setSelectedZoomIdForActiveAspect]);

  const handleSelectAnnotation = useCallback((id: string | null) => {
    setSelectedAnnotationId(id);
    if (id) {
      setSelectedZoomIdForActiveAspect(null);
      setSelectedSegmentId(null);
    }
  }, [setSelectedZoomIdForActiveAspect]);

  const handleZoomAdded = useCallback((span: Span) => {
    const segs = segmentsRef.current;
    const trims = normalizedTrimsRef.current;
    const startMs = segs.length > 0 ? effectiveToSourceMsWithSegments(span.start, segs)
      : trims.length > 0 ? effectiveToSourceMs(span.start, trims) : span.start;
    const endMs = segs.length > 0 ? effectiveToSourceMsWithSegments(span.end, segs)
      : trims.length > 0 ? effectiveToSourceMs(span.end, trims) : span.end;
    const id = `zoom-${nextZoomIdRef.current++}`;
    const newRegion: ZoomRegion = {
      id,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      depth: DEFAULT_ZOOM_DEPTH,
      focus: { cx: 0.5, cy: 0.5 },
    };
    setZoomRegionsForActiveAspect((prev) => [...prev, newRegion]);
    setSelectedZoomIdForActiveAspect(id);
    setSelectedSegmentId(null);
    setSelectedAnnotationId(null);
  }, [setSelectedZoomIdForActiveAspect, setZoomRegionsForActiveAspect]);

  // Split at a specific effective time (in ms). Used by scissors-mode click.
  const handleSplitAtTime = useCallback((effectiveMs: number) => {
    if (segments.length === 0 || !Number.isFinite(duration) || duration <= 0) return;
    const sourceMs = segments.length > 0
      ? effectiveToSourceMsWithSegments(effectiveMs, segments)
      : effectiveMs;
    const segIdx = segments.findIndex(
      (s) => !s.deleted && sourceMs > s.startMs && sourceMs < s.endMs,
    );
    if (segIdx === -1) return;
    const seg = segments[segIdx];
    const splitPoint = Math.round(sourceMs);
    if (splitPoint - seg.startMs < 50 || seg.endMs - splitPoint < 50) return;
    const newSegments = [...segments];
    newSegments.splice(segIdx, 1,
      { ...seg, endMs: splitPoint },
      { id: `seg-${nextSegIdRef.current++}`, startMs: splitPoint, endMs: seg.endMs, deleted: false, speed: seg.speed },
    );
    setSegments(newSegments);
  }, [segments, duration]);

  const handleDeleteSegment = useCallback(() => {
    if (!selectedSegmentId) return;
    const nonDeletedCount = segments.filter((s) => !s.deleted).length;
    if (nonDeletedCount <= 1) {
      toast.error(t("timeline.cannotDeleteLastSegment"));
      return;
    }
    setSegments((prev) => prev.map((s) =>
      s.id === selectedSegmentId ? { ...s, deleted: true } : s,
    ));
    setSelectedSegmentId(null);
  }, [selectedSegmentId, segments, t]);

  const handleSegmentSpeedChange = useCallback((id: string, speed: number) => {
    const clampedSpeed = Math.max(0.25, Math.min(40, speed));
    setSegments((prev) => prev.map((s) =>
      s.id === id ? { ...s, speed: clampedSpeed } : s,
    ));
  }, []);

  const handleZoomSpanChange = useCallback((id: string, span: Span) => {
    const segs = segmentsRef.current;
    const trims = normalizedTrimsRef.current;
    const startMs = segs.length > 0 ? effectiveToSourceMsWithSegments(span.start, segs)
      : trims.length > 0 ? effectiveToSourceMs(span.start, trims) : span.start;
    const endMs = segs.length > 0 ? effectiveToSourceMsWithSegments(span.end, segs)
      : trims.length > 0 ? effectiveToSourceMs(span.end, trims) : span.end;
    setZoomRegionsForActiveAspect((prev) =>
      prev.map((region) =>
        region.id === id
          ? {
              ...region,
              startMs: Math.round(startMs),
              endMs: Math.round(endMs),
            }
          : region,
      ),
    );
  }, [setZoomRegionsForActiveAspect]);

  // handleTrimSpanChange removed — trims are now derived from deleted segments

  const handleZoomFocusChange = useCallback((id: string, focus: ZoomFocus) => {
    setZoomRegionsForActiveAspect((prev) =>
      prev.map((region) =>
        region.id === id
          ? {
              ...region,
              focus: clampFocusToDepth(focus, region.depth),
            }
          : region,
      ),
    );
  }, [setZoomRegionsForActiveAspect]);

  const handleZoomDepthChange = useCallback((depth: ZoomDepth) => {
    if (!selectedZoomId) return;
    setZoomRegionsForActiveAspect((prev) =>
      prev.map((region) =>
        region.id === selectedZoomId
          ? {
              ...region,
              depth,
              focus: clampFocusToDepth(region.focus, depth),
            }
          : region,
      ),
    );
  }, [selectedZoomId, setZoomRegionsForActiveAspect]);

  const handleZoomDelete = useCallback((id: string) => {
    setZoomRegionsForActiveAspect((prev) => prev.filter((region) => region.id !== id));
    if (selectedZoomId === id) {
      setSelectedZoomIdForActiveAspect(null);
    }
  }, [selectedZoomId, setSelectedZoomIdForActiveAspect, setZoomRegionsForActiveAspect]);

  const applyAutoZoomEdits = useCallback((options?: { silent?: boolean }) => {
    const durationMs = Math.round(duration * 1000);
    if (!Number.isFinite(durationMs) || durationMs < 200 || !cursorTrack?.samples?.length) {
      if (!options?.silent) {
        toast.info(t("editor.autoEditUnavailable"));
      }
      return 0;
    }

    const drafts = generateAutoZoomDrafts(cursorTrack, {
      durationMs,
      maxRegions: 64,
    });

    if (drafts.length === 0) {
      if (!options?.silent) {
        toast.info(t("editor.autoEditUnavailable"));
      }
      return 0;
    }

    const generatedZoomRegions: ZoomRegion[] = drafts.map((draft) => ({
      id: `zoom-${nextZoomIdRef.current++}`,
      startMs: draft.startMs,
      endMs: draft.endMs,
      depth: draft.depth,
      focus: clampFocusToDepth(draft.focus, draft.depth),
    }));

    setZoomRegionsByAspect((previous) =>
      setZoomRegionsForAspect(previous, aspectRatio, generatedZoomRegions),
    );
    setSelectedZoomIdForActiveAspect(generatedZoomRegions[0]?.id ?? null);
    setSelectedSegmentId(null);
    setSelectedAnnotationId(null);

    if (!options?.silent) {
      toast.success(t("editor.autoEditApplied", { count: generatedZoomRegions.length }));
    }

    return generatedZoomRegions.length;
  }, [aspectRatio, cursorTrack, duration, setSelectedZoomIdForActiveAspect, t]);

  const handleAutoEdit = useCallback(() => {
    autoEditInitializedAspectsRef.current.add(aspectRatio);
    applyAutoZoomEdits();
  }, [applyAutoZoomEdits, aspectRatio]);



  const handleAnnotationAdded = useCallback((span: Span) => {
    const segs = segmentsRef.current;
    const trims = normalizedTrimsRef.current;
    const startMs = segs.length > 0 ? effectiveToSourceMsWithSegments(span.start, segs)
      : trims.length > 0 ? effectiveToSourceMs(span.start, trims) : span.start;
    const endMs = segs.length > 0 ? effectiveToSourceMsWithSegments(span.end, segs)
      : trims.length > 0 ? effectiveToSourceMs(span.end, trims) : span.end;
    const id = `annotation-${nextAnnotationIdRef.current++}`;
    const zIndex = nextAnnotationZIndexRef.current++; // Assign z-index based on creation order
    const newRegion: AnnotationRegion = {
      id,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      type: 'text',
      content: 'Enter text...',
      position: { ...DEFAULT_ANNOTATION_POSITION },
      size: { ...DEFAULT_ANNOTATION_SIZE },
      style: { ...DEFAULT_ANNOTATION_STYLE },
      zIndex,
    };
    setAnnotationRegions((prev) => [...prev, newRegion]);
    setSelectedAnnotationId(id);
    setSelectedZoomIdForActiveAspect(null);
    setSelectedSegmentId(null);
  }, [setSelectedZoomIdForActiveAspect]);

  const handleAnnotationSpanChange = useCallback((id: string, span: Span) => {
    const segs = segmentsRef.current;
    const trims = normalizedTrimsRef.current;
    const startMs = segs.length > 0 ? effectiveToSourceMsWithSegments(span.start, segs)
      : trims.length > 0 ? effectiveToSourceMs(span.start, trims) : span.start;
    const endMs = segs.length > 0 ? effectiveToSourceMsWithSegments(span.end, segs)
      : trims.length > 0 ? effectiveToSourceMs(span.end, trims) : span.end;
    setAnnotationRegions((prev) =>
      prev.map((region) =>
        region.id === id
          ? {
              ...region,
              startMs: Math.round(startMs),
              endMs: Math.round(endMs),
            }
          : region,
      ),
    );
  }, []);

  const handleAnnotationDelete = useCallback((id: string) => {
    setAnnotationRegions((prev) => prev.filter((region) => region.id !== id));
    if (selectedAnnotationId === id) {
      setSelectedAnnotationId(null);
    }
  }, [selectedAnnotationId]);

  const handleAnnotationContentChange = useCallback((id: string, content: string) => {
    setAnnotationRegions((prev) => {
      const updated = prev.map((region) => {
        if (region.id !== id) return region;
        
        // Store content in type-specific fields
        if (region.type === 'text') {
          return { ...region, content, textContent: content };
        } else if (region.type === 'image') {
          return { ...region, content, imageContent: content };
        } else {
          return { ...region, content };
        }
      });
      return updated;
    });
  }, []);

  const handleAnnotationTypeChange = useCallback((id: string, type: AnnotationRegion['type']) => {
    setAnnotationRegions((prev) => {
      const updated = prev.map((region) => {
        if (region.id !== id) return region;
        
        const updatedRegion = { ...region, type };
        
        // Restore content from type-specific storage
        if (type === 'text') {
          updatedRegion.content = region.textContent || 'Enter text...';
        } else if (type === 'image') {
          updatedRegion.content = region.imageContent || '';
        } else if (type === 'figure') {
          updatedRegion.content = '';
          if (!region.figureData) {
            updatedRegion.figureData = { ...DEFAULT_FIGURE_DATA };
          }
        }
        
        return updatedRegion;
      });
      return updated;
    });
  }, []);

  const handleAnnotationStyleChange = useCallback((id: string, style: Partial<AnnotationRegion['style']>) => {
    setAnnotationRegions((prev) =>
      prev.map((region) =>
        region.id === id
          ? { ...region, style: { ...region.style, ...style } }
          : region,
      ),
    );
  }, []);

  const handleAnnotationFigureDataChange = useCallback((id: string, figureData: FigureData) => {
    setAnnotationRegions((prev) =>
      prev.map((region) =>
        region.id === id
          ? { ...region, figureData }
          : region,
      ),
    );
  }, []);

  const handleAnnotationPositionChange = useCallback((id: string, position: { x: number; y: number }) => {
    setAnnotationRegions((prev) =>
      prev.map((region) =>
        region.id === id
          ? { ...region, position }
          : region,
      ),
    );
  }, []);

  const handleAnnotationSizeChange = useCallback((id: string, size: { width: number; height: number }) => {
    setAnnotationRegions((prev) =>
      prev.map((region) =>
        region.id === id
          ? { ...region, size }
          : region,
      ),
    );
  }, []);
  
  // Global Tab prevention
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        // Allow tab only in inputs/textareas
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
          return;
        }
        e.preventDefault();
      }

      if (matchesShortcut(e, keyShortcutsRef.current.playPause, isMacRef.current)) {
        // Allow space only in inputs/textareas
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
          return;
        }
        e.preventDefault();

        const playback = videoPlaybackRef.current;
        if (playback?.video) {
          if (playback.video.paused) {
            // If hovering with ghost cursor, commit so playback starts from hover position
            commitHoverPreview();
            playback.play().catch(console.error);
          } else {
            playback.pause();
          }
        }
      }

      // Arrow key navigation: seek forward/backward in effective time
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
          return;
        }
        e.preventDefault();
        commitHoverPreview();
        const step = e.shiftKey ? 1 : seekStepSecondsRef.current;
        const direction = e.key === 'ArrowRight' ? 1 : -1;
        const current = effectiveCurrentTimeRef.current;
        const maxTime = effectiveDurationRef.current;
        const newTime = Math.max(0, Math.min(maxTime, current + step * direction));
        handleSeekRef.current(newTime);
      }

      // Speed up/down
      const isSpeedUp = matchesShortcut(e, keyShortcutsRef.current.speedUp, isMacRef.current);
      const isSpeedDown = matchesShortcut(e, keyShortcutsRef.current.speedDown, isMacRef.current);
      if (isSpeedUp || isSpeedDown) {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        const speeds = [0.25, 0.5, 1, 1.5, 2, 3, 4, 8, 16, 32];
        const currentRate = previewPlaybackRateRef.current;
        const idx = speeds.findIndex(s => Math.abs(s - currentRate) < 0.01);
        const curIdx = idx === -1 ? speeds.indexOf(1) : idx;
        const newIdx = isSpeedUp
          ? Math.min(speeds.length - 1, curIdx + 1)
          : Math.max(0, curIdx - 1);
        setPreviewPlaybackRate(speeds[newIdx]);
      }

      // Fullscreen toggle: F11
      if (e.key === 'F11') {
        e.preventDefault();
        toggleFullscreen();
      }

      // Timeline zoom in/out: = / -
      if (e.key === '=' || e.key === '-') {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        if (e.ctrlKey || e.metaKey) return; // don't hijack browser zoom
        e.preventDefault();
        timelineZoomStepRef.current?.(e.key === '=' ? 1 : -1);
      }

      // Undo: Ctrl+Z / Cmd+Z
      if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        handleUndoRef.current();
      }
      // Redo: Ctrl+Shift+Z / Cmd+Shift+Z or Ctrl+Y / Cmd+Y
      if (((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && e.shiftKey) ||
          ((e.key === 'y' || e.key === 'Y') && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        handleRedoRef.current();
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);

  useEffect(() => {
    setSelectedZoomIdByAspect((previous) =>
      clearStaleSelectedZoomIdForAspect(previous, zoomRegionsByAspect, aspectRatio),
    );
  }, [aspectRatio, zoomRegionsByAspect]);

  useEffect(() => {
    if (selectedSegmentId && !segments.some((s) => s.id === selectedSegmentId && !s.deleted)) {
      setSelectedSegmentId(null);
    }
  }, [selectedSegmentId, segments]);

  useEffect(() => {
    if (selectedAnnotationId && !annotationRegions.some((region) => region.id === selectedAnnotationId)) {
      setSelectedAnnotationId(null);
    }
  }, [selectedAnnotationId, annotationRegions]);

  useEffect(() => {
    setCropRegionsByAspect((previous) => {
      const normalized = resolveAspectCropRegion(previous, aspectRatio, sourceAspectRatio);
      const existing = previous[aspectRatio];
      if (existing && cropRegionEquals(existing, normalized)) {
        return previous;
      }
      return {
        ...previous,
        [aspectRatio]: normalized,
      };
    });
  }, [aspectRatio, sourceAspectRatio]);

  useEffect(() => {
    if (loading) return;
    if (autoEditInitializedAspectsRef.current.has(aspectRatio)) return;
    if (zoomRegions.length > 0) {
      autoEditInitializedAspectsRef.current.add(aspectRatio);
      return;
    }
    if (!cursorTrack?.samples?.length) {
      autoEditInitializedAspectsRef.current.add(aspectRatio);
      return;
    }
    if (!Number.isFinite(duration) || duration <= 0) return;

    autoEditInitializedAspectsRef.current.add(aspectRatio);
    applyAutoZoomEdits({ silent: true });
  }, [applyAutoZoomEdits, aspectRatio, cursorTrack, duration, loading, zoomRegions.length]);

  const handleAnalyzeCursor = useCallback(async () => {
    if (cursorAnalysisProgress !== null) return;
    const video = videoPlaybackRef.current?.video;
    if (!video || !videoPath || !Number.isFinite(duration) || duration <= 0) {
      toast.error(t("editor.analyzeCursorNoVideo"));
      return;
    }

    const w = video.videoWidth || 1920;
    const h = video.videoHeight || 1080;
    const analyzer = new VideoMouseAnalyzer();
    cursorAnalyzerRef.current = analyzer;
    setCursorAnalysisProgress(0);

    try {
      const track = await analyzer.analyze(videoPath, duration, w, h, (pct) => {
        setCursorAnalysisProgress(pct);
      });

      if (track && track.samples.length > 0) {
        setCursorTrack(track);
        toast.success(t("editor.analyzeCursorDone", { count: track.samples.length }));
      } else {
        toast.warning(t("editor.analyzeCursorEmpty"));
      }
    } catch (err) {
      toast.error(t("editor.analyzeCursorError", { message: String(err) }));
    } finally {
      setCursorAnalysisProgress(null);
      cursorAnalyzerRef.current = null;
    }
  }, [cursorAnalysisProgress, videoPath, duration, t]);

  const stopAnalysisPolling = useCallback(() => {
    if (analysisPollingTimerRef.current) {
      clearInterval(analysisPollingTimerRef.current);
      analysisPollingTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      stopAnalysisPolling();
      cursorAnalyzerRef.current?.cancel();
    };
  }, [stopAnalysisPolling]);

  const applyAnalysis = useCallback((analysis?: VideoAnalysisMetadata) => {
    if (!analysis) {
      setSubtitleCues([]);
      setRoughCutSuggestions([]);
      return;
    }

    const normalizedCues = normalizeSubtitleCues(Array.isArray(analysis.subtitleCues) ? analysis.subtitleCues : []);
    const transcriptWords = Array.isArray(analysis.transcript?.words) ? analysis.transcript.words : [];
    const fallbackDurationMs = transcriptWords.length > 0
      ? Math.max(0, Math.round(transcriptWords[transcriptWords.length - 1].endMs))
      : 0;
    const normalizedSuggestions = normalizeRoughCutSuggestions(
      Array.isArray(analysis.roughCutSuggestions) ? analysis.roughCutSuggestions : [],
      Math.max(fallbackDurationMs, Math.round(duration * 1000)),
    );
    setSubtitleCues(normalizedCues);
    setRoughCutSuggestions(normalizedSuggestions);
  }, [duration]);

  useEffect(() => {
    let cancelled = false;

    if (!videoFilePath) {
      applyAnalysis(undefined);
      return;
    }

    // If project state was restored with subtitle cues, don't clear them.
    // Only clear when there is no restored project state.
    if (!projectRestoredRef.current) {
      applyAnalysis(undefined);
    }
    void (async () => {
      try {
        const result = await window.electronAPI.getCurrentVideoAnalysis(videoFilePath);
        if (cancelled || !result.success) return;
        if (projectRestoredRef.current) {
          // Project state was restored — only load rough cut suggestions from sidecar,
          // keep the (possibly manually edited) subtitle cues from the project state.
          if (result.analysis) {
            const transcriptWords = Array.isArray(result.analysis.transcript?.words)
              ? result.analysis.transcript.words : [];
            const fallbackDurationMs = transcriptWords.length > 0
              ? Math.max(0, Math.round(transcriptWords[transcriptWords.length - 1].endMs)) : 0;
            setRoughCutSuggestions(
              normalizeRoughCutSuggestions(
                Array.isArray(result.analysis.roughCutSuggestions) ? result.analysis.roughCutSuggestions : [],
                Math.max(fallbackDurationMs, Math.round(duration * 1000)),
              ),
            );
          }
        } else {
          applyAnalysis(result.analysis);
        }
      } catch (error) {
        console.warn('Failed to load cached analysis sidecar:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applyAnalysis, videoFilePath, duration]);

  useEffect(() => {
    stopAnalysisPolling();
    setAnalysisInProgress(false);
    setAnalysisJobId(null);
  }, [stopAnalysisPolling, videoFilePath]);

  const handleGenerateSubtitles = useCallback(async () => {
    if (analysisInProgress) {
      return;
    }

    const targetPath = (videoFilePath || fromFileUrl(videoPath || '')).trim();
    if (!targetPath) {
      toast.error(t('editor.noVideoLoaded'));
      return;
    }

    const video = videoPlaybackRef.current?.video;
    const sourceWidth = video?.videoWidth || 1920;

    try {
      const result = await window.electronAPI.startVideoAnalysis({
        videoPath: targetPath,
        locale: locale === 'zh-CN' ? 'zh-CN' : 'en-US',
        durationMs: Math.max(0, Math.round(duration * 1000)),
        videoWidth: sourceWidth,
        subtitleWidthRatio: 0.82,
      });

      if (!result.success || !result.jobId) {
        toast.error(t('editor.analysisStartFailed'), {
          description: result.message,
        });
        return;
      }

      stopAnalysisPolling();
      setAnalysisInProgress(true);
      setAnalysisJobId(result.jobId);
      toast.info(t('editor.analysisRunning'));
    } catch (error) {
      toast.error(t('editor.analysisStartFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [analysisInProgress, duration, locale, stopAnalysisPolling, t, videoFilePath, videoPath]);

  useEffect(() => {
    if (!analysisJobId) {
      return;
    }

    let cancelled = false;
    let polling = false;

    const finishWithError = (message?: string) => {
      if (cancelled) return;
      stopAnalysisPolling();
      setAnalysisInProgress(false);
      setAnalysisJobId(null);
      toast.error(t('editor.analysisStartFailed'), {
        description: message || t('error.unexpected'),
      });
    };

    const pollOnce = async () => {
      if (polling || cancelled) return;
      polling = true;
      try {
        const statusResult = await window.electronAPI.getVideoAnalysisStatus(analysisJobId);
        if (!statusResult.success || !statusResult.status) {
          finishWithError(statusResult.message);
          return;
        }

        const jobStatus = statusResult.status.status;
        if (jobStatus === 'failed') {
          finishWithError(statusResult.status.error || statusResult.message);
          return;
        }

        if (jobStatus !== 'completed') {
          return;
        }

        const result = await window.electronAPI.getVideoAnalysisResult(analysisJobId);
        if (!result.success || !result.result) {
          finishWithError(result.message);
          return;
        }

        stopAnalysisPolling();
        setAnalysisInProgress(false);
        setAnalysisJobId(null);
        applyAnalysis(result.result);

        toast.success(t('editor.analysisCompleted'));
        if (!result.result.subtitleCues?.length) {
          toast.info(t('editor.analysisNoSubtitles'));
        }
        if (!result.result.roughCutSuggestions?.length) {
          toast.info(t('editor.analysisNoSuggestions'));
        }
      } catch (error) {
        finishWithError(error instanceof Error ? error.message : String(error));
      } finally {
        polling = false;
      }
    };

    void pollOnce();
    analysisPollingTimerRef.current = setInterval(() => {
      void pollOnce();
    }, 900);

    return () => {
      cancelled = true;
      stopAnalysisPolling();
    };
  }, [analysisJobId, applyAnalysis, stopAnalysisPolling, t]);

  const handleApplyRoughCut = useCallback(() => {
    if (!roughCutSuggestions.length) {
      toast.info(t('editor.analysisNoSuggestions'));
      return;
    }

    const nextAudioEditRegions = applyRoughCutSuggestionsToAudioEdits(
      audioEditRegions,
      roughCutSuggestions,
      Math.max(0, Math.round(duration * 1000)),
    );
    setAudioEditRegions(nextAudioEditRegions);
    setSelectedZoomIdForActiveAspect(null);
    setSelectedSegmentId(null);
    setSelectedAnnotationId(null);

    toast.success(t('editor.analysisApplyRoughCutSuccess', {
      count: roughCutSuggestions.length,
    }));
  }, [audioEditRegions, duration, roughCutSuggestions, setSelectedZoomIdForActiveAspect, t]);

  const handleExport = useCallback(async (settings: ExportSettings) => {
    if (!videoPath) {
      toast.error(t('editor.noVideoLoaded'));
      return;
    }

    const video = videoPlaybackRef.current?.video;
    if (!video) {
      toast.error(t('editor.videoNotReady'));
      return;
    }

    setIsExporting(true);
    setExportProgress(null);
    setExportError(null);
    setActiveBatchExport(null);
    exportCancelledRef.current = false;

    let shouldResumePlayback = false;
    const emittedWarningKeys = new Set<string>();
    const notifyExportWarnings = (warnings?: string[]) => {
      if (!warnings?.length) return;
      for (const warningKey of warnings) {
        if (!warningKey || emittedWarningKeys.has(warningKey)) continue;
        emittedWarningKeys.add(warningKey);
        toast.warning(t(warningKey));
      }
    };

    try {
      if (isPlaying) {
        videoPlaybackRef.current?.pause();
        shouldResumePlayback = true;
      }

      const sourceWidth = video.videoWidth || 1920;
      const sourceHeight = video.videoHeight || 1080;

      const playbackRef = videoPlaybackRef.current;
      const containerElement = playbackRef?.containerRef?.current;
      const previewWidth = containerElement?.clientWidth || 1920;
      const previewHeight = containerElement?.clientHeight || 1080;

      if (settings.format === 'gif' && settings.gifConfig) {
        const gifExporter = new GifExporter({
          videoUrl: videoPath,
          width: settings.gifConfig.width,
          height: settings.gifConfig.height,
          frameRate: settings.gifConfig.frameRate,
          loop: settings.gifConfig.loop,
          sizePreset: settings.gifConfig.sizePreset,
          wallpaper,
          zoomRegions,
          trimRegions,
          showShadow: shadowIntensity > 0,
          shadowIntensity,
          showBlur,
          motionBlurEnabled,
          borderRadius,
          padding,
          videoPadding: padding,
          cropRegion: activeCropRegion,
          annotationRegions,
          subtitleCues,
          previewWidth,
          previewHeight,
          cursorTrack,
          cursorStyle,
          segments,
          onProgress: (progress: ExportProgress) => {
            setExportProgress(progress);
          },
        });

        exporterRef.current = gifExporter;
        const result = await gifExporter.export();
        const cancelled = exportCancelledRef.current
          || (typeof result.error === 'string' && result.error.toLowerCase().includes('cancel'));

        if (cancelled) {
          toast.info(t('editor.exportCancelled'));
        } else if (result.success && result.blob) {
          notifyExportWarnings(result.warnings);
          const arrayBuffer = await result.blob.arrayBuffer();
          const timestamp = Date.now();
          const fileName = `export-${timestamp}.gif`;

          const saveResult = await window.electronAPI.saveExportedVideo(arrayBuffer, fileName, locale);

          if (saveResult.cancelled) {
            toast.info(t('editor.exportCancelled'));
          } else if (saveResult.success) {
            toast.success(t('editor.gifExportSuccess', { path: saveResult.path ?? '' }));
          } else {
            setExportError(saveResult.message || t('editor.saveGifFailed'));
            toast.error(saveResult.message || t('editor.saveGifFailed'));
          }
        } else {
          setExportError(result.error || t('editor.gifExportFailed'));
          toast.error(result.error || t('editor.gifExportFailed'));
        }
      } else {
        const quality = settings.quality || exportQuality;
        const ratiosToExport = normalizedExportAspectRatios;
        if (ratiosToExport.length === 0) {
          toast.error(t('editor.exportAspectRatioRequired'));
          return;
        }

        let exportDirectoryPath: string | null = null;
        if (ratiosToExport.length > 1) {
          const pickDirectoryResult = await window.electronAPI.pickExportDirectory(locale);
          if (pickDirectoryResult.cancelled || !pickDirectoryResult.path) {
            toast.info(t('editor.exportCancelled'));
            return;
          }
          exportDirectoryPath = pickDirectoryResult.path;
        }

        const timestamp = Date.now();
        let completedCount = 0;
        let aborted = false;

        for (let index = 0; index < ratiosToExport.length; index += 1) {
          const currentRatio = ratiosToExport[index];
          setActiveBatchExport({
            current: index + 1,
            total: ratiosToExport.length,
            aspectRatio: currentRatio,
          });

          const exportPlan = calculateMp4ExportPlan({
            quality,
            aspectRatio: getAspectRatioValue(currentRatio),
            sourceWidth,
            sourceHeight,
            sourceFrameRate,
          });
          const {
            width: exportWidth,
            height: exportHeight,
            bitrate,
            frameRate: exportFrameRate,
            limitedBySource,
          } = exportPlan;

          if (limitedBySource && quality !== 'source') {
            toast.info(t('editor.exportResolutionLimited', { width: exportWidth, height: exportHeight }));
          }

          const zoomRegionsForRatio = getZoomRegionsForAspect(zoomRegionsByAspect, currentRatio);
          const exporter = new VideoExporter({
            videoUrl: videoPath,
            width: exportWidth,
            height: exportHeight,
            frameRate: exportFrameRate,
            bitrate,
            codec: 'avc1.640033',
            wallpaper,
            zoomRegions: zoomRegionsForRatio,
            trimRegions,
            showShadow: shadowIntensity > 0,
            shadowIntensity,
            showBlur,
            motionBlurEnabled,
            borderRadius,
            padding,
            cropRegion: resolveAspectCropRegion(cropRegionsByAspect, currentRatio, sourceAspectRatio),
            annotationRegions,
            subtitleCues,
            previewWidth,
            previewHeight,
            cursorTrack,
            cursorStyle,
            audioEditRegions,
            audioEnabled: sourceHasAudio && audioEnabled,
            audioGain,
            audioProcessing: {
              normalizeLoudness: audioNormalizeLoudness,
              targetLufs: audioTargetLufs,
              limiterDb: audioLimiterDb,
            },
            segments,
            onProgress: (progress: ExportProgress) => {
              setExportProgress(progress);
            },
          });

          exporterRef.current = exporter;
          const result = await exporter.export();
          const cancelled = exportCancelledRef.current
            || (typeof result.error === 'string' && result.error.toLowerCase().includes('cancel'));

          if (cancelled) {
            toast.info(t('editor.exportCancelled'));
            aborted = true;
            break;
          }

          if (!(result.success && result.blob)) {
            setExportError(result.error || t('editor.exportFailed'));
            toast.error(result.error || t('editor.exportFailed'));
            aborted = true;
            break;
          }

          notifyExportWarnings(result.warnings);

          const arrayBuffer = await result.blob.arrayBuffer();
          const ratioSuffix = ratiosToExport.length > 1 ? `-${currentRatio.replace(':', 'x')}` : '';
          const fileName = `export-${timestamp}${ratioSuffix}.mp4`;

          const saveResult = await window.electronAPI.saveExportedVideo(
            arrayBuffer,
            fileName,
            locale,
            exportDirectoryPath ? { directoryPath: exportDirectoryPath } : undefined,
          );

          if (saveResult.cancelled) {
            toast.info(t('editor.exportCancelled'));
            aborted = true;
            break;
          } else if (saveResult.success) {
            completedCount += 1;
            if (ratiosToExport.length === 1) {
              toast.success(t('editor.videoExportSuccess', { path: saveResult.path ?? '' }));
            }
          } else {
            setExportError(saveResult.message || t('editor.saveVideoFailed'));
            toast.error(saveResult.message || t('editor.saveVideoFailed'));
            aborted = true;
            break;
          }
        }

        if (!aborted && completedCount > 1 && exportDirectoryPath) {
          toast.success(t('editor.batchVideoExportSuccess', { count: completedCount, path: exportDirectoryPath }));
        }
      }
    } catch (error) {
      console.error('Export error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setExportError(errorMessage);
      toast.error(t('editor.exportError', { message: errorMessage }));
    } finally {
      if (shouldResumePlayback) {
        videoPlaybackRef.current?.play();
      }
      setIsExporting(false);
      exporterRef.current = null;
      exportCancelledRef.current = false;
      setActiveBatchExport(null);
    }
  }, [videoPath, wallpaper, zoomRegions, zoomRegionsByAspect, trimRegions, shadowIntensity, showBlur, motionBlurEnabled, borderRadius, padding, activeCropRegion, cropRegionsByAspect, sourceAspectRatio, annotationRegions, subtitleCues, isPlaying, normalizedExportAspectRatios, exportQuality, locale, sourceFrameRate, sourceHasAudio, audioEnabled, audioGain, audioNormalizeLoudness, audioTargetLufs, audioLimiterDb, audioEditRegions, cursorTrack, cursorStyle, t]);

  const handleOpenExportDialog = useCallback(() => {
    if (!videoPath) {
      toast.error(t('editor.noVideoLoaded'));
      return;
    }

    const video = videoPlaybackRef.current?.video;
    if (!video) {
      toast.error(t('editor.videoNotReady'));
      return;
    }
    if (exportFormat === 'mp4' && normalizedExportAspectRatios.length === 0) {
      toast.error(t('editor.exportAspectRatioRequired'));
      return;
    }

    // Build export settings from current state
    const sourceWidth = video.videoWidth || 1920;
    const sourceHeight = video.videoHeight || 1080;
    const gifDimensions = calculateOutputDimensions(sourceWidth, sourceHeight, gifSizePreset, GIF_SIZE_PRESETS);

    const settings: ExportSettings = {
      format: exportFormat,
      quality: exportFormat === 'mp4' ? exportQuality : undefined,
      gifConfig: exportFormat === 'gif' ? {
        frameRate: gifFrameRate,
        loop: gifLoop,
        sizePreset: gifSizePreset,
        width: gifDimensions.width,
        height: gifDimensions.height,
      } : undefined,
    };

    setShowExportDialog(true);
    setExportError(null);

    // Start export immediately
    handleExport(settings);
  }, [videoPath, exportFormat, exportQuality, gifFrameRate, gifLoop, gifSizePreset, handleExport, normalizedExportAspectRatios.length, t]);

  // Fullscreen preview mode
  const toggleFullscreen = useCallback(() => {
    if (!previewContainerRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      previewContainerRef.current.requestFullscreen();
    }
  }, []);

  useEffect(() => {
    const handleChange = () => {
      const fs = !!document.fullscreenElement;
      setIsFullscreen(fs);
      if (fs) {
        setFullscreenControlsVisible(true);
      }
    };
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  // Auto-hide controls in fullscreen after 3s of inactivity
  const resetFullscreenHideTimer = useCallback(() => {
    if (!isFullscreen) return;
    setFullscreenControlsVisible(true);
    if (fullscreenHideTimerRef.current) {
      clearTimeout(fullscreenHideTimerRef.current);
    }
    fullscreenHideTimerRef.current = setTimeout(() => {
      setFullscreenControlsVisible(false);
    }, 3000);
  }, [isFullscreen]);

  useEffect(() => {
    if (!isFullscreen) {
      if (fullscreenHideTimerRef.current) {
        clearTimeout(fullscreenHideTimerRef.current);
        fullscreenHideTimerRef.current = null;
      }
      setFullscreenControlsVisible(true);
      return;
    }
    resetFullscreenHideTimer();
    return () => {
      if (fullscreenHideTimerRef.current) {
        clearTimeout(fullscreenHideTimerRef.current);
      }
    };
  }, [isFullscreen, resetFullscreenHideTimer]);

  const handleCancelExport = useCallback(() => {
    if (exporterRef.current) {
      exportCancelledRef.current = true;
      exporterRef.current.cancel();
      toast.info(t('editor.exportCancelled'));
      setShowExportDialog(false);
      setExportProgress(null);
      setExportError(null);
    }
  }, [t]);

  // Auto-clear export progress float after export is done and dialog is closed
  useEffect(() => {
    if (isExporting || showExportDialog) return;
    if (!exportProgress && !exportError) return;
    const timer = setTimeout(() => {
      setExportProgress(null);
      setExportError(null);
    }, 4000);
    return () => clearTimeout(timer);
  }, [isExporting, showExportDialog, exportProgress, exportError]);

  const handleCloseEditor = useCallback(() => {
    // Immediate save before switching (bypass debounce)
    if (videoFilePath) {
      const state: ProjectState = {
        version: 1,
        savedAt: Date.now(),
        videoFilePath,
        segments,
        zoomRegionsByAspect: zoomRegionsByAspect as Record<string, ZoomRegion[]>,
        annotationRegions,
        audioEditRegions,
        cropRegionsByAspect: cropRegionsByAspect as Record<string, CropRegion>,
        aspectRatio,
        wallpaper,
        shadowIntensity,
        showBlur,
        motionBlurEnabled,
        borderRadius,
        padding,
        audioEnabled,
        audioGain,
        audioNormalizeLoudness,
        audioTargetLufs,
        audioLimiterDb,
        exportQuality,
        exportFormat,
        seekStepSeconds,
        previewPlaybackRate,
        playheadPosition: currentTimeRef.current,
        cursorStyle,
        subtitleCues: subtitleCues as ProjectState['subtitleCues'],
        gifFrameRate,
        gifLoop,
        gifSizePreset,
        exportAspectRatios,
        timelineZoomVisibleMs: timelineZoomInfo?.visibleMs,
      };
      window.electronAPI.saveProjectState(videoFilePath, state).catch(() => {});
    }
    window.electronAPI.switchToLaunch();
  }, [
    videoFilePath, segments, zoomRegionsByAspect, annotationRegions,
    audioEditRegions, cropRegionsByAspect, aspectRatio, wallpaper,
    shadowIntensity, showBlur, motionBlurEnabled, borderRadius, padding,
    audioEnabled, audioGain, audioNormalizeLoudness, audioTargetLufs,
    audioLimiterDb, exportQuality, exportFormat, seekStepSeconds,
    previewPlaybackRate, cursorStyle, subtitleCues, gifFrameRate,
    gifLoop, gifSizePreset, exportAspectRatios, timelineZoomInfo,
  ]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-foreground">{t("editor.loadingVideo")}</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-destructive">{error}</div>
      </div>
    );
  }


  return (
    <div className="flex flex-col h-screen bg-[#09090b] text-slate-200 overflow-hidden selection:bg-[#34B27B]/30">
      <div
        className="h-10 flex-shrink-0 bg-[#09090b]/80 backdrop-blur-md border-b border-white/5 flex items-center justify-between px-6 z-50"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <button
          onClick={handleCloseEditor}
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-slate-400 hover:text-slate-200 hover:bg-white/5 rounded transition-colors"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          title={t("editor.closeEditor")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5" /><path d="m12 19-7-7 7-7" />
          </svg>
          {t("editor.closeEditor")}
        </button>
        <div className="flex-1" />
      </div>

      <div className="flex-1 p-5 gap-4 flex min-h-0 relative">
        {/* Left Column - Video & Timeline */}
        <div className="flex-[7] flex flex-col gap-3 min-w-0 h-full">
          <PanelGroup direction="vertical" className="gap-3">
            {/* Top section: video preview and controls */}
            <Panel defaultSize={70} minSize={40}>
              <div
                ref={previewContainerRef}
                className={cn(
                  "w-full h-full flex flex-col items-center justify-center rounded-2xl border border-white/5 shadow-2xl overflow-hidden",
                  isFullscreen ? "bg-black" : "bg-black/40"
                )}
                onMouseMove={isFullscreen ? resetFullscreenHideTimer : undefined}
                style={isFullscreen && !fullscreenControlsVisible ? { cursor: 'none' } : undefined}
              >
                {/* Video preview */}
                <div className="w-full flex justify-center items-center" style={{ flex: '1 1 auto', margin: '6px 0 0' }}>
                  <div className="relative" style={{ width: 'auto', height: '100%', aspectRatio: getAspectRatioValue(aspectRatio), maxWidth: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
                    <VideoPlayback
                      aspectRatio={aspectRatio}
                      preferredFps={resolvePreviewFrameRate(sourceFrameRate)}
                      ref={videoPlaybackRef}
                      videoPath={videoPath || ''}
                      onDurationChange={setDuration}
                      onTimeUpdate={handleTimeUpdate}
                      currentTime={currentTime}
                      onPlayStateChange={setIsPlaying}
                      onError={setError}
                      wallpaper={wallpaper}
                      zoomRegions={zoomRegions}
                      selectedZoomId={selectedZoomId}
                      onSelectZoom={handleSelectZoom}
                      onZoomFocusChange={handleZoomFocusChange}
                      isPlaying={isPlaying}
                      showShadow={shadowIntensity > 0}
                      shadowIntensity={shadowIntensity}
                      showBlur={showBlur}
                      motionBlurEnabled={motionBlurEnabled}
                      borderRadius={borderRadius}
                      padding={padding}
                      cropRegion={DEFAULT_CROP_REGION}
                      trimRegions={trimRegions}
                      annotationRegions={annotationRegions}
                      selectedAnnotationId={selectedAnnotationId}
                      onSelectAnnotation={handleSelectAnnotation}
                      onAnnotationPositionChange={handleAnnotationPositionChange}
                      onAnnotationSizeChange={handleAnnotationSizeChange}
                      subtitleCues={subtitleCues}
                      cursorTrack={cursorTrack}
                      cursorStyle={cursorStyle}
                      hasAudioTrack={sourceHasAudio}
                      audioEnabled={audioEnabled}
                      audioGain={audioGain}
                      audioLimiterDb={audioLimiterDb}
                      audioEditRegions={audioEditRegions}
                      onVideoDimensionsChange={setSourceVideoDimensions}
                      segmentsRef={segmentsRef}
                      previewPlaybackRateRef={previewPlaybackRateRef}
                    />
                    {showAspectCropOverlay ? (
                      <PreviewAspectCropOverlay
                        cropRegion={activeCropRegion}
                        onCropChange={handleActiveCropRegionChange}
                        sourceAspectRatio={sourceAspectRatio}
                        targetAspectRatio={getAspectRatioValue(aspectRatio)}
                        positionHint={t("editor.cropOverlayDragHint")}
                      />
                    ) : null}
                  </div>
                </div>
                {/* Playback controls */}
                <div
                  className={cn(
                    "w-full flex justify-center items-center transition-opacity duration-300",
                    isFullscreen
                      ? "absolute bottom-0 left-0 right-0 z-50 pb-4 px-6"
                      : "",
                    isFullscreen && !fullscreenControlsVisible
                      ? "opacity-0 pointer-events-none"
                      : "opacity-100"
                  )}
                  style={isFullscreen ? undefined : { height: '48px', flexShrink: 0, padding: '6px 12px', margin: '6px 0 6px 0' }}
                >
                  <div style={{ width: '100%', maxWidth: '700px' }}>
                    <PlaybackControls
                      isPlaying={isPlaying}
                      currentTime={effectiveCurrentTime}
                      duration={effectiveDuration}
                      onTogglePlayPause={togglePlayPause}
                      onSeek={handleSeek}
                      playbackSpeed={currentSegmentSpeed}
                      previewPlaybackRate={previewPlaybackRate}
                      onPreviewPlaybackRateChange={setPreviewPlaybackRate}
                      timelineZoomInfo={timelineZoomInfo}
                      onTimelineZoomChange={(visibleMs) => timelineZoomSetRef.current?.(visibleMs)}
                      isFullscreen={isFullscreen}
                      onToggleFullscreen={toggleFullscreen}
                    />
                  </div>
                </div>
              </div>
            </Panel>

            <PanelResizeHandle className="h-3 bg-[#09090b]/80 hover:bg-[#09090b] transition-colors rounded-full mx-4 flex items-center justify-center">
              <div className="w-8 h-1 bg-white/20 rounded-full"></div>
            </PanelResizeHandle>

            {/* Timeline section */}
            <Panel defaultSize={30} minSize={20}>
              <div className="h-full bg-[#09090b] rounded-2xl border border-white/5 shadow-lg overflow-hidden flex flex-col">
                <TimelineEditor
              videoDuration={effectiveDuration}
              currentTime={effectiveCurrentTime}
              onSeek={handleSeek}
              zoomRegions={effectiveZoomRegions}
              onZoomAdded={handleZoomAdded}
              onZoomSpanChange={handleZoomSpanChange}
              onZoomDelete={handleZoomDelete}
              selectedZoomId={selectedZoomId}
              onSelectZoom={handleSelectZoom}
              segments={segments}
              onSplitAtTime={handleSplitAtTime}
              onDeleteSegment={handleDeleteSegment}
              selectedSegmentId={selectedSegmentId}
              onSelectSegment={handleSelectSegment}
              annotationRegions={effectiveAnnotationRegions}
              onAnnotationAdded={handleAnnotationAdded}
              onAnnotationSpanChange={handleAnnotationSpanChange}
              onAnnotationDelete={handleAnnotationDelete}
              selectedAnnotationId={selectedAnnotationId}
              onSelectAnnotation={handleSelectAnnotation}
              subtitleCues={effectiveSubtitleCues}
              aspectRatio={aspectRatio}
              onAspectRatioChange={setAspectRatio}
              hasAudioTrack={sourceHasAudio}
              audioEnabled={audioEnabled}
              audioGain={audioGain}
              audioEditRegions={effectiveAudioEditRegions}
              onHoverPreview={handleHoverPreview}
              onHoverCommit={commitHoverPreview}
              isPlaying={isPlaying}
              onVisibleRangeChange={setTimelineZoomInfo}
              zoomStepRef={timelineZoomStepRef}
              zoomSetRef={timelineZoomSetRef}
            />
              </div>
            </Panel>
          </PanelGroup>
        </div>

          {/* Right section: settings panel */}
          <SettingsPanel
          selected={wallpaper}
          onWallpaperChange={setWallpaper}
          selectedZoomDepth={selectedZoomId ? zoomRegions.find(z => z.id === selectedZoomId)?.depth : null}
          onZoomDepthChange={(depth) => selectedZoomId && handleZoomDepthChange(depth)}
          selectedZoomId={selectedZoomId}
          onZoomDelete={handleZoomDelete}
          selectedSegment={segments.find((s) => s.id === selectedSegmentId) ?? null}
          onDeleteSegment={handleDeleteSegment}
          onSegmentSpeedChange={handleSegmentSpeedChange}
          shadowIntensity={shadowIntensity}
          onShadowChange={setShadowIntensity}
          showBlur={showBlur}
          onBlurChange={setShowBlur}
          motionBlurEnabled={motionBlurEnabled}
          onMotionBlurChange={setMotionBlurEnabled}
          borderRadius={borderRadius}
          onBorderRadiusChange={setBorderRadius}
          padding={padding}
          onPaddingChange={setPadding}
          cropRegion={activeCropRegion}
          onCropChange={handleActiveCropRegionChange}
          aspectRatio={aspectRatio}
          videoElement={videoPlaybackRef.current?.video || null}
          exportQuality={exportQuality}
          onExportQualityChange={setExportQuality}
          exportFormat={exportFormat}
          onExportFormatChange={setExportFormat}
          exportAspectRatios={exportAspectRatios}
          onExportAspectRatiosChange={setExportAspectRatios}
          onPreviewAspectRatioChange={setAspectRatio}
          gifFrameRate={gifFrameRate}
          onGifFrameRateChange={setGifFrameRate}
          gifLoop={gifLoop}
          onGifLoopChange={setGifLoop}
          gifSizePreset={gifSizePreset}
          onGifSizePresetChange={setGifSizePreset}
          gifOutputDimensions={calculateOutputDimensions(
            videoPlaybackRef.current?.video?.videoWidth || 1920,
            videoPlaybackRef.current?.video?.videoHeight || 1080,
            gifSizePreset,
            GIF_SIZE_PRESETS
          )}
          onExport={handleOpenExportDialog}
          selectedAnnotationId={selectedAnnotationId}
          annotationRegions={annotationRegions}
          onAnnotationContentChange={handleAnnotationContentChange}
          onAnnotationTypeChange={handleAnnotationTypeChange}
          onAnnotationStyleChange={handleAnnotationStyleChange}
          onAnnotationFigureDataChange={handleAnnotationFigureDataChange}
          onAnnotationDelete={handleAnnotationDelete}
          hasAudioTrack={sourceHasAudio}
          audioEnabled={audioEnabled}
          onAudioEnabledChange={setAudioEnabled}
          audioGain={audioGain}
          onAudioGainChange={setAudioGain}
          audioNormalizeLoudness={audioNormalizeLoudness}
          onAudioNormalizeLoudnessChange={setAudioNormalizeLoudness}
          audioTargetLufs={audioTargetLufs}
          onAudioTargetLufsChange={setAudioTargetLufs}
          audioLimiterDb={audioLimiterDb}
          onAudioLimiterDbChange={setAudioLimiterDb}
          cursorStyle={cursorStyle}
          onCursorStyleChange={setCursorStyle}
          hasCursorTrack={Boolean(cursorTrack?.samples?.length)}
          onAutoEdit={handleAutoEdit}
          autoEditDisabled={!cursorTrack?.samples?.length || !Number.isFinite(duration) || duration <= 0}
          onAnalyzeCursor={handleAnalyzeCursor}
          cursorAnalysisProgress={cursorAnalysisProgress}
          onGenerateSubtitles={handleGenerateSubtitles}
          onApplyRoughCut={handleApplyRoughCut}
          analysisRunning={analysisInProgress}
          subtitleCueCount={subtitleCues.length}
          roughCutSuggestionCount={roughCutSuggestions.length}
          seekStepSeconds={seekStepSeconds}
          onSeekStepSecondsChange={setSeekStepSeconds}
        />
      </div>
      <ExportDialog
        isOpen={showExportDialog}
        onClose={() => setShowExportDialog(false)}
        progress={exportProgress}
        isExporting={isExporting}
        error={exportError}
        onCancel={handleCancelExport}
        exportFormat={exportFormat}
        batchProgress={activeBatchExport}
      />
      {(isExporting || exportProgress || exportError) && !showExportDialog && (
        <ExportProgressFloat
          progress={exportProgress}
          isExporting={isExporting}
          error={exportError}
          exportFormat={exportFormat}
          batchProgress={activeBatchExport}
          onClick={() => setShowExportDialog(true)}
        />
      )}
    </div>
  );
}
