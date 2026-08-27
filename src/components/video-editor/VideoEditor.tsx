

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { PanelRightClose, PanelRightOpen, PanelBottomClose, PanelBottomOpen } from "lucide-react";
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
  ZOOM_DEPTH_SCALES,
  clampFocusToDepth,
  getZoomFocusMode,
  DEFAULT_CROP_REGION,
  DEFAULT_FIGURE_DATA,
  createTextAnnotationRegion,
  resolveTextAnnotationContent,
  type ZoomDepth,
  type ZoomFocus,
  type ZoomFocusMode,
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
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_EDITOR_APPEARANCE_SETTINGS,
  DEFAULT_EDITOR_LAYOUT_SETTINGS,
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_GIF_SETTINGS,
  DEFAULT_PLAYBACK_SETTINGS,
  DEFAULT_TIMELINE_SETTINGS,
} from "./editorDefaults";
import { EditorMenuBar } from "./EditorMenuBar";
import { ANNOTATION_ID_PREFIX, maxIdNum } from "./idCounters";
import { findFreeGapAt } from "./regionPlacement";
import {
  buildPastedAnnotation,
  buildZoomRegion,
  extractAnnotationAttributes,
  extractSegmentSpeedAttributes,
  extractZoomAttributes,
  getCopiedRegion,
  replaceAnnotationAttributes,
  setCopiedRegion,
} from "./regionClipboard";
import { DUPLICATE_ANNOTATION_OFFSET_PERCENT, duplicateAnnotationRegion } from "@/lib/annotations/duplicate";
import { DEFAULT_WALLPAPER, normalizeWallpaperValue } from "@/lib/wallpaper";
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
  clearStaleSourceCache,
  buildExportDiagnosticMessage,
  buildSaveDiagnosticMessage,
  readExportDecodePathOverride,
  type ExportDiagnosticLabels,
} from "@/lib/exporter";
import { getExportFolder, loadUserPreferences, parentDirectoryOf, saveUserPreferences } from "@/lib/userPreferences";
import { ASPECT_RATIOS, type AspectRatio, getAspectRatioValue } from "@/utils/aspectRatioUtils";
import { useShortcuts } from "@/contexts/ShortcutsContext";
import { isArrowKeyOwningTarget, isTextEditingTarget, matchesShortcut } from "@/lib/shortcuts";
import { computeFrameStepTime, FRAME_DURATION_SEC } from "@/lib/frameStep";
import { GITHUB_ISSUES_URL } from "@/lib/supportLinks";
import { reportUserActionError } from "@/lib/userErrorFeedback";
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

interface UnsavedExport {
  arrayBuffer: ArrayBuffer;
  fileName: string;
  format: 'mp4' | 'gif';
}

/** Persist the folder of a just-saved export so the next save dialog opens there. */
function rememberExportFolder(savedPath: string): void {
  const folder = parentDirectoryOf(savedPath);
  if (folder) {
    saveUserPreferences({ exportFolder: folder });
  }
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
  // Canonical form ("/wallpapers/wallpaperN.jpg", "#hex", gradient or data:
  // URI); resolved to a loadable URL only at render/export time.
  const [wallpaper, setWallpaper] = useState<string>(DEFAULT_WALLPAPER);
  const [shadowIntensity, setShadowIntensity] = useState(DEFAULT_EDITOR_APPEARANCE_SETTINGS.shadowIntensity);
  const [showBlur, setShowBlur] = useState(DEFAULT_EDITOR_APPEARANCE_SETTINGS.showBlur);
  const [motionBlurEnabled, setMotionBlurEnabled] = useState(DEFAULT_EDITOR_APPEARANCE_SETTINGS.motionBlurEnabled);
  const [seekStepSeconds, setSeekStepSeconds] = useState(DEFAULT_PLAYBACK_SETTINGS.seekStepSeconds);
  const [previewPlaybackRate, setPreviewPlaybackRate] = useState(DEFAULT_PLAYBACK_SETTINGS.previewPlaybackRate);
  // View setting (not edit state): persisted with the project, never undone
  const [showTimelineWaveform, setShowTimelineWaveform] = useState(DEFAULT_TIMELINE_SETTINGS.showWaveform);
  const [timelineZoomInfo, setTimelineZoomInfo] = useState<{ visibleMs: number; totalMs: number; minVisibleMs: number } | null>(null);
  const timelineZoomStepRef = useRef<((direction: 1 | -1) => void) | null>(null);
  const timelineZoomSetRef = useRef<((visibleMs: number) => void) | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenControlsVisible, setFullscreenControlsVisible] = useState(true);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const timelinePanelRef = useRef<ImperativePanelHandle>(null);
  const fullscreenHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [borderRadius, setBorderRadius] = useState(DEFAULT_EDITOR_APPEARANCE_SETTINGS.borderRadius);
  const [padding, setPadding] = useState(DEFAULT_EDITOR_LAYOUT_SETTINGS.padding);
  const [sourceVideoDimensions, setSourceVideoDimensions] = useState<{ width: number; height: number } | null>(null);
  const [cropRegionsByAspect, setCropRegionsByAspect] = useState<Partial<Record<AspectRatio, CropRegion>>>({
    '16:9': DEFAULT_CROP_REGION,
  });
  const [zoomRegionsByAspect, setZoomRegionsByAspect] = useState<ZoomRegionsByAspect>({});
  const [selectedZoomIdByAspect, setSelectedZoomIdByAspect] = useState<SelectedZoomIdByAspect>({});
  const [isPreviewingZoom, setIsPreviewingZoom] = useState(false);
  // Auto-zoom wand: ON keeps/suggests `source: 'auto'` regions, OFF removes them.
  const [autoZoomEnabled, setAutoZoomEnabled] = useState(true);
  // Auto-Focus all: every zoom follows the cursor (focusMode 'auto') and the
  // per-zoom Focus Mode control is locked. Off by default (Capturia keeps the
  // static focus of suggested regions unless asked otherwise).
  const [autoFocusAll, setAutoFocusAll] = useState(false);
  const [audioEditRegions, setAudioEditRegions] = useState<AudioEditRegion[]>([]);
  const [annotationRegions, setAnnotationRegions] = useState<AnnotationRegion[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportDialogAnim, setExportDialogAnim] = useState<'idle' | 'minimizing' | 'maximizing'>('idle');
  const [exportedFilePath, setExportedFilePath] = useState<string | undefined>(undefined);
  // Finished export blob whose write failed; kept so the user can pick another location.
  const [unsavedExport, setUnsavedExport] = useState<UnsavedExport | null>(null);
  const unsavedExportRef = useRef<UnsavedExport | null>(null);
  const [settingsPanelVisible, setSettingsPanelVisible] = useState(true);
  const [timelinePanelVisible, setTimelinePanelVisible] = useState(true);

  // Real source duration (ms) found by VideoPlayback's WebM probe, keyed by the
  // source it was measured for so a stale probe never applies to a new video.
  const [probedSourceDuration, setProbedSourceDuration] = useState<{ videoPath: string; ms: number } | null>(null);
  const probedSourceDurationMs = probedSourceDuration?.videoPath === videoPath ? probedSourceDuration.ms : undefined;
  const handleSourceDurationProbed = useCallback((durationSec: number) => {
    if (videoPath && Number.isFinite(durationSec) && durationSec > 0) {
      setProbedSourceDuration({ videoPath, ms: durationSec * 1000 });
    }
  }, [videoPath]);

  // Reclaim OPFS source copies left behind by a previous session (localSourceFile.ts).
  useEffect(() => {
    void clearStaleSourceCache().catch((error) => {
      console.warn('[VideoEditor] Failed to prune stale source cache:', error);
    });
  }, []);

  // Sync timeline panel visibility with imperative panel collapse/expand
  useEffect(() => {
    const panel = timelinePanelRef.current;
    if (!panel) return;
    if (timelinePanelVisible) {
      if (panel.isCollapsed()) panel.expand();
    } else {
      if (!panel.isCollapsed()) panel.collapse();
    }
  }, [timelinePanelVisible]);

  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(DEFAULT_EDITOR_LAYOUT_SETTINGS.aspectRatio);
  const [exportAspectRatios, setExportAspectRatios] = useState<AspectRatio[]>([DEFAULT_EDITOR_LAYOUT_SETTINGS.aspectRatio]);
  const [activeBatchExport, setActiveBatchExport] = useState<{
    current: number;
    total: number;
    aspectRatio: AspectRatio;
  } | null>(null);
  const [exportQuality, setExportQuality] = useState<ExportQuality>(DEFAULT_EXPORT_SETTINGS.quality);
  const [exportFormat, setExportFormat] = useState<ExportFormat>(DEFAULT_EXPORT_SETTINGS.format);
  const [gifFrameRate, setGifFrameRate] = useState<GifFrameRate>(DEFAULT_GIF_SETTINGS.frameRate);
  const [gifLoop, setGifLoop] = useState(DEFAULT_GIF_SETTINGS.loop);
  const [gifSizePreset, setGifSizePreset] = useState<GifSizePreset>(DEFAULT_GIF_SETTINGS.sizePreset);
  const [sourceFrameRate, setSourceFrameRate] = useState<number | undefined>(undefined);
  const [sourceHasAudio, setSourceHasAudio] = useState(true);
  const [audioEnabled, setAudioEnabled] = useState(DEFAULT_AUDIO_SETTINGS.enabled);
  const [audioGain, setAudioGain] = useState(DEFAULT_AUDIO_SETTINGS.gain);
  const [audioNormalizeLoudness, setAudioNormalizeLoudness] = useState(DEFAULT_AUDIO_SETTINGS.normalizeLoudness);
  const [audioTargetLufs, setAudioTargetLufs] = useState(DEFAULT_AUDIO_SETTINGS.targetLufs);
  const [audioLimiterDb, setAudioLimiterDb] = useState(DEFAULT_AUDIO_SETTINGS.limiterDb);
  // Cross-session preferences (P5): applied to NEW projects only, saved back on change.
  const [prefsHydrated, setPrefsHydrated] = useState(false);
  // Mirrors the undo/redo stacks so the menu can enable/disable its items (P9a).
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const [cursorTrack, setCursorTrack] = useState<CursorTrack | null>(null);
  const [cursorStyle, setCursorStyle] = useState<CursorStyleConfig>(DEFAULT_CURSOR_STYLE);
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [roughCutSuggestions, setRoughCutSuggestions] = useState<RoughCutSuggestion[]>([]);
  const [analysisJobId, setAnalysisJobId] = useState<string | null>(null);
  const [analysisInProgress, setAnalysisInProgress] = useState(false);
  const analysisPollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [cursorAnalysisProgress, setCursorAnalysisProgress] = useState<number | null>(null);
  const cursorAnalyzerRef = useRef<VideoMouseAnalyzer | null>(null);

  const { shortcuts: keyShortcuts, isMac: isMacPlatform, openConfig: openShortcutsConfig } = useShortcuts();
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
  const selectedZoomRegion = useMemo(
    () => (selectedZoomId ? zoomRegions.find((region) => region.id === selectedZoomId) ?? null : null),
    [zoomRegions, selectedZoomId],
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
                    const key = `${r.id}|${r.startMs}|${r.endMs}|${r.depth}|${r.customScale ?? ''}|${r.focus?.cx}|${r.focus?.cy}|${r.focusMode ?? ''}`;
                    if (contentKeys.has(key)) return false;
                    contentKeys.add(key);
                    return true;
                  });
                  // Re-ID any remaining ID collisions; drop unknown focusMode
                  // values (older / hand-edited saves) so they read as manual.
                  let maxZ = maxIdNum(deduped, 'zoom-');
                  const seenIds = new Set<string>();
                  const fixed = deduped.map(r => {
                    const focusMode: ZoomFocusMode | undefined =
                      r.focusMode === 'auto' || r.focusMode === 'manual' ? r.focusMode : undefined;
                    const normalized = focusMode === r.focusMode ? r : { ...r, focusMode };
                    if (seenIds.has(normalized.id)) {
                      return { ...normalized, id: `zoom-${++maxZ}` };
                    }
                    seenIds.add(normalized.id);
                    return normalized;
                  });
                  fixedByAspect[aspect] = fixed;
                  globalMaxZoom = Math.max(globalMaxZoom, maxZ);
                }
                setZoomRegionsByAspect(fixedByAspect);
                nextZoomIdRef.current = globalMaxZoom + 1;
              }
              // Auto-zoom wand (v1.2): older saves have no flag and keep the default (on).
              if (typeof s.autoZoomEnabled === 'boolean') setAutoZoomEnabled(s.autoZoomEnabled);
              // Auto-Focus all (W3-f): older saves have no flag and keep the default (off).
              if (typeof s.autoFocusAll === 'boolean') setAutoFocusAll(s.autoFocusAll);

              // Restore annotation regions and sync counters
              if (Array.isArray(s.annotationRegions)) {
                setAnnotationRegions(s.annotationRegions);
                const maxAnno = maxIdNum(s.annotationRegions, ANNOTATION_ID_PREFIX);
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
              // Older saves stored the resolved file:// URL; normalise to canonical.
              if (typeof s.wallpaper === 'string') setWallpaper(normalizeWallpaperValue(s.wallpaper));
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
              // Restore timeline waveform toggle (W2-b); older projects keep the default
              if (typeof s.showTimelineWaveform === 'boolean') setShowTimelineWaveform(s.showTimelineWaveform);
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
            } else {
              // New project (no sidecar yet): seed the editor from the
              // cross-session preferences. A restored project always wins.
              const prefs = loadUserPreferences();
              setPadding(prefs.padding);
              setAspectRatio(prefs.aspectRatio);
              setExportAspectRatios([prefs.aspectRatio]);
              setExportQuality(prefs.exportQuality);
              setExportFormat(prefs.exportFormat);
              setSeekStepSeconds(prefs.seekStepSeconds);
              setPreviewPlaybackRate(prefs.previewPlaybackRate);
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
        setPrefsHydrated(true);
      }
    }
    loadVideo();
  }, [t]);

  // Remember the user's last choices so the next new project starts from them.
  useEffect(() => {
    if (!prefsHydrated) return;
    saveUserPreferences({ padding, aspectRatio, exportQuality, exportFormat, seekStepSeconds, previewPlaybackRate });
  }, [prefsHydrated, padding, aspectRatio, exportQuality, exportFormat, seekStepSeconds, previewPlaybackRate]);

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
        showTimelineWaveform,
        autoZoomEnabled,
        autoFocusAll,
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
    showTimelineWaveform, autoZoomEnabled, autoFocusAll,
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
  // History batching: while a batch is active only the first change pushes an
  // undo entry, so a slider drag or a typed number commits as ONE entry.
  // `endHistoryBatch` deactivates on a macrotask so the passive effect of the
  // final change (flushed synchronously after the discrete event) is still
  // inside the batch.
  const historyBatchRef = useRef<{ active: boolean; pushed: boolean }>({ active: false, pushed: false });
  const historyBatchEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beginHistoryBatch = useCallback(() => {
    if (historyBatchEndTimerRef.current) {
      clearTimeout(historyBatchEndTimerRef.current);
      historyBatchEndTimerRef.current = null;
    }
    if (!historyBatchRef.current.active) {
      historyBatchRef.current = { active: true, pushed: false };
    }
  }, []);
  const endHistoryBatch = useCallback(() => {
    if (historyBatchEndTimerRef.current) clearTimeout(historyBatchEndTimerRef.current);
    historyBatchEndTimerRef.current = setTimeout(() => {
      historyBatchEndTimerRef.current = null;
      historyBatchRef.current = { active: false, pushed: false };
    }, 0);
  }, []);
  const syncHistoryState = useCallback(() => {
    const next = { canUndo: undoStackRef.current.length > 0, canRedo: redoStackRef.current.length > 0 };
    setHistoryState((prev) => (prev.canUndo === next.canUndo && prev.canRedo === next.canRedo ? prev : next));
  }, []);

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

    // Push previous state to undo stack (once per history batch)
    const batch = historyBatchRef.current;
    if (prevEditableRef.current && !(batch.active && batch.pushed)) {
      undoStackRef.current.push(prevEditableRef.current);
      if (undoStackRef.current.length > MAX_UNDO_HISTORY) undoStackRef.current.shift();
      redoStackRef.current = []; // New user action clears redo
      if (batch.active) batch.pushed = true;
      syncHistoryState();
    }
    prevEditableRef.current = current;
  }, [segments, zoomRegionsByAspect, annotationRegions, audioEditRegions, syncHistoryState]);

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
    syncHistoryState();
  }, [segments, zoomRegionsByAspect, annotationRegions, audioEditRegions, syncHistoryState]);

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
    syncHistoryState();
  }, [segments, zoomRegionsByAspect, annotationRegions, audioEditRegions, syncHistoryState]);

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
  const sourceFrameRateRef = useRef(sourceFrameRate);
  sourceFrameRateRef.current = sourceFrameRate;
  const durationRef = useRef(duration);
  durationRef.current = duration;
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
    if (id) {
      setSelectedSegmentId(null);
      setSelectedAnnotationId(null);
    }
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
      source: 'manual',
      // Auto-Focus all on means new zooms follow the cursor too.
      ...(autoFocusAll ? { focusMode: 'auto' as const } : {}),
    };
    setZoomRegionsForActiveAspect((prev) => [...prev, newRegion]);
    setSelectedZoomIdForActiveAspect(id);
    setSelectedSegmentId(null);
    setSelectedAnnotationId(null);
  }, [autoFocusAll, setSelectedZoomIdForActiveAspect, setZoomRegionsForActiveAspect]);

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
              source: 'manual',
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
              source: 'manual',
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
              // Presets also set customScale so the slider and the preset agree
              // (getZoomScale prefers customScale).
              customScale: ZOOM_DEPTH_SCALES[depth],
              focus: clampFocusToDepth(region.focus, depth),
              source: 'manual',
            }
          : region,
      ),
    );
  }, [selectedZoomId, setZoomRegionsForActiveAspect]);

  // Precision X/Y inputs: every keystroke updates the focus live, the whole
  // typing session is one history entry (committed on blur / Enter).
  const handleZoomFocusCoordinateChange = useCallback((focus: ZoomFocus) => {
    if (!selectedZoomId) return;
    beginHistoryBatch();
    handleZoomFocusChange(selectedZoomId, focus);
  }, [beginHistoryBatch, handleZoomFocusChange, selectedZoomId]);

  // Slider drags call this per pixel; the drag is one history entry (see
  // beginHistoryBatch / onZoomCustomScaleCommit).
  const handleZoomCustomScaleChange = useCallback((scale: number) => {
    if (!selectedZoomId) return;
    const rounded = Math.round(scale * 100) / 100;
    if (!Number.isFinite(rounded)) return;
    beginHistoryBatch();
    setZoomRegionsForActiveAspect((prev) =>
      prev.map((region) =>
        region.id === selectedZoomId
          ? { ...region, customScale: rounded, source: 'manual' }
          : region,
      ),
    );
  }, [beginHistoryBatch, selectedZoomId, setZoomRegionsForActiveAspect]);

  // Per-zoom Focus Mode (manual / auto). One region update = one undo entry.
  const handleZoomFocusModeChange = useCallback((focusMode: ZoomFocusMode) => {
    if (!selectedZoomId) return;
    setZoomRegionsForActiveAspect((prev) =>
      prev.map((region) =>
        region.id === selectedZoomId && getZoomFocusMode(region) !== focusMode
          ? { ...region, focusMode, source: 'manual' }
          : region,
      ),
    );
  }, [selectedZoomId, setZoomRegionsForActiveAspect]);

  // Flip every zoom (all aspects) between auto (cursor-follow) and manual at
  // once. The flag is global, so the regions of every aspect follow it; one
  // zoom-regions update = one undo entry.
  const handleToggleAutoFocusAll = useCallback((enabled: boolean) => {
    setAutoFocusAll(enabled);
    const focusMode: ZoomFocusMode = enabled ? 'auto' : 'manual';
    setZoomRegionsByAspect((previous) => {
      let changed = false;
      const next: ZoomRegionsByAspect = {};
      const entries = Object.entries(previous) as Array<[keyof ZoomRegionsByAspect, ZoomRegion[] | undefined]>;
      for (const [aspect, regions] of entries) {
        if (!regions) continue;
        next[aspect] = regions.map((region) => {
          if (getZoomFocusMode(region) === focusMode) return region;
          changed = true;
          return { ...region, focusMode };
        });
      }
      return changed ? next : previous;
    });
  }, []);

  const handleZoomDelete = useCallback((id: string) => {
    setZoomRegionsForActiveAspect((prev) => prev.filter((region) => region.id !== id));
    if (selectedZoomId === id) {
      setSelectedZoomIdForActiveAspect(null);
    }
  }, [selectedZoomId, setSelectedZoomIdForActiveAspect, setZoomRegionsForActiveAspect]);

  // Builds fresh `source: 'auto'` regions from the cursor track, carved around
  // `existingRegions` so re-suggesting never overlaps what the user placed or
  // edited. Shared by the first-load pass and the wand toggle.
  const buildAutoZoomRegions = useCallback((existingRegions: ZoomRegion[]): ZoomRegion[] => {
    const durationMs = Math.round(duration * 1000);
    if (!Number.isFinite(durationMs) || durationMs < 200 || !cursorTrack?.samples?.length) {
      return [];
    }

    const drafts = generateAutoZoomDrafts(cursorTrack, {
      durationMs,
      maxRegions: 64,
      avoidSpans: existingRegions.map((region) => ({ startMs: region.startMs, endMs: region.endMs })),
    });

    // Drafts keep their static focus (click / selection centroid, dwell point)
    // by default. With Auto-Focus all on, movement drafts follow the cursor;
    // click / selection drafts stay on their centroid, which is the point of
    // that generator (deliberate deviation from upstream 1b5de03f).
    return drafts.map((draft) => ({
      id: `zoom-${nextZoomIdRef.current++}`,
      startMs: draft.startMs,
      endMs: draft.endMs,
      depth: draft.depth,
      focus: clampFocusToDepth(draft.focus, draft.depth),
      source: 'auto' as const,
      ...(autoFocusAll && draft.reason === 'movement' ? { focusMode: 'auto' as const } : {}),
    }));
  }, [autoFocusAll, cursorTrack, duration]);

  // Appends auto suggestions around the active aspect's existing regions in a
  // single state update (one undo entry).
  const applyAutoZoomEdits = useCallback((options?: { silent?: boolean }) => {
    const generatedZoomRegions = buildAutoZoomRegions(zoomRegions);

    if (generatedZoomRegions.length === 0) {
      if (!options?.silent) {
        toast.info(t("editor.autoEditUnavailable"));
      }
      return 0;
    }

    setZoomRegionsByAspect((previous) =>
      setZoomRegionsForAspect(
        previous,
        aspectRatio,
        [...getZoomRegionsForAspect(previous, aspectRatio), ...generatedZoomRegions],
      ),
    );
    setSelectedZoomIdForActiveAspect(generatedZoomRegions[0]?.id ?? null);
    setSelectedSegmentId(null);
    setSelectedAnnotationId(null);

    if (!options?.silent) {
      toast.success(t("editor.autoEditApplied", { count: generatedZoomRegions.length }));
    }

    return generatedZoomRegions.length;
  }, [aspectRatio, buildAutoZoomRegions, setSelectedZoomIdForActiveAspect, t, zoomRegions]);

  // Wand toggle. ON: re-suggest around the regions that are there (manual and
  // edited-to-manual survive). OFF: remove only untouched `source: 'auto'`
  // regions. Each direction is one zoom-regions update, so one undo entry.
  const handleToggleAutoZoom = useCallback((enabled: boolean) => {
    autoEditInitializedAspectsRef.current.add(aspectRatio);
    setAutoZoomEnabled(enabled);
    if (enabled) {
      applyAutoZoomEdits();
      return;
    }
    setZoomRegionsByAspect((previous) => {
      const current = getZoomRegionsForAspect(previous, aspectRatio);
      const kept = current.filter((region) => region.source !== 'auto');
      return kept.length === current.length
        ? previous
        : setZoomRegionsForAspect(previous, aspectRatio, kept);
    });
  }, [applyAutoZoomEdits, aspectRatio]);



  const handleAnnotationAdded = useCallback((span: Span) => {
    const segs = segmentsRef.current;
    const trims = normalizedTrimsRef.current;
    const startMs = segs.length > 0 ? effectiveToSourceMsWithSegments(span.start, segs)
      : trims.length > 0 ? effectiveToSourceMs(span.start, trims) : span.start;
    const endMs = segs.length > 0 ? effectiveToSourceMsWithSegments(span.end, segs)
      : trims.length > 0 ? effectiveToSourceMs(span.end, trims) : span.end;
    const id = `${ANNOTATION_ID_PREFIX}${nextAnnotationIdRef.current++}`;
    const zIndex = nextAnnotationZIndexRef.current++; // Assign z-index based on creation order
    const newRegion = createTextAnnotationRegion({
      id,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      zIndex,
    });
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

  const handleAnnotationDuplicate = useCallback((id: string) => {
    const source = annotationRegions.find((region) => region.id === id);
    if (!source) return;
    const duplicate = duplicateAnnotationRegion(source, {
      id: `${ANNOTATION_ID_PREFIX}${nextAnnotationIdRef.current++}`,
      zIndex: nextAnnotationZIndexRef.current++,
    });
    setAnnotationRegions((prev) => [...prev, duplicate]);
    setSelectedAnnotationId(duplicate.id);
    setSelectedZoomIdForActiveAspect(null);
    setSelectedSegmentId(null);
  }, [annotationRegions, setSelectedZoomIdForActiveAspect]);

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
          updatedRegion.content = resolveTextAnnotationContent(region.textContent);
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
  
  // Copy the selected region's attributes (zoom, segment speed or annotation)
  // into the session clipboard. Not undoable, not persisted.
  const handleCopySelected = useCallback(() => {
    const zoom = selectedZoomId ? zoomRegions.find((r) => r.id === selectedZoomId) : undefined;
    const segment = selectedSegmentId ? segments.find((s) => s.id === selectedSegmentId) : undefined;
    const annotation = selectedAnnotationId
      ? annotationRegions.find((r) => r.id === selectedAnnotationId)
      : undefined;
    const copied = zoom
      ? extractZoomAttributes(zoom)
      : segment
        ? extractSegmentSpeedAttributes(segment)
        : annotation
          ? extractAnnotationAttributes(annotation)
          : null;
    if (!copied) {
      toast.info(t('editor.regionClipboard.nothingToCopy'));
      return;
    }
    setCopiedRegion(copied);
    toast.success(
      t('editor.regionClipboard.copied', { region: t(`editor.regionClipboard.kinds.${copied.kind}`) }),
      { id: 'regionClipboard.copied' },
    );
  }, [selectedZoomId, zoomRegions, selectedSegmentId, segments, selectedAnnotationId, annotationRegions, t]);

  // Paste onto the selected region of the same kind (attributes only, timing kept),
  // otherwise create a new region at the playhead. Each paste is one setState call,
  // so the history effect records exactly one undo entry.
  const handlePaste = useCallback(() => {
    const copied = getCopiedRegion();
    if (!copied) {
      toast.info(t('editor.regionClipboard.nothingToPaste'));
      return;
    }
    const notifyPasted = () =>
      toast.success(
        t('editor.regionClipboard.pasted', { region: t(`editor.regionClipboard.kinds.${copied.kind}`) }),
        { id: 'regionClipboard.pasted' },
      );

    if (copied.kind === 'zoom' && selectedZoomId) {
      setZoomRegionsForActiveAspect((prev) =>
        prev.map((r) => (r.id === selectedZoomId ? buildZoomRegion(r, copied) : r)),
      );
      notifyPasted();
      return;
    }
    if (copied.kind === 'segmentSpeed') {
      // Segments always tile the timeline, so there is no "new segment" paste:
      // the speed goes onto the selected segment, else the one under the playhead.
      const sourceMs = currentTime * 1000;
      const targetId =
        selectedSegmentId ??
        segments.find((s) => !s.deleted && sourceMs >= s.startMs && sourceMs < s.endMs)?.id;
      if (!targetId) {
        toast.info(t('editor.regionClipboard.noSegmentTarget'));
        return;
      }
      handleSegmentSpeedChange(targetId, copied.speed);
      notifyPasted();
      return;
    }
    if (copied.kind === 'annotation' && selectedAnnotationId) {
      setAnnotationRegions((prev) =>
        prev.map((r) => (r.id === selectedAnnotationId ? replaceAnnotationAttributes(r, copied) : r)),
      );
      notifyPasted();
      return;
    }

    // Nothing matching selected: create a new region at the playhead. Placement is
    // computed in effective (timeline) time like the timeline's own add handlers,
    // then converted to source time for storage.
    const totalMs = Math.round(effectiveDuration * 1000);
    if (totalMs <= 0) return;
    const startPos = Math.max(0, Math.min(Math.round(effectiveCurrentTime * 1000), totalMs));
    const defaultDuration = Math.min(1000, totalMs);
    const segs = segmentsRef.current;
    const trims = normalizedTrimsRef.current;
    const toSourceMs = (effectiveMs: number) =>
      Math.round(
        segs.length > 0
          ? effectiveToSourceMsWithSegments(effectiveMs, segs)
          : trims.length > 0
            ? effectiveToSourceMs(effectiveMs, trims)
            : effectiveMs,
      );

    if (copied.kind === 'zoom') {
      const { ok, gapMs } = findFreeGapAt(effectiveZoomRegions, startPos, totalMs);
      if (!ok) {
        toast.error(t('timeline.cannotPlaceZoom'), { description: t('timeline.cannotPlaceZoomDesc') });
        return;
      }
      const id = `zoom-${nextZoomIdRef.current++}`;
      const region = buildZoomRegion(
        {
          id,
          startMs: toSourceMs(startPos),
          endMs: toSourceMs(startPos + Math.min(defaultDuration, gapMs)),
        },
        copied,
      );
      setZoomRegionsForActiveAspect((prev) => [...prev, region]);
      handleSelectZoom(id);
      notifyPasted();
      return;
    }

    // Annotation: overlaps are allowed. The clone is nudged like Duplicate so it
    // does not sit exactly on the original when both are on screen.
    const id = `${ANNOTATION_ID_PREFIX}${nextAnnotationIdRef.current++}`;
    const region = buildPastedAnnotation(
      {
        id,
        startMs: toSourceMs(startPos),
        endMs: toSourceMs(Math.min(startPos + defaultDuration, totalMs)),
        zIndex: nextAnnotationZIndexRef.current++,
      },
      copied,
      DUPLICATE_ANNOTATION_OFFSET_PERCENT,
    );
    setAnnotationRegions((prev) => [...prev, region]);
    handleSelectAnnotation(id);
    notifyPasted();
  }, [
    selectedZoomId,
    selectedSegmentId,
    selectedAnnotationId,
    segments,
    currentTime,
    effectiveDuration,
    effectiveCurrentTime,
    effectiveZoomRegions,
    setZoomRegionsForActiveAspect,
    handleSegmentSpeedChange,
    handleSelectZoom,
    handleSelectAnnotation,
    t,
  ]);

  // Refs for the keydown handler below (it has [] deps).
  const handleCopySelectedRef = useRef(handleCopySelected);
  handleCopySelectedRef.current = handleCopySelected;
  const handlePasteRef = useRef(handlePaste);
  handlePasteRef.current = handlePaste;
  const hasRegionSelectedRef = useRef(false);
  hasRegionSelectedRef.current = Boolean(selectedZoomId || selectedSegmentId || selectedAnnotationId);

  // Global Tab prevention
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Text fields keep their native key handling (typing, arrows, copy/paste).
      const editingText = isTextEditingTarget(e.target);

      if (e.key === 'Tab') {
        if (editingText) {
          return;
        }
        e.preventDefault();
      }

      // Copy/paste region attributes. Only intercepted when there is a region to
      // copy or something on the region clipboard; otherwise the browser handles
      // native copy/paste of any page selection.
      if (!editingText) {
        if (matchesShortcut(e, keyShortcutsRef.current.copySelected, isMacRef.current)) {
          if (hasRegionSelectedRef.current) {
            e.preventDefault();
            handleCopySelectedRef.current();
            return;
          }
        } else if (matchesShortcut(e, keyShortcutsRef.current.paste, isMacRef.current)) {
          if (getCopiedRegion()) {
            e.preventDefault();
            handlePasteRef.current();
            return;
          }
        }
      }

      if (matchesShortcut(e, keyShortcutsRef.current.playPause, isMacRef.current)) {
        if (editingText) {
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
        // Sliders, selects, tabs, menus... own the arrow keys; do not also seek.
        if (isArrowKeyOwningTarget(e.target)) {
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

      // Frame step: , / . move exactly one source frame at the source's real
      // frame rate. Reads the live video time so rapid presses accumulate
      // instead of racing the React state update.
      if ((e.key === ',' || e.key === '.') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isArrowKeyOwningTarget(e.target)) return;
        e.preventDefault();
        commitHoverPreview();
        const video = videoPlaybackRef.current?.video;
        if (!video) return;
        const fps = sourceFrameRateRef.current;
        const frameDurationSec = fps && Number.isFinite(fps) && fps > 0 ? 1 / fps : FRAME_DURATION_SEC;
        const videoDuration = Number.isFinite(video.duration) ? video.duration : durationRef.current;
        video.currentTime = computeFrameStepTime(
          video.currentTime,
          videoDuration,
          e.key === '.' ? 'forward' : 'backward',
          frameDurationSec,
        );
      }

      // Speed up/down
      const isSpeedUp = matchesShortcut(e, keyShortcutsRef.current.speedUp, isMacRef.current);
      const isSpeedDown = matchesShortcut(e, keyShortcutsRef.current.speedDown, isMacRef.current);
      if (isSpeedUp || isSpeedDown) {
        if (editingText) return;
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
        if (editingText) return;
        if (e.ctrlKey || e.metaKey) return; // don't hijack browser zoom
        e.preventDefault();
        timelineZoomStepRef.current?.(e.key === '=' ? 1 : -1);
      }

      // Inside a text field Ctrl/Cmd+Z is the browser's text undo, not the
      // timeline's (P9c). On macOS the Edit menu owns Cmd+Z and forwards it as
      // `menu-undo`, which applies the same rule (see electron/edit-menu.ts).
      if (editingText) return;

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
    if (!autoZoomEnabled) {
      autoEditInitializedAspectsRef.current.add(aspectRatio);
      return;
    }
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
  }, [applyAutoZoomEdits, aspectRatio, autoZoomEnabled, cursorTrack, duration, loading, zoomRegions.length]);

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
        description: message || t('common.error.unexpected'),
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

  const showExportSuccessToast = useCallback((filePath: string) => {
    toast.success(t('dialogs.export.exportedTo', { path: filePath }), {
      action: {
        label: t('dialogs.export.showInFolder'),
        onClick: async () => {
          try {
            const result = await window.electronAPI.revealInFolder(filePath);
            if (!result.success) {
              toast.error(result.error || result.message || t('dialogs.export.revealFailed'));
            }
          } catch (err) {
            toast.error(String(err));
          }
        },
      },
    });
  }, [t]);

  const diagnosticLabels = useMemo<ExportDiagnosticLabels>(() => ({
    exportFailed: t('dialogs.export.diag.exportFailed'),
    saveFailed: t('dialogs.export.diag.saveFailed'),
    reason: t('dialogs.export.diag.reason'),
    source: t('dialogs.export.diag.source'),
    output: t('dialogs.export.diag.output'),
    codec: t('dialogs.export.diag.codec'),
    bitrate: t('dialogs.export.diag.bitrate'),
    videoEncoder: t('dialogs.export.diag.videoEncoder'),
    available: t('dialogs.export.diag.available'),
    unavailable: t('dialogs.export.diag.unavailable'),
  }), [t]);

  const stashUnsavedExport = useCallback((pending: UnsavedExport | null) => {
    unsavedExportRef.current = pending;
    setUnsavedExport(pending);
  }, []);

  // Re-save a finished export whose write failed (D10): pick a new location and
  // write the retained blob. Reads the ref so the toast action never goes stale.
  const handleSaveUnsavedExport = useCallback(async () => {
    const pending = unsavedExportRef.current;
    if (!pending) return;
    const formatLabel = pending.format === 'gif' ? 'GIF' : 'Video';
    const fallbackKey = pending.format === 'gif' ? 'editor.saveGifFailed' : 'editor.saveVideoFailed';
    try {
      const pickResult = await window.electronAPI.pickSaveFilePath(pending.fileName, locale, getExportFolder());
      if (pickResult.cancelled || !pickResult.path) {
        toast.info(t('editor.exportCancelled'));
        return;
      }
      const saveResult = await window.electronAPI.saveExportedVideo(
        pending.arrayBuffer,
        pending.fileName,
        locale,
        { targetFilePath: pickResult.path },
      );
      if (saveResult.success && saveResult.path) {
        stashUnsavedExport(null);
        setExportError(null);
        setExportedFilePath(saveResult.path);
        rememberExportFolder(saveResult.path);
        showExportSuccessToast(saveResult.path);
      } else if (!saveResult.cancelled) {
        const message = buildSaveDiagnosticMessage(formatLabel, saveResult.message || t(fallbackKey), diagnosticLabels);
        setExportError(message);
        toast.error(saveResult.message || t(fallbackKey));
      }
    } catch (error) {
      console.error('Error saving unsaved export:', error);
      const reason = error instanceof Error ? error.message : String(error);
      setExportError(buildSaveDiagnosticMessage(formatLabel, reason, diagnosticLabels));
      toast.error(t(fallbackKey));
    }
  }, [locale, t, diagnosticLabels, showExportSuccessToast, stashUnsavedExport]);

  const saveAgainToastAction = useMemo(() => ({
    label: t('dialogs.export.saveAgain'),
    onClick: () => {
      void handleSaveUnsavedExport();
    },
  }), [t, handleSaveUnsavedExport]);

  const handleExport = useCallback(async (settings: ExportSettings, preSelectedSavePath?: string) => {
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
    stashUnsavedExport(null);
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
          sourceDurationMs: probedSourceDurationMs,
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

          const saveResult = await window.electronAPI.saveExportedVideo(
            arrayBuffer, fileName, locale,
            preSelectedSavePath ? { targetFilePath: preSelectedSavePath } : undefined,
          );

          if (saveResult.cancelled) {
            toast.info(t('editor.exportCancelled'));
          } else if (saveResult.success && saveResult.path) {
            showExportSuccessToast(saveResult.path);
            setExportedFilePath(saveResult.path);
            rememberExportFolder(saveResult.path);
          } else if (!saveResult.success) {
            stashUnsavedExport({ arrayBuffer, fileName, format: 'gif' });
            const reason = saveResult.message || t('editor.saveGifFailed');
            setExportError(buildSaveDiagnosticMessage('GIF', reason, diagnosticLabels));
            toast.error(reason, { action: saveAgainToastAction });
          }
        } else {
          const reason = result.errorKind === 'background-load'
            ? t('editor.exportBackgroundLoadFailed', { url: result.backgroundUrl ?? '' })
            : result.error || t('editor.gifExportFailed');
          setExportError(buildExportDiagnosticMessage({
            formatLabel: 'GIF',
            reason,
            sourcePath: videoPath,
            width: settings.gifConfig.width,
            height: settings.gifConfig.height,
            frameRate: settings.gifConfig.frameRate,
          }, diagnosticLabels));
          toast.error(reason);
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
          const pickDirectoryResult = await window.electronAPI.pickExportDirectory(locale, getExportFolder());
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
            sourceDurationMs: probedSourceDurationMs,
            decodePath: readExportDecodePathOverride(),
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
            const reason = result.errorKind === 'background-load'
              ? t('editor.exportBackgroundLoadFailed', { url: result.backgroundUrl ?? '' })
              : result.error || t('editor.exportFailed');
            setExportError(buildExportDiagnosticMessage({
              formatLabel: 'Video',
              reason,
              sourcePath: videoPath,
              width: exportWidth,
              height: exportHeight,
              frameRate: exportFrameRate,
              codec: 'avc1.640033',
              bitrate,
            }, diagnosticLabels));
            toast.error(reason);
            aborted = true;
            break;
          }

          notifyExportWarnings(result.warnings);

          const arrayBuffer = await result.blob.arrayBuffer();
          const ratioSuffix = ratiosToExport.length > 1 ? `-${currentRatio.replace(':', 'x')}` : '';
          const fileName = `export-${timestamp}${ratioSuffix}.mp4`;

          const saveOptions = exportDirectoryPath
            ? { directoryPath: exportDirectoryPath }
            : preSelectedSavePath
              ? { targetFilePath: preSelectedSavePath }
              : undefined;
          const saveResult = await window.electronAPI.saveExportedVideo(
            arrayBuffer,
            fileName,
            locale,
            saveOptions,
          );

          if (saveResult.cancelled) {
            toast.info(t('editor.exportCancelled'));
            aborted = true;
            break;
          } else if (saveResult.success && saveResult.path) {
            completedCount += 1;
            setExportedFilePath(saveResult.path);
            rememberExportFolder(saveResult.path);
            if (ratiosToExport.length === 1) {
              showExportSuccessToast(saveResult.path);
            }
          } else if (!saveResult.success) {
            stashUnsavedExport({ arrayBuffer, fileName, format: 'mp4' });
            const reason = saveResult.message || t('editor.saveVideoFailed');
            setExportError(buildSaveDiagnosticMessage('Video', reason, diagnosticLabels));
            toast.error(reason, { action: saveAgainToastAction });
            aborted = true;
            break;
          }
        }

        if (!aborted && completedCount > 1 && exportDirectoryPath) {
          showExportSuccessToast(exportDirectoryPath);
        }
      }
    } catch (error) {
      console.error('Export error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setExportError(buildExportDiagnosticMessage({
        formatLabel: settings.format === 'gif' ? 'GIF' : 'Video',
        reason: errorMessage,
        sourcePath: videoPath,
      }, diagnosticLabels));
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
  }, [videoPath, wallpaper, zoomRegions, zoomRegionsByAspect, trimRegions, shadowIntensity, showBlur, motionBlurEnabled, borderRadius, padding, activeCropRegion, cropRegionsByAspect, sourceAspectRatio, annotationRegions, subtitleCues, isPlaying, normalizedExportAspectRatios, exportQuality, locale, sourceFrameRate, sourceHasAudio, audioEnabled, audioGain, audioNormalizeLoudness, audioTargetLufs, audioLimiterDb, audioEditRegions, cursorTrack, cursorStyle, t, diagnosticLabels, saveAgainToastAction, showExportSuccessToast, stashUnsavedExport, probedSourceDurationMs]);

  const handleOpenExportDialog = useCallback(async () => {
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

    // Ask user to pick save location BEFORE starting export
    // (batch export with multiple aspect ratios uses a directory picker inside handleExport)
    const isBatchExport = exportFormat === 'mp4' && normalizedExportAspectRatios.length > 1;
    let preSelectedSavePath: string | undefined;

    if (!isBatchExport) {
      const ext = exportFormat === 'gif' ? 'gif' : 'mp4';
      const defaultFileName = `export-${Date.now()}.${ext}`;
      const pickResult = await window.electronAPI.pickSaveFilePath(defaultFileName, locale, getExportFolder());
      if (pickResult.cancelled || !pickResult.path) {
        return;
      }
      preSelectedSavePath = pickResult.path;
    }

    setShowExportDialog(true);
    setExportError(null);

    handleExport(settings, preSelectedSavePath);
  }, [videoPath, exportFormat, exportQuality, gifFrameRate, gifLoop, gifSizePreset, handleExport, normalizedExportAspectRatios.length, locale, t]);

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
      // Toast is shown by handleExport when it detects cancellation — no duplicate here.
      setShowExportDialog(false);
      setExportProgress(null);
      setExportError(null);
      setExportedFilePath(undefined);
    }
  }, []);

  const handleExportDialogClose = useCallback(() => {
    // If export is running, animate minimize to float
    if (isExporting) {
      setExportDialogAnim('minimizing');
    } else {
      setShowExportDialog(false);
      setExportedFilePath(undefined);
    }
  }, [isExporting]);

  const handleMinimizeEnd = useCallback(() => {
    setShowExportDialog(false);
    setExportDialogAnim('idle');
  }, []);

  const handleFloatClick = useCallback(() => {
    setExportDialogAnim('maximizing');
  }, []);

  const handleFloatExitEnd = useCallback(() => {
    setShowExportDialog(true);
    setExportDialogAnim('idle');
  }, []);

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

  /** Immediate save (bypasses the 2 s debounce). Used before switching windows and on close/quit. */
  const saveProjectNow = useCallback(async (): Promise<void> => {
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
        showTimelineWaveform,
        autoZoomEnabled,
        autoFocusAll,
      };
      lastSavedHashRef.current = JSON.stringify(state);
      await window.electronAPI.saveProjectState(videoFilePath, state).catch(() => {});
    }
  }, [
    videoFilePath, segments, zoomRegionsByAspect, annotationRegions,
    audioEditRegions, cropRegionsByAspect, aspectRatio, wallpaper,
    shadowIntensity, showBlur, motionBlurEnabled, borderRadius, padding,
    audioEnabled, audioGain, audioNormalizeLoudness, audioTargetLufs,
    audioLimiterDb, exportQuality, exportFormat, seekStepSeconds,
    previewPlaybackRate, cursorStyle, subtitleCues, gifFrameRate,
    gifLoop, gifSizePreset, exportAspectRatios, timelineZoomInfo,
    showTimelineWaveform, autoZoomEnabled, autoFocusAll,
  ]);
  const saveProjectNowRef = useRef(saveProjectNow);
  saveProjectNowRef.current = saveProjectNow;

  const handleCloseEditor = useCallback(() => {
    void saveProjectNow();
    window.electronAPI.switchToLaunch();
  }, [saveProjectNow]);

  // Main intercepts the window close / app quit and waits (<= 2 s) for this
  // flush so an edit inside the auto-save debounce is not lost (P3).
  useEffect(() => {
    const unsubscribe = window.electronAPI.onRequestSaveBeforeClose?.(() => {
      void saveProjectNowRef.current().finally(() => {
        window.electronAPI.saveBeforeCloseDone?.();
      });
    });
    return () => unsubscribe?.();
  }, []);

  // ── Menu actions (custom titlebar menu bar + native application menu) ──
  const handleImportVideo = useCallback(async () => {
    try {
      const result = await window.electronAPI.openVideoFilePicker(locale);
      if (result.cancelled) return;
      if (!result.success || !result.path) {
        reportUserActionError({
          t,
          userMessage: t('editor.importVideoFailed'),
          error: result,
          context: 'video-editor.import-video',
          dedupeKey: 'video-editor.import-video',
        });
        return;
      }
      // Persist the current project before the window reloads onto the new video.
      await saveProjectNowRef.current();
      const applied = await window.electronAPI.setCurrentVideoPath(result.path);
      if (!applied.success) {
        reportUserActionError({
          t,
          userMessage: t('editor.importVideoFailed'),
          error: applied,
          context: 'video-editor.import-video',
          dedupeKey: 'video-editor.import-video',
        });
        return;
      }
      window.location.reload();
    } catch (error) {
      reportUserActionError({
        t,
        userMessage: t('editor.importVideoFailed'),
        error,
        context: 'video-editor.import-video',
        dedupeKey: 'video-editor.import-video',
      });
    }
  }, [locale, t]);

  const handleSaveDiagnostics = useCallback(async () => {
    try {
      const result = await window.electronAPI.saveDiagnostic?.({ locale });
      if (!result || result.cancelled) return;
      if (result.success && result.path) {
        toast.success(t('editor.diagnosticSaved', { path: result.path }));
      } else {
        toast.error(t('editor.diagnosticSaveFailed'));
      }
    } catch {
      toast.error(t('editor.diagnosticSaveFailed'));
    }
  }, [locale, t]);

  const handleReportIssue = useCallback(() => {
    void window.electronAPI.openExternalUrl(`${GITHUB_ISSUES_URL}/new`);
  }, []);

  const handleShowAbout = useCallback(() => {
    void window.electronAPI.showAbout?.();
  }, []);

  const handleReload = useCallback(() => {
    void saveProjectNowRef.current().finally(() => window.location.reload());
  }, []);

  const handleQuit = useCallback(() => {
    window.electronAPI.appQuit?.();
  }, []);

  const toggleTimelinePanel = useCallback(() => setTimelinePanelVisible((v) => !v), []);
  const toggleSettingsPanel = useCallback(() => setSettingsPanelVisible((v) => !v), []);

  const handleOpenExportDialogRef = useRef(handleOpenExportDialog);
  handleOpenExportDialogRef.current = handleOpenExportDialog;
  const handleImportVideoRef = useRef(handleImportVideo);
  handleImportVideoRef.current = handleImportVideo;
  const handleCloseEditorRef = useRef(handleCloseEditor);
  handleCloseEditorRef.current = handleCloseEditor;

  // Native application menu (electron/main.ts) forwards its clicks here.
  useEffect(() => {
    const unsubscribe = window.electronAPI.onEditorMenuAction?.((action) => {
      switch (action) {
        case 'menu-undo':
          // Same rule as the keydown path: a focused text field keeps the browser's undo.
          if (isTextEditingTarget(document.activeElement)) document.execCommand('undo');
          else handleUndoRef.current();
          break;
        case 'menu-redo':
          if (isTextEditingTarget(document.activeElement)) document.execCommand('redo');
          else handleRedoRef.current();
          break;
        case 'menu-import-video':
          void handleImportVideoRef.current();
          break;
        case 'menu-export':
          void handleOpenExportDialogRef.current();
          break;
        case 'menu-return-to-recorder':
          handleCloseEditorRef.current();
          break;
        case 'menu-toggle-timeline':
          setTimelinePanelVisible((v) => !v);
          break;
        case 'menu-toggle-settings':
          setSettingsPanelVisible((v) => !v);
          break;
        case 'menu-open-shortcuts':
          openShortcutsConfig();
          break;
        default:
          break;
      }
    });
    return () => unsubscribe?.();
  }, [openShortcutsConfig]);

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
          className="flex items-center p-1.5 text-xs text-slate-400 hover:text-slate-200 hover:bg-white/5 rounded transition-colors"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          title={t("editor.closeEditor")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5" /><path d="m12 19-7-7 7-7" />
          </svg>
        </button>
        <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <EditorMenuBar
            isMac={isMacPlatform}
            t={t}
            onImportVideo={() => { void handleImportVideo(); }}
            onExport={() => { void handleOpenExportDialog(); }}
            onReturnToRecorder={handleCloseEditor}
            onQuit={handleQuit}
            onUndo={handleUndo}
            onRedo={handleRedo}
            onKeyboardShortcuts={openShortcutsConfig}
            onToggleTimeline={toggleTimelinePanel}
            onToggleSettings={toggleSettingsPanel}
            onReload={handleReload}
            onSaveDiagnostics={() => { void handleSaveDiagnostics(); }}
            onReportIssue={handleReportIssue}
            onAbout={handleShowAbout}
            canUndo={historyState.canUndo}
            canRedo={historyState.canRedo}
            timelineVisible={timelinePanelVisible}
            settingsVisible={settingsPanelVisible}
          />
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={() => setTimelinePanelVisible(v => !v)}
            className={cn(
              "p-1.5 rounded transition-colors",
              timelinePanelVisible
                ? "text-slate-400 hover:text-slate-200 hover:bg-white/5"
                : "text-[#34B27B] bg-[#34B27B]/10 hover:bg-[#34B27B]/20"
            )}
            title={timelinePanelVisible ? t("editor.hideTimeline") : t("editor.showTimeline")}
          >
            {timelinePanelVisible ? <PanelBottomClose className="w-3.5 h-3.5" /> : <PanelBottomOpen className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => setSettingsPanelVisible(v => !v)}
            className={cn(
              "p-1.5 rounded transition-colors",
              settingsPanelVisible
                ? "text-slate-400 hover:text-slate-200 hover:bg-white/5"
                : "text-[#34B27B] bg-[#34B27B]/10 hover:bg-[#34B27B]/20"
            )}
            title={settingsPanelVisible ? t("editor.hideSettings") : t("editor.showSettings")}
          >
            {settingsPanelVisible ? <PanelRightClose className="w-3.5 h-3.5" /> : <PanelRightOpen className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      <div className="flex-1 p-5 gap-4 flex min-h-0 relative">
        {/* Left Column - Video & Timeline */}
        <div className={cn("flex flex-col gap-3 min-w-0 h-full transition-[flex] duration-300 ease-in-out", settingsPanelVisible ? "flex-[7]" : "flex-1")}>
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
                      onSourceDurationProbed={handleSourceDurationProbed}
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
                      isPreviewingZoom={isPreviewingZoom}
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

            <PanelResizeHandle
              className={cn(
                "h-3 bg-[#09090b]/80 hover:bg-[#09090b] transition-all rounded-full mx-4 flex items-center justify-center",
                !timelinePanelVisible && "opacity-0 h-0 pointer-events-none"
              )}
            >
              <div className="w-8 h-1 bg-white/20 rounded-full" />
            </PanelResizeHandle>

            <Panel
              ref={timelinePanelRef}
              defaultSize={30}
              minSize={10}
              collapsible
              collapsedSize={0}
              onCollapse={() => setTimelinePanelVisible(false)}
              onExpand={() => setTimelinePanelVisible(true)}
            >
              <div className={cn(
                "h-full bg-[#09090b] rounded-2xl border border-white/5 shadow-lg overflow-hidden flex flex-col transition-opacity duration-200",
                !timelinePanelVisible && "opacity-0"
              )}>
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
                  videoFilePath={videoFilePath}
                  videoUrl={videoPath}
                  showWaveform={showTimelineWaveform}
                />
              </div>
            </Panel>
          </PanelGroup>
        </div>

          {/* Right section: settings panel */}
          <div
            className={cn(
              "transition-[flex,opacity] duration-300 ease-in-out overflow-hidden h-full",
              settingsPanelVisible ? "flex-[2] opacity-100" : "flex-[0] opacity-0 pointer-events-none"
            )}
          >
            <div className={cn("h-full", settingsPanelVisible ? "min-w-[260px]" : "min-w-0")}>
              <SettingsPanel
                selected={wallpaper}
                onWallpaperChange={setWallpaper}
                selectedZoomDepth={selectedZoomRegion?.depth ?? null}
                onZoomDepthChange={(depth) => selectedZoomId && handleZoomDepthChange(depth)}
                selectedZoomCustomScale={selectedZoomRegion?.customScale ?? null}
                onZoomCustomScaleChange={handleZoomCustomScaleChange}
                onZoomCustomScaleCommit={endHistoryBatch}
                selectedZoomFocus={selectedZoomRegion?.focus ?? null}
                onZoomFocusCoordinateChange={handleZoomFocusCoordinateChange}
                onZoomFocusCoordinateCommit={endHistoryBatch}
                selectedZoomFocusMode={selectedZoomRegion ? getZoomFocusMode(selectedZoomRegion) : null}
                onZoomFocusModeChange={handleZoomFocusModeChange}
                autoFocusAll={autoFocusAll}
                onToggleAutoFocusAll={handleToggleAutoFocusAll}
                onZoomPreviewStart={() => setIsPreviewingZoom(true)}
                onZoomPreviewEnd={() => setIsPreviewingZoom(false)}
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
                onAnnotationDuplicate={handleAnnotationDuplicate}
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
                autoZoomEnabled={autoZoomEnabled}
                onToggleAutoZoom={handleToggleAutoZoom}
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
                showTimelineWaveform={showTimelineWaveform}
                onTimelineWaveformChange={setShowTimelineWaveform}
              />
            </div>
          </div>
      </div>
      <ExportDialog
        isOpen={showExportDialog || exportDialogAnim === 'minimizing'}
        onClose={handleExportDialogClose}
        progress={exportProgress}
        isExporting={isExporting}
        error={exportError}
        onCancel={handleCancelExport}
        exportFormat={exportFormat}
        exportedFilePath={exportedFilePath}
        batchProgress={activeBatchExport}
        isMinimizing={exportDialogAnim === 'minimizing'}
        onMinimizeEnd={handleMinimizeEnd}
        unsavedExport={unsavedExport ? { fileName: unsavedExport.fileName, format: unsavedExport.format } : null}
        onSaveUnsavedExport={handleSaveUnsavedExport}
      />
      {(isExporting || exportProgress || exportError) && !showExportDialog && (
        <ExportProgressFloat
          progress={exportProgress}
          isExporting={isExporting}
          error={exportError}
          exportFormat={exportFormat}
          batchProgress={activeBatchExport}
          onClick={handleFloatClick}
          isExiting={exportDialogAnim === 'maximizing'}
          onExitEnd={handleFloatExitEnd}
          isEntering={exportDialogAnim === 'idle'}
        />
      )}
    </div>
  );
}
