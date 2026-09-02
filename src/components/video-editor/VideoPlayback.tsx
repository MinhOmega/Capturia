import type React from "react";
import { useEffect, useRef, useImperativeHandle, forwardRef, useState, useMemo, useCallback } from "react";
import { classifyWallpaper, DEFAULT_WALLPAPER, resolveImageWallpaperUrl } from "@/lib/wallpaper";
import { Application, Container, Sprite, Graphics, Texture, VideoSource } from 'pixi.js';
import { MotionBlurFilter } from 'pixi-filters/motion-blur';
import {
  computeRotation3DContainScale,
  getZoomScale,
  isRotation3DIdentity,
  rotation3DPerspective,
  type ZoomRegion,
  type ZoomFocus,
  type TrimRegion,
  type AnnotationRegion,
  type AudioEditRegion,
} from "./types";
import { DEFAULT_FOCUS } from "./videoPlayback/constants";
import { clamp01 } from "./videoPlayback/mathUtils";
import {
  createZoomCameraState,
  resetZoomCameraState,
  stepZoomCamera,
} from "./videoPlayback/zoomCamera";
import { buildCursorTelemetry, type CursorTelemetryPoint } from "./videoPlayback/cursorFollowUtils";
import { clampFocusToScale } from "./videoPlayback/focusUtils";
import { updateOverlayIndicator } from "./videoPlayback/overlayUtils";
import { layoutVideoContent as layoutVideoContentUtil } from "./videoPlayback/layoutUtils";
import { applyZoomTransform, createMotionBlurState, resetMotionBlurState } from "./videoPlayback/zoomTransform";
import { createVideoEventHandlers } from "./videoPlayback/videoEventHandlers";
import { type AspectRatio, formatAspectRatioForCSS, getNativeAspectRatioValue } from "@/utils/aspectRatioUtils";
import { AnnotationOverlay } from "./AnnotationOverlay";
import { getRenderableAnnotations } from "@/lib/annotations/renderOrder";
import { getPreviewBackgroundFilter } from "@/lib/rendering/backgroundBlur";
import type { SubtitleCue } from "@/lib/analysis/types";
import { findSubtitleCueAtTime, normalizeSubtitleCues } from "@/lib/analysis/subtitleTrack";
import { resolvePreviewAudioState } from "@/lib/audio/audioEditRegions";
import {
  DEFAULT_CURSOR_STYLE,
  createCursorMotionBlurState,
  drawCompositedCursor,
  getCursorMotionBlurPx,
  projectCursorToViewport,
  resolveCursorClipRect,
  resolveCursorContentScale,
  resolveCursorSizeNorm,
  resolveCursorState,
  type CursorStyleConfig,
  type CursorTrack,
} from "@/lib/cursor";

// WeakMap to persist AudioContext+MediaElementSource across React StrictMode
// remounts. createMediaElementSource permanently captures the video element's
// audio output — closing the context after that silently kills audio with no
// recovery path.  By keeping the context alive on the element we can reconnect
// gain/limiter nodes on the second mount without touching the source capture.
const videoAudioContextCache = new WeakMap<HTMLVideoElement, {
  context: AudioContext;
  source: MediaElementAudioSourceNode;
}>();

interface VideoPlaybackProps {
  videoPath: string;
  onDurationChange: (duration: number) => void;
  /** Real end of an inflated WebM found by the background probe (seconds). */
  onSourceDurationProbed?: (durationSec: number) => void;
  onTimeUpdate: (time: number) => void;
  currentTime: number;
  onPlayStateChange: (playing: boolean) => void;
  onError: (error: string) => void;
  wallpaper?: string;
  zoomRegions: ZoomRegion[];
  selectedZoomId: string | null;
  onSelectZoom: (id: string | null) => void;
  onZoomFocusChange: (id: string, focus: ZoomFocus) => void;
  isPlaying: boolean;
  /** Hold-to-preview: show the zoomed camera at the playhead even though a zoom is selected and playback is paused. */
  isPreviewingZoom?: boolean;
  showShadow?: boolean;
  shadowIntensity?: number;
  showBlur?: boolean;
  /** Zoom motion blur amount 0..1 (0 = off). */
  motionBlurAmount?: number;
  borderRadius?: number;
  padding?: number;
  cropRegion?: import('./types').CropRegion;
  trimRegions?: TrimRegion[];
  aspectRatio: AspectRatio;
  annotationRegions?: AnnotationRegion[];
  selectedAnnotationId?: string | null;
  onSelectAnnotation?: (id: string | null) => void;
  onAnnotationPositionChange?: (id: string, position: { x: number; y: number }) => void;
  onAnnotationSizeChange?: (id: string, size: { width: number; height: number }) => void;
  subtitleCues?: SubtitleCue[];
  preferredFps?: number;
  cursorTrack?: CursorTrack | null;
  cursorStyle?: Partial<CursorStyleConfig>;
  hasAudioTrack?: boolean;
  audioEnabled?: boolean;
  audioGain?: number;
  audioLimiterDb?: number;
  audioEditRegions?: AudioEditRegion[];
  onVideoDimensionsChange?: (dimensions: { width: number; height: number }) => void;
  segmentsRef?: React.MutableRefObject<import('./types').VideoSegment[]>;
  previewPlaybackRateRef?: React.MutableRefObject<number>;
}

export interface VideoPlaybackRef {
  video: HTMLVideoElement | null;
  app: Application | null;
  videoSprite: Sprite | null;
  videoContainer: Container | null;
  containerRef: React.RefObject<HTMLDivElement>;
  play: () => Promise<void>;
  pause: () => void;
}

const VideoPlayback = forwardRef<VideoPlaybackRef, VideoPlaybackProps>(({
  videoPath,
  onDurationChange,
  onSourceDurationProbed,
  onTimeUpdate,
  currentTime,
  onPlayStateChange,
  onError,
  wallpaper,
  zoomRegions,
  selectedZoomId,
  onSelectZoom,
  onZoomFocusChange,
  isPlaying,
  isPreviewingZoom = false,
  showShadow,
  shadowIntensity = 0,
  showBlur,
  motionBlurAmount = 0,
  borderRadius = 0,
  padding = 50,
  cropRegion,
  trimRegions = [],
  aspectRatio,
  annotationRegions = [],
  selectedAnnotationId,
  onSelectAnnotation,
  onAnnotationPositionChange,
  onAnnotationSizeChange,
  subtitleCues = [],
  preferredFps = 60,
  cursorTrack = null,
  cursorStyle,
  hasAudioTrack = true,
  audioEnabled = true,
  audioGain = 1,
  audioLimiterDb = -1,
  audioEditRegions = [],
  onVideoDimensionsChange,
  segmentsRef,
  previewPlaybackRateRef,
}, ref) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // 3D tilt (rotationPreset): the root gets `perspective`, composite3D gets the
  // scale/rotate transform. Video + composited cursor sit inside composite3D
  // and tilt together; annotations / subtitles live outside and stay flat.
  const outerWrapperRef = useRef<HTMLDivElement | null>(null);
  const composite3DRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const videoSpriteRef = useRef<Sprite | null>(null);
  const videoContainerRef = useRef<Container | null>(null);
  const cameraContainerRef = useRef<Container | null>(null);
  const timeUpdateAnimationRef = useRef<number | null>(null);
  const [pixiReady, setPixiReady] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const focusIndicatorRef = useRef<HTMLDivElement | null>(null);
  const currentTimeRef = useRef(0);
  const zoomRegionsRef = useRef<ZoomRegion[]>([]);
  const selectedZoomIdRef = useRef<string | null>(null);
  // Target the camera is heading to this frame (focus is read by the cursor overlay fallback).
  const animationStateRef = useRef({ scale: 1, focusX: DEFAULT_FOCUS.cx, focusY: DEFAULT_FOCUS.cy, progress: 0 });
  // Spring state + applied transform; the same step drives the exporter (zoomCamera.ts).
  const zoomCameraRef = useRef(createZoomCameraState());
  const motionBlurFilterRef = useRef<MotionBlurFilter | null>(null);
  const motionBlurStateRef = useRef(createMotionBlurState());
  const isScrubbingRef = useRef(false);
  const scrubEndTimerRef = useRef<number | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  // Overlay size for annotation overlays; fed by a ResizeObserver so the first
  // paint never falls back to a placeholder size.
  const [overlaySize, setOverlaySize] = useState({ width: 800, height: 600 });
  const idleResolutionRef = useRef(1);
  const isDraggingFocusRef = useRef(false);
  const stageSizeRef = useRef({ width: 0, height: 0 });
  const videoSizeRef = useRef({ width: 0, height: 0 });
  const baseScaleRef = useRef(1);
  const baseOffsetRef = useRef({ x: 0, y: 0 });
  const baseMaskRef = useRef({ x: 0, y: 0, width: 0, height: 0 });
  const baseMaskRadiusRef = useRef(0);
  const cropBoundsRef = useRef({ startX: 0, endX: 0, startY: 0, endY: 0 });
  const maskGraphicsRef = useRef<Graphics | null>(null);
  const isPlayingRef = useRef(isPlaying);
  const isPreviewingZoomRef = useRef(isPreviewingZoom);
  const isSeekingRef = useRef(false);
  const allowPlaybackRef = useRef(false);
  const lockedVideoDimensionsRef = useRef<{ width: number; height: number } | null>(null);
  const layoutVideoContentRef = useRef<(() => void) | null>(null);
  const trimRegionsRef = useRef<TrimRegion[]>([]);
  const motionBlurAmountRef = useRef(motionBlurAmount);
  const videoReadyRafRef = useRef<number | null>(null);
  const preferredFpsRef = useRef(preferredFps);
  const cursorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cursorCanvasCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const cursorMotionBlurStateRef = useRef(createCursorMotionBlurState());
  const cursorTrackRef = useRef<CursorTrack | null>(cursorTrack);
  // Auto-follow telemetry (focusMode 'auto'): built once per track, read by the
  // zoom ticker independently of the cursor render smoothing.
  const cursorTelemetryRef = useRef<CursorTelemetryPoint[]>(buildCursorTelemetry(cursorTrack));
  const cursorStyleRef = useRef<Partial<CursorStyleConfig>>(cursorStyle ?? DEFAULT_CURSOR_STYLE);
  const cropRegionRef = useRef(cropRegion);
  const previewAudioContextRef = useRef<AudioContext | null>(null);
  const previewAudioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const previewAudioGainRef = useRef<GainNode | null>(null);
  const previewAudioLimiterRef = useRef<DynamicsCompressorNode | null>(null);
  const previewAudioGraphEnabledRef = useRef(false);

  const normalizeTickerFps = useCallback((fps: number) => {
    if (!Number.isFinite(fps)) return 60;
    return Math.max(30, Math.min(120, Math.round(fps)));
  }, []);

  // Clamp against the region's effective scale so customScale is honoured.
  const clampFocusToStage = useCallback((focus: ZoomFocus, zoomScale: number) => {
    return clampFocusToScale(focus, zoomScale, stageSizeRef.current);
  }, []);

  const audioGraphFailedRef = useRef(false);

  const ensurePreviewAudioGraph = useCallback(() => {
    const video = videoRef.current;
    if (!video) return false;
    if (
      previewAudioGraphEnabledRef.current
      && previewAudioContextRef.current
      && previewAudioGainRef.current
      && previewAudioLimiterRef.current
    ) {
      return true;
    }

    if (audioGraphFailedRef.current) {
      return false;
    }

    const AudioContextConstructor = window.AudioContext
      || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) {
      audioGraphFailedRef.current = true;
      return false;
    }

    try {
      // Reuse existing AudioContext+source if this video element was already
      // captured (e.g. after React StrictMode remount).
      let cached = videoAudioContextCache.get(video);
      if (!cached || cached.context.state === 'closed') {
        const context = new AudioContextConstructor();
        const source = context.createMediaElementSource(video);
        cached = { context, source };
        videoAudioContextCache.set(video, cached);
      }

      const { context, source } = cached;

      // Disconnect previous connections before wiring new graph
      try { source.disconnect(); } catch { /* no prior connections */ }

      const gainNode = context.createGain();
      const limiterNode = context.createDynamicsCompressor();
      limiterNode.knee.value = 0;
      limiterNode.ratio.value = 20;
      limiterNode.attack.value = 0.003;
      limiterNode.release.value = 0.1;

      source.connect(gainNode);
      gainNode.connect(limiterNode);
      limiterNode.connect(context.destination);

      previewAudioContextRef.current = context;
      previewAudioSourceRef.current = source;
      previewAudioGainRef.current = gainNode;
      previewAudioLimiterRef.current = limiterNode;
      previewAudioGraphEnabledRef.current = true;
      return true;
    } catch (error) {
      console.warn("Failed to initialize preview audio processing graph; falling back to HTML media volume.", error);
      audioGraphFailedRef.current = true;
      return false;
    }
  }, []);

  const updateOverlayForRegion = useCallback((region: ZoomRegion | null, focusOverride?: ZoomFocus) => {
    const overlayEl = overlayRef.current;
    const indicatorEl = focusIndicatorRef.current;
    
    if (!overlayEl || !indicatorEl) {
      return;
    }

    // Update stage size from overlay dimensions
    const stageWidth = overlayEl.clientWidth;
    const stageHeight = overlayEl.clientHeight;
    if (stageWidth && stageHeight) {
      stageSizeRef.current = { width: stageWidth, height: stageHeight };
    }

    updateOverlayIndicator({
      overlayEl,
      indicatorEl,
      region,
      focusOverride,
      videoSize: videoSizeRef.current,
      baseScale: baseScaleRef.current,
      isPlaying: isPlayingRef.current,
    });
  }, []);

  const layoutVideoContent = useCallback(() => {
    const container = containerRef.current;
    const app = appRef.current;
    const videoSprite = videoSpriteRef.current;
    const maskGraphics = maskGraphicsRef.current;
    const videoElement = videoRef.current;
    const cameraContainer = cameraContainerRef.current;

    if (!container || !app || !videoSprite || !maskGraphics || !videoElement || !cameraContainer) {
      return;
    }

    // Lock video dimensions on first layout to prevent resize issues
    if (!lockedVideoDimensionsRef.current && videoElement.videoWidth > 0 && videoElement.videoHeight > 0) {
      lockedVideoDimensionsRef.current = {
        width: videoElement.videoWidth,
        height: videoElement.videoHeight,
      };
    }

    const result = layoutVideoContentUtil({
      container,
      app,
      videoSprite,
      maskGraphics,
      videoElement,
      cropRegion,
      lockedVideoDimensions: lockedVideoDimensionsRef.current,
      borderRadius,
      padding,
    });

    if (result) {
      stageSizeRef.current = result.stageSize;
      videoSizeRef.current = result.videoSize;
      baseScaleRef.current = result.baseScale;
      baseOffsetRef.current = result.baseOffset;
      baseMaskRef.current = result.maskRect;
      baseMaskRadiusRef.current = result.maskBorderRadius;
      cropBoundsRef.current = result.cropBounds;

      // Reset camera container to identity
      cameraContainer.scale.set(1);
      cameraContainer.position.set(0, 0);

      const selectedId = selectedZoomIdRef.current;
      const activeRegion = selectedId
        ? zoomRegionsRef.current.find((region) => region.id === selectedId) ?? null
        : null;

      updateOverlayForRegion(activeRegion);
    }
  }, [updateOverlayForRegion, cropRegion, borderRadius, padding]);

  useEffect(() => {
    layoutVideoContentRef.current = layoutVideoContent;
  }, [layoutVideoContent]);

  const selectedZoom = useMemo(() => {
    if (!selectedZoomId) return null;
    return zoomRegions.find((region) => region.id === selectedZoomId) ?? null;
  }, [zoomRegions, selectedZoomId]);

  const normalizedSubtitleCues = useMemo(() => normalizeSubtitleCues(subtitleCues), [subtitleCues]);
  const activeSubtitleCue = useMemo(
    () => findSubtitleCueAtTime(normalizedSubtitleCues, Math.round(currentTime * 1000)),
    [normalizedSubtitleCues, currentTime],
  );

  useImperativeHandle(ref, () => ({
    video: videoRef.current,
    app: appRef.current,
    videoSprite: videoSpriteRef.current,
    videoContainer: videoContainerRef.current,
    containerRef,
    play: async () => {
      const vid = videoRef.current;
      if (!vid) {
        console.error('[VideoPlayback] play() called but video ref is null');
        return;
      }
      const ctx = previewAudioContextRef.current;
      console.log('[VideoPlayback] play() called, readyState:', vid.readyState, 'networkState:', vid.networkState, 'src:', vid.currentSrc?.slice(-40), 'duration:', vid.duration, 'paused:', vid.paused, 'muted:', vid.muted, 'audioCtx:', ctx?.state);
      try {
        // Resume AudioContext before playing — a suspended context with
        // createMediaElementSource active can cause the browser to
        // immediately pause the video on some platforms.
        if (ctx && ctx.state === 'suspended') {
          await ctx.resume().catch(() => {});
        }
        allowPlaybackRef.current = true;
        await vid.play();
        console.log('[VideoPlayback] play() succeeded');
      } catch (error) {
        console.error('[VideoPlayback] play() failed:', error);
        allowPlaybackRef.current = false;
        throw error;
      }
    },
    pause: () => {
      const video = videoRef.current;
      allowPlaybackRef.current = false;
      if (!video) {
        return;
      }
      video.pause();
    },
  }));

  const updateFocusFromClientPoint = (clientX: number, clientY: number) => {
    const overlayEl = overlayRef.current;
    if (!overlayEl) return;

    const regionId = selectedZoomIdRef.current;
    if (!regionId) return;

    const region = zoomRegionsRef.current.find((r) => r.id === regionId);
    if (!region) return;

    const rect = overlayEl.getBoundingClientRect();
    const stageWidth = rect.width;
    const stageHeight = rect.height;

    if (!stageWidth || !stageHeight) {
      return;
    }

    stageSizeRef.current = { width: stageWidth, height: stageHeight };

    const localX = clientX - rect.left;
    const localY = clientY - rect.top;

    const unclampedFocus: ZoomFocus = {
      cx: clamp01(localX / stageWidth),
      cy: clamp01(localY / stageHeight),
    };
    const clampedFocus = clampFocusToStage(unclampedFocus, getZoomScale(region));

    onZoomFocusChange(region.id, clampedFocus);
    updateOverlayForRegion({ ...region, focus: clampedFocus }, clampedFocus);
  };

  const handleOverlayPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isPlayingRef.current) return;
    const regionId = selectedZoomIdRef.current;
    if (!regionId) return;
    const region = zoomRegionsRef.current.find((r) => r.id === regionId);
    if (!region) return;
    // Auto-follow regions take their focus from the cursor: nothing to drag.
    if (region.focusMode === 'auto') return;
    onSelectZoom(region.id);
    event.preventDefault();
    isDraggingFocusRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateFocusFromClientPoint(event.clientX, event.clientY);
  };

  const handleOverlayPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingFocusRef.current) return;
    event.preventDefault();
    updateFocusFromClientPoint(event.clientX, event.clientY);
  };

  const endFocusDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingFocusRef.current) return;
    isDraggingFocusRef.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // no-op
    }
  };

  const handleOverlayPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    endFocusDrag(event);
  };

  const handleOverlayPointerLeave = (event: React.PointerEvent<HTMLDivElement>) => {
    endFocusDrag(event);
  };

  useEffect(() => {
    zoomRegionsRef.current = zoomRegions;
  }, [zoomRegions]);

  useEffect(() => {
    selectedZoomIdRef.current = selectedZoomId;
  }, [selectedZoomId]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    isPreviewingZoomRef.current = isPreviewingZoom;
  }, [isPreviewingZoom]);

  useEffect(() => {
    trimRegionsRef.current = trimRegions;
  }, [trimRegions]);

  useEffect(() => {
    motionBlurAmountRef.current = motionBlurAmount;
  }, [motionBlurAmount]);

  useEffect(() => {
    cursorTrackRef.current = cursorTrack;
    cursorTelemetryRef.current = buildCursorTelemetry(cursorTrack);
  }, [cursorTrack]);

  useEffect(() => {
    cursorStyleRef.current = cursorStyle ?? DEFAULT_CURSOR_STYLE;
  }, [cursorStyle]);

  useEffect(() => {
    cropRegionRef.current = cropRegion;
  }, [cropRegion]);

  useEffect(() => {
    return () => {
      // Disconnect processing nodes but do NOT close the AudioContext.
      // The context + source are cached on the video element via
      // videoAudioContextCache so they survive React StrictMode remounts.
      // Closing the context would permanently break the video's audio routing.
      previewAudioGainRef.current?.disconnect();
      previewAudioLimiterRef.current?.disconnect();
      previewAudioSourceRef.current = null;
      previewAudioGainRef.current = null;
      previewAudioLimiterRef.current = null;
      previewAudioContextRef.current = null;
      previewAudioGraphEnabledRef.current = false;
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const nextState = resolvePreviewAudioState({
      hasAudioTrack,
      audioEnabled,
      baseGain: audioGain,
      timeMs: Math.max(0, Math.round(currentTime * 1000)),
      regions: audioEditRegions,
    });

    if (ensurePreviewAudioGraph()) {
      const context = previewAudioContextRef.current;
      const gainNode = previewAudioGainRef.current;
      const limiterNode = previewAudioLimiterRef.current;
      if (context && gainNode && limiterNode) {
        const limiterThreshold = Number.isFinite(audioLimiterDb)
          ? Math.max(-6, Math.min(-0.1, audioLimiterDb))
          : -1;
        limiterNode.threshold.value = limiterThreshold;
        const targetGain = nextState.muted ? 0 : nextState.volume;
        if (Math.abs(gainNode.gain.value - targetGain) > 0.0005) {
          gainNode.gain.setValueAtTime(targetGain, context.currentTime);
        }

        video.muted = false;
        if (Math.abs(video.volume - 1) > 0.0005) {
          video.volume = 1;
        }
        if (!nextState.muted && context.state === "suspended" && !video.paused) {
          void context.resume().catch((error) => {
            console.warn("Failed to resume preview AudioContext during playback.", error);
          });
        }
        return;
      }
    }

    video.muted = nextState.muted;
    const clampedVolume = Math.max(0, Math.min(1, nextState.volume));
    if (Math.abs(video.volume - clampedVolume) > 0.0005) {
      video.volume = clampedVolume;
    }
  }, [hasAudioTrack, audioEnabled, audioGain, audioLimiterDb, currentTime, audioEditRegions, videoPath, ensurePreviewAudioGraph]);

  useEffect(() => {
    preferredFpsRef.current = preferredFps;
    const app = appRef.current;
    if (app?.ticker) {
      app.ticker.maxFPS = normalizeTickerFps(preferredFps);
    }
  }, [preferredFps, normalizeTickerFps]);

  useEffect(() => {
    if (!pixiReady || !videoReady) return;

    const app = appRef.current;
    const cameraContainer = cameraContainerRef.current;
    const video = videoRef.current;

    if (!app || !cameraContainer || !video) return;

    const tickerWasStarted = app.ticker?.started || false;
    if (tickerWasStarted && app.ticker) {
      app.ticker.stop();
    }

    const wasPlaying = !video.paused;
    if (wasPlaying) {
      console.warn('[VideoPlayback] layout-reset effect pausing video, wasPlaying:', wasPlaying);
      video.pause();
    }

    animationStateRef.current = {
      scale: 1,
      focusX: DEFAULT_FOCUS.cx,
      focusY: DEFAULT_FOCUS.cy,
      progress: 0,
    };
    resetZoomCameraState(zoomCameraRef.current);

    resetMotionBlurState(motionBlurStateRef.current);

    requestAnimationFrame(() => {
      const container = cameraContainerRef.current;
      const videoStage = videoContainerRef.current;
      const sprite = videoSpriteRef.current;
      const currentApp = appRef.current;
      if (!container || !videoStage || !sprite || !currentApp) {
        return;
      }

      container.scale.set(1);
      container.position.set(0, 0);
      videoStage.scale.set(1);
      videoStage.position.set(0, 0);
      sprite.scale.set(1);
      sprite.position.set(0, 0);

      layoutVideoContent();

      applyZoomTransform({
        cameraContainer: container,
        motionBlurFilter: motionBlurFilterRef.current,
        motionBlurState: motionBlurStateRef.current,
        stageSize: stageSizeRef.current,
        baseMask: baseMaskRef.current,
        zoomScale: 1,
        focusX: DEFAULT_FOCUS.cx,
        focusY: DEFAULT_FOCUS.cy,
        isPlaying: false,
        motionBlurAmount: 0,
      });

      requestAnimationFrame(() => {
        const finalApp = appRef.current;
        if (wasPlaying && video) {
          video.play().catch(() => {
          });
        }
        if (tickerWasStarted && finalApp?.ticker) {
          finalApp.ticker.start();
        }
      });
    });
  }, [pixiReady, videoReady, layoutVideoContent, cropRegion]);

  useEffect(() => {
    if (!pixiReady || !videoReady) return;
    const container = containerRef.current;
    if (!container) return;

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      layoutVideoContent();
    });

    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [pixiReady, videoReady, layoutVideoContent]);

  const ensureCursorCanvas = useCallback(() => {
    const canvas = cursorCanvasRef.current;
    const overlayEl = overlayRef.current;
    if (!canvas || !overlayEl) return;

    const width = overlayEl.clientWidth;
    const height = overlayEl.clientHeight;
    if (width <= 0 || height <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const nextWidth = Math.max(1, Math.round(width * dpr));
    const nextHeight = Math.max(1, Math.round(height * dpr));

    if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
      canvas.width = nextWidth;
      canvas.height = nextHeight;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    let ctx = cursorCanvasCtxRef.current;
    if (!ctx) {
      ctx = canvas.getContext('2d', { alpha: true });
      cursorCanvasCtxRef.current = ctx;
    }
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);

  const renderCursorOverlay = useCallback((timeMs: number) => {
    ensureCursorCanvas();
    const ctx = cursorCanvasCtxRef.current;
    // The preview mask is drawn in stage coordinates at maskRect.x/y (the video
    // container sits at 0,0), so the mask rect is the camera-local origin for
    // both the crop re-normalised projection and the clip rect. This matches the
    // exporter, whose mask is at 0,0 inside a container placed at baseOffset.
    const layout = {
      stageSize: stageSizeRef.current,
      baseOffset: { x: baseMaskRef.current.x, y: baseMaskRef.current.y },
      maskRect: baseMaskRef.current,
      maskBorderRadius: baseMaskRadiusRef.current,
    };
    const cameraContainer = cameraContainerRef.current;

    if (!ctx || !cameraContainer) return;
    if (layout.stageSize.width <= 0 || layout.stageSize.height <= 0 || layout.maskRect.width <= 0 || layout.maskRect.height <= 0) {
      return;
    }

    ctx.clearRect(0, 0, layout.stageSize.width, layout.stageSize.height);

    const drawCursorState = resolveCursorState({
      timeMs,
      track: cursorTrackRef.current,
      zoomRegions: zoomRegionsRef.current,
      fallbackFocus: { cx: animationStateRef.current.focusX, cy: animationStateRef.current.focusY },
      style: cursorStyleRef.current,
    });

    if (!drawCursorState.visible) return;

    const drawProjected = projectCursorToViewport({
      normalizedX: drawCursorState.x,
      normalizedY: drawCursorState.y,
      cropRegion: cropRegionRef.current ?? { x: 0, y: 0, width: 1, height: 1 },
      baseOffset: layout.baseOffset,
      maskRect: layout.maskRect,
      cameraScale: {
        x: cameraContainer.scale.x,
        y: cameraContainer.scale.y,
      },
      cameraPosition: {
        x: cameraContainer.position.x,
        y: cameraContainer.position.y,
      },
      stageSize: layout.stageSize,
    });

    if (!drawProjected.inViewport) return;

    const cursorSizeNorm = resolveCursorSizeNorm({ maskRect: layout.maskRect, cropRegion: cropRegionRef.current });
    const motionBlurPx = getCursorMotionBlurPx({
      motionBlur: cursorStyleRef.current.motionBlur ?? 0,
      point: { x: drawProjected.x, y: drawProjected.y },
      state: cursorMotionBlurStateRef.current,
      timeMs,
      sizeNorm: cursorSizeNorm,
    });

    drawCompositedCursor(
      ctx,
      { x: drawProjected.x, y: drawProjected.y },
      drawCursorState,
      cursorStyleRef.current,
      resolveCursorContentScale({
        cameraScale: { x: cameraContainer.scale.x, y: cameraContainer.scale.y },
        maskRect: layout.maskRect,
        cropRegion: cropRegionRef.current,
      }),
      {
        motionBlurPx,
        clipRect: resolveCursorClipRect({
          style: cursorStyleRef.current,
          maskRect: layout.maskRect,
          maskBorderRadius: layout.maskBorderRadius,
          cameraScale: { x: cameraContainer.scale.x, y: cameraContainer.scale.y },
          cameraPosition: { x: cameraContainer.position.x, y: cameraContainer.position.y },
        }),
      },
    );
  }, [ensureCursorCanvas]);

  useEffect(() => {
    if (!pixiReady || !videoReady) return;
    updateOverlayForRegion(selectedZoom);
  }, [selectedZoom, pixiReady, videoReady, updateOverlayForRegion]);

  useEffect(() => {
    const overlayEl = overlayRef.current;
    if (!overlayEl) return;
    overlayEl.style.cursor = selectedZoom ? (isPlaying ? 'not-allowed' : 'grab') : 'default';
    overlayEl.style.pointerEvents = selectedZoom ? (isPlaying ? 'none' : 'auto') : 'none';
  }, [selectedZoom, isPlaying]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let mounted = true;
    let app: Application | null = null;

    (async () => {
      app = new Application();
      
      await app.init({
        width: container.clientWidth,
        height: container.clientHeight,
        backgroundAlpha: 0,
        antialias: true,
        // Keep high-DPI sharpness in preview while still guarding extreme render cost.
        resolution: preferredFpsRef.current > 60 ? 1 : Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
      });

      app.ticker.maxFPS = normalizeTickerFps(preferredFpsRef.current);
      idleResolutionRef.current = app.renderer.resolution;

      if (!mounted) {
        app.destroy(true, { children: true, texture: true, textureSource: true });
        return;
      }

      appRef.current = app;
      container.appendChild(app.canvas);

      // Camera container - this will be scaled/positioned for zoom
      const cameraContainer = new Container();
      cameraContainerRef.current = cameraContainer;
      app.stage.addChild(cameraContainer);

      // Video container - holds the masked video sprite
      const videoContainer = new Container();
      videoContainerRef.current = videoContainer;
      cameraContainer.addChild(videoContainer);
      
      setPixiReady(true);
    })();

    return () => {
      mounted = false;
      setPixiReady(false);
      if (app && app.renderer) {
        app.destroy(true, { children: true, texture: true, textureSource: true });
      }
      appRef.current = null;
      cameraContainerRef.current = null;
      videoContainerRef.current = null;
      videoSpriteRef.current = null;
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = 0;
    allowPlaybackRef.current = false;
    lockedVideoDimensionsRef.current = null;
    audioGraphFailedRef.current = false;
    setVideoReady(false);
    if (videoReadyRafRef.current) {
      cancelAnimationFrame(videoReadyRafRef.current);
      videoReadyRafRef.current = null;
    }
  }, [videoPath]);



  useEffect(() => {
    if (!pixiReady || !videoReady) return;

    const video = videoRef.current;
    const app = appRef.current;
    const videoContainer = videoContainerRef.current;
    
    if (!video || !app || !videoContainer) return;
    if (video.videoWidth === 0 || video.videoHeight === 0) return;
    
    const source = VideoSource.from(video);
    if ('autoPlay' in source) {
      (source as { autoPlay?: boolean }).autoPlay = false;
    }
    if ('autoUpdate' in source) {
      (source as { autoUpdate?: boolean }).autoUpdate = true;
    }
    const videoTexture = Texture.from(source);
    
    const videoSprite = new Sprite(videoTexture);
    videoSpriteRef.current = videoSprite;
    
    const maskGraphics = new Graphics();
    videoContainer.addChild(videoSprite);
    videoContainer.addChild(maskGraphics);
    videoContainer.mask = maskGraphics;
    maskGraphicsRef.current = maskGraphics;

    animationStateRef.current = {
      scale: 1,
      focusX: DEFAULT_FOCUS.cx,
      focusY: DEFAULT_FOCUS.cy,
      progress: 0,
    };
    resetZoomCameraState(zoomCameraRef.current);

    // Directional blur along the camera velocity (zoomTransform.ts drives it).
    // Not attached here: the ticker only assigns videoContainer.filters while
    // motion blur is active. A permanently attached filter routes every frame
    // through a filter render-texture and softens the idle preview.
    const motionBlurFilter = new MotionBlurFilter({ velocity: { x: 0, y: 0 }, kernelSize: 5, offset: 0 });
    motionBlurFilter.resolution = app.renderer.resolution;
    motionBlurFilterRef.current = motionBlurFilter;
    resetMotionBlurState(motionBlurStateRef.current);
    
    layoutVideoContent();
    console.warn('[VideoPlayback] pixi-texture setup pausing video');
    video.pause();

    const { handlePlay, handlePause, handleSeeked, handleSeeking, dispose } = createVideoEventHandlers({
      video,
      isSeekingRef,
      isPlayingRef,
      allowPlaybackRef,
      currentTimeRef,
      timeUpdateAnimationRef,
      onPlayStateChange,
      onTimeUpdate,
      trimRegionsRef,
      segmentsRef: segmentsRef ?? { current: [] },
      previewPlaybackRateRef: previewPlaybackRateRef ?? { current: 1 },
      isScrubbingRef,
      scrubEndTimerRef,
      onScrubChange: (scrubbing) => setIsScrubbing(scrubbing),
    });

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('ended', handlePause);
    video.addEventListener('seeked', handleSeeked);
    video.addEventListener('seeking', handleSeeking);

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('ended', handlePause);
      video.removeEventListener('seeked', handleSeeked);
      video.removeEventListener('seeking', handleSeeking);
      dispose();
      isScrubbingRef.current = false;

      if (timeUpdateAnimationRef.current) {
        cancelAnimationFrame(timeUpdateAnimationRef.current);
      }
      
      if (videoSprite) {
        videoContainer.removeChild(videoSprite);
        videoSprite.destroy();
      }
      if (maskGraphics) {
        videoContainer.removeChild(maskGraphics);
        maskGraphics.destroy();
      }
      videoContainer.mask = null;
      maskGraphicsRef.current = null;
      videoContainer.filters = null;
      if (motionBlurFilterRef.current) {
        motionBlurFilterRef.current.destroy();
        motionBlurFilterRef.current = null;
      }
      videoTexture.destroy(true);
      
      videoSpriteRef.current = null;
    };
  }, [pixiReady, videoReady, onTimeUpdate, updateOverlayForRegion]);

  useEffect(() => {
    if (!pixiReady || !videoReady) return;

    const app = appRef.current;
    const videoSprite = videoSpriteRef.current;
    const videoContainer = videoContainerRef.current;
    if (!app || !videoSprite || !videoContainer) return;

    // Cached so videoContainer.filters is only touched on transitions; assigning
    // it per frame rebuilds the filter pipeline.
    let lastMotionBlurActive: boolean | null = null;
    // Cached so the 3D wrapper styles are only written when they change.
    let lastTransformIsIdentity = true;
    let lastPerspectiveValue = 0;

    const ticker = () => {
      const cameraContainer = cameraContainerRef.current;
      if (!cameraContainer) return;

      // Content time (segment / speed mapped upstream of currentTimeRef), so the
      // camera and the exporter step through the same clock.
      const timeMs = currentTimeRef.current;

      // If a zoom is selected but video is not playing, show default unzoomed view
      // (the overlay will show where the zoom will be) unless the user is holding
      // the preview button, which shows the dominant region at the playhead.
      const hasSelectedZoom = selectedZoomIdRef.current !== null;
      const shouldShowUnzoomedView = hasSelectedZoom && !isPlayingRef.current && !isPreviewingZoomRef.current;

      // Resolve the eased target (auto-follow regions read the cursor telemetry),
      // smooth the auto-follow focus in content time, then chase the target with
      // a spring so the camera glides (no jerk at the steep start of the ease,
      // no snap at close-region seams). Step by content time while playing; snap
      // to the exact target when paused / seeking / scrubbing so a paused frame
      // is crisp and matches the authored target. Same step as the exporter.
      const animating = isPlayingRef.current && !isSeekingRef.current && !isScrubbingRef.current;
      const { target, applied } = stepZoomCamera(
        zoomCameraRef.current,
        zoomRegionsRef.current,
        timeMs,
        { stageSize: stageSizeRef.current, baseMask: baseMaskRef.current },
        {
          animating,
          forceUnzoomed: shouldShowUnzoomedView,
          cursorTelemetry: cursorTelemetryRef.current,
        },
      );

      const state = animationStateRef.current;
      state.scale = target.scale;
      state.focusX = target.focus.cx;
      state.focusY = target.focus.cy;
      state.progress = target.progress;

      // Blur only while playing (not scrubbing): the velocity estimate needs a
      // monotonic content clock, and a paused/scrubbed frame must stay crisp.
      const isMotionBlurActive =
        (motionBlurAmountRef.current || 0) > 0 && isPlayingRef.current && !isScrubbingRef.current;

      applyZoomTransform({
        cameraContainer,
        motionBlurFilter: motionBlurFilterRef.current,
        motionBlurState: motionBlurStateRef.current,
        stageSize: stageSizeRef.current,
        baseMask: baseMaskRef.current,
        zoomScale: state.scale,
        zoomProgress: state.progress,
        focusX: state.focusX,
        focusY: state.focusY,
        isPlaying: isMotionBlurActive,
        motionBlurAmount: motionBlurAmountRef.current,
        transformOverride: applied,
        frameTimeMs: timeMs,
      });

      if (isMotionBlurActive !== lastMotionBlurActive) {
        if (isMotionBlurActive) {
          if (motionBlurFilterRef.current) {
            videoContainer.filters = [motionBlurFilterRef.current];
            lastMotionBlurActive = true;
          }
        } else {
          videoContainer.filters = null;
          lastMotionBlurActive = false;
        }
      }

      // 3D tilt: the shared camera step already ramped the preset by the eased
      // progress (identity when unzoomed / forced unzoomed), so preview and
      // export read the same rotation for the same content time.
      const composite3D = composite3DRef.current;
      const outerWrapper = outerWrapperRef.current;
      if (composite3D && outerWrapper) {
        const effectiveRotation = target.rotation3D;
        if (isRotation3DIdentity(effectiveRotation)) {
          if (!lastTransformIsIdentity) {
            composite3D.style.transform = '';
            composite3D.style.willChange = 'auto';
            lastTransformIsIdentity = true;
          }
          if (lastPerspectiveValue !== 0) {
            outerWrapper.style.perspective = '';
            lastPerspectiveValue = 0;
          }
        } else {
          const wrapperW = outerWrapper.clientWidth || 1;
          const wrapperH = outerWrapper.clientHeight || 1;
          const persp = rotation3DPerspective(wrapperW, wrapperH);
          const containScale = computeRotation3DContainScale(effectiveRotation, wrapperW, wrapperH, persp);
          composite3D.style.transform = `scale(${containScale}) rotateX(${effectiveRotation.rotationX}deg) rotateY(${effectiveRotation.rotationY}deg) rotateZ(${effectiveRotation.rotationZ}deg)`;
          composite3D.style.willChange = 'transform';
          lastTransformIsIdentity = false;
          if (persp !== lastPerspectiveValue) {
            outerWrapper.style.perspective = `${persp}px`;
            lastPerspectiveValue = persp;
          }
        }
      }

      renderCursorOverlay(timeMs);
    };

    app.ticker.add(ticker);
    return () => {
      if (app && app.ticker) {
        app.ticker.remove(ticker);
      }
    };
  }, [pixiReady, videoReady, renderCursorOverlay]);

  // Overlay size for annotation overlays: seed from the element and follow resizes.
  useEffect(() => {
    if (!pixiReady || !videoReady) return;
    const el = overlayRef.current;
    if (!el) return;

    setOverlaySize({ width: el.clientWidth, height: el.clientHeight });
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      if (!entries[0]) return;
      const { width, height } = entries[0].contentRect;
      setOverlaySize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [pixiReady, videoReady]);

  // Drop canvas resolution to 1.0 while scrubbing and restore the idle resolution
  // afterwards. Only on scrub-state transitions; mutating renderer.resolution
  // per frame thrashes texture uploads.
  useEffect(() => {
    if (!pixiReady) return;
    const app = appRef.current;
    const container = containerRef.current;
    if (!app || !container) return;

    const targetResolution = isScrubbing ? 1 : idleResolutionRef.current;
    if (app.renderer.resolution === targetResolution) return;

    app.renderer.resolution = targetResolution;
    app.renderer.resize(container.clientWidth, container.clientHeight);
    if (motionBlurFilterRef.current) {
      motionBlurFilterRef.current.resolution = targetResolution;
    }
    layoutVideoContentRef.current?.();
  }, [isScrubbing, pixiReady]);

  const handleLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement, Event>) => {
    const video = e.currentTarget;
    const reportedDuration = video.duration;
    console.log('[VideoPlayback] loadedmetadata:', 'duration:', reportedDuration, 'dimensions:', video.videoWidth, 'x', video.videoHeight, 'readyState:', video.readyState, 'src:', video.currentSrc?.slice(-50));

    onDurationChange(reportedDuration);
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      onVideoDimensionsChange?.({
        width: video.videoWidth,
        height: video.videoHeight,
      });
    }
    video.currentTime = 0;
    video.pause();
    allowPlaybackRef.current = false;
    currentTimeRef.current = 0;

    if (videoReadyRafRef.current) {
      cancelAnimationFrame(videoReadyRafRef.current);
      videoReadyRafRef.current = null;
    }

    const waitForRenderableFrame = () => {
      const hasDimensions = video.videoWidth > 0 && video.videoHeight > 0;
      const hasData = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
      if (hasDimensions && hasData) {
        videoReadyRafRef.current = null;
        setVideoReady(true);
        return;
      }
      videoReadyRafRef.current = requestAnimationFrame(waitForRenderableFrame);
    };

    videoReadyRafRef.current = requestAnimationFrame(waitForRenderableFrame);

    // Background probe for WebM files with potentially inflated duration.
    // Uses a separate offscreen video element so the main video is never disrupted.
    const isWebm = video.currentSrc?.toLowerCase().includes('.webm');
    if (isWebm && Number.isFinite(reportedDuration) && reportedDuration > 300) {
      const probeVideo = document.createElement('video');
      probeVideo.preload = 'metadata';
      probeVideo.muted = true;
      let probeCleanedUp = false;
      const cleanupProbe = () => {
        if (probeCleanedUp) return;
        probeCleanedUp = true;
        probeVideo.removeAttribute('src');
        probeVideo.load();
      };
      probeVideo.addEventListener('loadedmetadata', () => {
        const onSeeked = () => {
          probeVideo.removeEventListener('seeked', onSeeked);
          const actualEnd = probeVideo.currentTime;
          if (actualEnd > 0 && actualEnd < reportedDuration * 0.8) {
            console.warn('[VideoPlayback] WebM duration correction: reported', reportedDuration, 's → actual', actualEnd, 's');
            onDurationChange(actualEnd);
            onSourceDurationProbed?.(actualEnd);
          }
          cleanupProbe();
        };
        probeVideo.addEventListener('seeked', onSeeked);
        probeVideo.currentTime = 1e10;
      });
      probeVideo.addEventListener('error', cleanupProbe);
      // Timeout safety — abandon the probe if it takes too long
      setTimeout(cleanupProbe, 10000);
      probeVideo.src = video.currentSrc;
    }
  };

  const [resolvedWallpaper, setResolvedWallpaper] = useState<string | null>(null);

  // The wallpaper prop is the canonical value (see lib/wallpaper.ts); bundled
  // images are resolved to a loadable URL here, colours/gradients pass through.
  useEffect(() => {
    let mounted = true
    ;(async () => {
      const value = wallpaper || DEFAULT_WALLPAPER
      const classified = classifyWallpaper(value)
      try {
        if (classified.kind === 'image') {
          const url = await resolveImageWallpaperUrl(classified.path)
          if (mounted) setResolvedWallpaper(url)
        } else if (mounted) {
          // Keep the full string (a url() overlay + gradient composite paints fine in CSS)
          setResolvedWallpaper(value)
        }
      } catch (err) {
        console.warn('[VideoPlayback] Failed to resolve wallpaper, using raw value:', err)
        if (mounted) setResolvedWallpaper(value)
      }
    })()
    return () => { mounted = false }
  }, [wallpaper])

  useEffect(() => {
    return () => {
      if (videoReadyRafRef.current) {
        cancelAnimationFrame(videoReadyRafRef.current);
        videoReadyRafRef.current = null;
      }
    };
  }, [])

  const isImageUrl = Boolean(resolvedWallpaper && (resolvedWallpaper.startsWith('file://') || resolvedWallpaper.startsWith('http') || resolvedWallpaper.startsWith('/') || resolvedWallpaper.startsWith('data:')))
  const backgroundStyle = isImageUrl
    ? { backgroundImage: `url(${resolvedWallpaper || ''})` }
    : { background: resolvedWallpaper || '' };

  return (
    <div
      ref={outerWrapperRef}
      className="relative rounded-sm overflow-hidden"
      style={{
        width: '100%',
        aspectRatio: formatAspectRatioForCSS(
          aspectRatio,
          aspectRatio === 'native'
            ? getNativeAspectRatioValue(
                lockedVideoDimensionsRef.current?.width || videoRef.current?.videoWidth || 0,
                lockedVideoDimensionsRef.current?.height || videoRef.current?.videoHeight || 0,
                cropRegion,
              )
            : undefined,
        ),
      }}
    >
      {/* Background layer - always render as DOM element with blur */}
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{
          ...backgroundStyle,
          filter: getPreviewBackgroundFilter(Boolean(showBlur)),
        }}
      />
      {/* 3D tilt group (rotationPreset): the Pixi canvas and the composited
          cursor rotate together; the wallpaper below and the annotation /
          subtitle overlay above stay flat. Driven per ticker frame. */}
      <div
        ref={composite3DRef}
        className="absolute inset-0"
        style={{ transformStyle: 'preserve-3d', transformOrigin: 'center center' }}
      >
        <div
          ref={containerRef}
          className="absolute inset-0"
          style={{
            filter: (showShadow && shadowIntensity > 0)
              ? `drop-shadow(0 ${shadowIntensity * 12}px ${shadowIntensity * 48}px rgba(0,0,0,${shadowIntensity * 0.7})) drop-shadow(0 ${shadowIntensity * 4}px ${shadowIntensity * 16}px rgba(0,0,0,${shadowIntensity * 0.5})) drop-shadow(0 ${shadowIntensity * 2}px ${shadowIntensity * 8}px rgba(0,0,0,${shadowIntensity * 0.3}))`
              : 'none',
          }}
        />
        {pixiReady && videoReady && (
          <canvas
            ref={cursorCanvasRef}
            className="absolute inset-0 pointer-events-none"
          />
        )}
      </div>
      {/* Only render overlay after PIXI and video are fully initialized */}
      {pixiReady && videoReady && (
        <div
          ref={overlayRef}
          className="absolute inset-0 select-none"
          style={{ pointerEvents: 'none' }}
          onPointerDown={handleOverlayPointerDown}
          onPointerMove={handleOverlayPointerMove}
          onPointerUp={handleOverlayPointerUp}
          onPointerLeave={handleOverlayPointerLeave}
        >
          <div
            ref={focusIndicatorRef}
            className="absolute rounded-md border border-[#34B27B]/80 bg-[#34B27B]/20 shadow-[0_0_0_1px_rgba(52,178,123,0.35)]"
            style={{ display: 'none', pointerEvents: 'none' }}
          />
          {(() => {
            const timeMs = Math.round(currentTime * 1000);
            const sorted = getRenderableAnnotations(annotationRegions || [], timeMs);

            // Handle click-through cycling: when clicking same annotation, cycle to next
            const handleAnnotationClick = (clickedId: string) => {
              if (!onSelectAnnotation) return;
              
              // If clicking on already selected annotation and there are multiple overlapping
              if (clickedId === selectedAnnotationId && sorted.length > 1) {
                // Find current index and cycle to next
                const currentIndex = sorted.findIndex(a => a.id === clickedId);
                const nextIndex = (currentIndex + 1) % sorted.length;
                onSelectAnnotation(sorted[nextIndex].id);
              } else {
                // First click or clicking different annotation
                onSelectAnnotation(clickedId);
              }
            };
            
            return sorted.map((annotation) => (
              <AnnotationOverlay
                key={annotation.id}
                annotation={annotation}
                isSelected={annotation.id === selectedAnnotationId}
                containerWidth={overlaySize.width}
                containerHeight={overlaySize.height}
                currentTimeMs={timeMs}
                onPositionChange={(id, position) => onAnnotationPositionChange?.(id, position)}
                onSizeChange={(id, size) => onAnnotationSizeChange?.(id, size)}
                onClick={handleAnnotationClick}
                zIndex={annotation.zIndex}
              />
            ));
          })()}
          {activeSubtitleCue ? (
            <div className="absolute left-1/2 bottom-[6%] -translate-x-1/2 z-40 pointer-events-none max-w-[82%]">
              <div className="px-3 py-1.5 rounded-xl bg-black/70 backdrop-blur-[2px] border border-white/10 shadow-lg">
                <p className="text-white text-base leading-tight font-semibold text-center whitespace-pre-wrap break-words">
                  {activeSubtitleCue.text}
                </p>
              </div>
            </div>
          ) : null}
        </div>
      )}
      <video
        ref={videoRef}
        src={videoPath}
        className="hidden"
        preload="metadata"
        playsInline
        onLoadedMetadata={handleLoadedMetadata}
        onDurationChange={e => {
          onDurationChange(e.currentTarget.duration);
        }}
        onError={() => {
          const video = videoRef.current;
          const mediaError = video?.error;
          const mediaErrorMap: Record<number, string> = {
            1: "aborted",
            2: "network",
            3: "decode",
            4: "src_not_supported",
          };
          const errorCode = mediaError?.code ?? 0;
          const errorReason = mediaErrorMap[errorCode] ?? "unknown";
          const src = video?.currentSrc || videoPath;
          console.error("Video failed to load.", {
            errorCode,
            errorReason,
            src,
            readyState: video?.readyState,
            networkState: video?.networkState,
          });
          onError(`Failed to load video (code=${errorCode}, reason=${errorReason})`);
        }}
      />
    </div>
  );
});

VideoPlayback.displayName = 'VideoPlayback';

export default VideoPlayback;
