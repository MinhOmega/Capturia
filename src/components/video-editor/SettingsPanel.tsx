import { cn } from '@/lib/utils'
import { useEffect, useRef } from 'react'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { useState } from 'react'
import ColorPicker from '@/components/ui/color-picker'
import {
  Trash2,
  Download,
  Crop,
  X,
  Bug,
  Upload,
  Star,
  Film,
  Image,
  Sparkles,
  Palette,
  Captions,
  Scissors,
  ScanSearch,
  AudioWaveform,
  WandSparkles,
  Info,
  MousePointer2,
  ChevronDown,
  Lock,
  LockOpen,
  CopyCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import * as SliderPrimitive from '@radix-ui/react-slider'
import type {
  ZoomDepth,
  ZoomFocus,
  ZoomFocusMode,
  CropRegion,
  AnnotationRegion,
  AnnotationType,
  FigureData,
  Rotation3DPreset,
  ZoomTransitionMode,
} from './types'
import { ROTATION_3D_PRESET_ORDER } from './types'
import { MAX_PLAYBACK_SPEED, MAX_ZOOM_SCALE, MIN_ZOOM_SCALE, ZOOM_DEPTH_SCALES } from './types'
import { SEGMENT_SPEED_PRESETS, SegmentSpeedInput } from './SegmentSpeedInput'
import { getFocusBoundsForScale } from './videoPlayback/focusUtils'
import { CropControl } from './CropControl'
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp'
import { AnnotationSettingsPanel } from './AnnotationSettingsPanel'
import { ASPECT_RATIOS, type AspectRatio, getAspectRatioLabel } from '@/utils/aspectRatioUtils'
import {
  CROP_ASPECT_PRESETS,
  type CropAspectPreset,
  isCropAspectPreset,
} from '@/lib/crop/aspectCrop'
import type { ExportQuality, ExportFormat, GifFrameRate, GifSizePreset } from '@/lib/exporter'
import { GIF_FRAME_RATES, GIF_SIZE_PRESETS } from '@/lib/exporter'
import { normalizeExportSourceFrameRate } from '@/lib/exporter'
import type { ExportVideoCodec } from '@/lib/exporter/videoCodecSupport'

/** Quality presets in menu order, with the i18n key of each tile's label. */
const QUALITY_TILES: ReadonlyArray<{ value: ExportQuality; labelKey: string }> = [
  { value: 'medium', labelKey: 'settings.quality.low' },
  { value: 'good', labelKey: 'settings.quality.medium' },
  { value: 'source', labelKey: 'settings.quality.high' },
]

/** Codec choices. The names are trademarks and are never translated. */
const EXPORT_CODEC_TILES: ReadonlyArray<{ value: ExportVideoCodec; label: string }> = [
  { value: 'h264', label: 'H.264' },
  { value: 'hevc', label: 'H.265' },
]
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { useI18n } from '@/i18n'
import {
  DEFAULT_CURSOR_STYLE,
  type CursorMovementStyle,
  type CursorStyleConfig,
} from '@/lib/cursor'
import { GITHUB_ISSUES_URL, GITHUB_REPO_URL } from '@/lib/supportLinks'
import { reportUserActionError } from '@/lib/userErrorFeedback'
import { BACKGROUND_IMAGE_ACCEPT, isSupportedBackgroundImageType } from './backgroundImageUpload'
import { BACKGROUND_GRADIENT_PRESETS } from './backgroundPresets'
import { GradientEditor } from './GradientEditor'
import { BlurSettingsPanel } from './BlurSettingsPanel'
import { BLUR_REGIONS_ENABLED } from './featureFlags'
import type { BlurData } from './types'
import {
  DEFAULT_WALLPAPER,
  isSameBuiltInWallpaper,
  resolveWallpaperThumbUrl,
  WALLPAPER_PATHS,
} from '@/lib/wallpaper'
import {
  CAPTION_ENGINE_SETTINGS,
  type CaptionEngineSetting,
} from '@/lib/captioning/captionEngineSetting'
import { DEFAULT_CAPTION_MODEL_ID } from '@/lib/captioning/captionConstants'
import { CAPTION_LANGUAGE_AUTO } from '@/lib/captioning/captionTranscriptionSettings'
import type { SubtitleStyle } from '@/lib/rendering/subtitleStyle'
import { SubtitleStylePanel } from './SubtitleStylePanel'
import { TranscriptionQualityPanel } from './TranscriptionQualityPanel'
import { SubtitleCueEditor } from './SubtitleCueEditor'
import type { SubtitleCue } from '@/lib/analysis/types'
import { SUBTITLE_SIDECAR_FORMATS, type SubtitleSidecarFormat } from '@/lib/captions/subtitleExport'

const GRADIENTS = BACKGROUND_GRADIENT_PRESETS
const ZOOM_FOCUS_MODES: readonly ZoomFocusMode[] = ['manual', 'auto']
const ZOOM_TRANSITION_MODES: readonly ZoomTransitionMode[] = ['animated', 'instant']

interface SettingsPanelProps {
  selected: string
  onWallpaperChange: (path: string) => void
  selectedZoomDepth?: ZoomDepth | null
  onZoomDepthChange?: (depth: ZoomDepth) => void
  /** Continuous zoom scale of the selected region (customScale, or null when it follows the depth preset). */
  selectedZoomCustomScale?: number | null
  onZoomCustomScaleChange?: (scale: number) => void
  /** Fired when a slider drag / keyboard adjustment ends (one history entry per gesture). */
  onZoomCustomScaleCommit?: () => void
  /** Focus of the selected zoom region, shown in the precision X/Y inputs. */
  selectedZoomFocus?: ZoomFocus | null
  /** Live focus edits from the X/Y inputs (already inside the bounds for the effective scale). */
  onZoomFocusCoordinateChange?: (focus: ZoomFocus) => void
  /** Blur / Enter on an X/Y input: the typed value commits as one history entry. */
  onZoomFocusCoordinateCommit?: () => void
  /** Focus mode of the selected zoom ('auto' = camera follows the recorded cursor). */
  selectedZoomFocusMode?: ZoomFocusMode | null
  onZoomFocusModeChange?: (mode: ZoomFocusMode) => void
  /** Give every zoom of every aspect the selected zoom's level, as one undo entry. */
  onZoomApplyLevelToAll?: () => void
  /** Transition of the selected zoom ('instant' cuts in and out instead of easing). */
  selectedZoomTransition?: ZoomTransitionMode | null
  onZoomTransitionChange?: (transition: ZoomTransitionMode) => void
  /** 3D tilt preset of the selected zoom (null = flat). */
  selectedZoomRotationPreset?: Rotation3DPreset | null
  /** null clears the preset (back to flat). */
  onZoomRotationPresetChange?: (preset: Rotation3DPreset | null) => void
  /** Global "Auto-Focus all" toggle: every zoom follows the cursor; the per-zoom control is locked. */
  autoFocusAll?: boolean
  onToggleAutoFocusAll?: (enabled: boolean) => void
  /** Hold-to-preview: pointer/key down shows the zoomed camera at the playhead, up restores the unzoomed view. */
  onZoomPreviewStart?: () => void
  onZoomPreviewEnd?: () => void
  selectedZoomId?: string | null
  onZoomDelete?: (id: string) => void
  selectedSegment?: import('./types').VideoSegment | null
  /** Give every segment the selected segment's speed, as one undo entry. */
  onSegmentSpeedApplyToAll?: (speed: number) => void
  onDeleteSegment?: () => void
  onSegmentSpeedChange?: (id: string, speed: number) => void
  /** The typed speed is settled (blur / Enter): closes the caller's history batch. */
  onSegmentSpeedCommit?: () => void
  shadowIntensity?: number
  onShadowChange?: (intensity: number) => void
  showBlur?: boolean
  onBlurChange?: (showBlur: boolean) => void
  /** Zoom motion blur amount 0..1 (0 = off). */
  motionBlurAmount?: number
  onMotionBlurChange?: (amount: number) => void
  borderRadius?: number
  onBorderRadiusChange?: (radius: number) => void
  padding?: number
  onPaddingChange?: (padding: number) => void
  /** True for the 'native' aspect: padding is forced to 0 and the slider is locked. */
  paddingDisabled?: boolean
  cropRegion?: CropRegion
  onCropChange?: (region: CropRegion) => void
  /** Crop ratio select ('free' or a fixed ratio) and the aspect-lock switch. */
  cropAspectPreset?: CropAspectPreset
  cropAspectLocked?: boolean
  /** Pixel aspect the crop dialog's edge drags must keep (null = free-form). */
  cropLockAspectRatio?: number | null
  onCropAspectPresetChange?: (preset: CropAspectPreset) => void
  onCropAspectLockedChange?: (locked: boolean) => void
  aspectRatio: AspectRatio
  videoElement?: HTMLVideoElement | null
  exportQuality?: ExportQuality
  onExportQualityChange?: (quality: ExportQuality) => void
  /**
   * Resolved output size per quality tile for the current export aspect, from
   * `calculateMp4ExportPlan`. Shown under each tile so "Original (Best)" is not
   * a guess: on a 720p recording it is 720p, and the tile says so.
   */
  exportQualityDimensions?: Partial<Record<ExportQuality, { width: number; height: number }>>
  /** Frame rate the export will run at. */
  exportFrameRate?: number
  /** Rates offered, already filtered to the source (`getAvailableExportFrameRates`). */
  availableExportFrameRates?: number[]
  onExportFrameRateChange?: (frameRate: number) => void
  /** Probed source frame rate, for the "limited to N fps" hint. */
  sourceFrameRate?: number
  exportCodec?: ExportVideoCodec
  /** Codecs whose `VideoEncoder.isConfigSupported` probe passed. */
  availableExportCodecs?: ExportVideoCodec[]
  onExportCodecChange?: (codec: ExportVideoCodec) => void
  // Export format settings
  exportFormat?: ExportFormat
  onExportFormatChange?: (format: ExportFormat) => void
  exportAspectRatios?: AspectRatio[]
  onExportAspectRatiosChange?: (ratios: AspectRatio[]) => void
  onPreviewAspectRatioChange?: (ratio: AspectRatio) => void
  gifFrameRate?: GifFrameRate
  onGifFrameRateChange?: (rate: GifFrameRate) => void
  gifLoop?: boolean
  onGifLoopChange?: (loop: boolean) => void
  gifSizePreset?: GifSizePreset
  onGifSizePresetChange?: (preset: GifSizePreset) => void
  gifOutputDimensions?: { width: number; height: number }
  onExport?: () => void
  selectedAnnotationId?: string | null
  annotationRegions?: AnnotationRegion[]
  onAnnotationContentChange?: (id: string, content: string) => void
  onAnnotationTypeChange?: (id: string, type: AnnotationType) => void
  onAnnotationStyleChange?: (id: string, style: Partial<AnnotationRegion['style']>) => void
  onAnnotationFigureDataChange?: (id: string, figureData: FigureData) => void
  onAnnotationBlurDataChange?: (id: string, blurData: BlurData) => void
  onAnnotationDuplicate?: (id: string) => void
  onAnnotationDelete?: (id: string) => void
  hasAudioTrack?: boolean
  audioEnabled?: boolean
  onAudioEnabledChange?: (enabled: boolean) => void
  audioGain?: number
  onAudioGainChange?: (gain: number) => void
  audioNormalizeLoudness?: boolean
  onAudioNormalizeLoudnessChange?: (enabled: boolean) => void
  audioTargetLufs?: number
  onAudioTargetLufsChange?: (value: number) => void
  audioLimiterDb?: number
  onAudioLimiterDbChange?: (value: number) => void
  cursorStyle?: CursorStyleConfig
  onCursorStyleChange?: (style: CursorStyleConfig) => void
  hasCursorTrack?: boolean
  /** Auto-zoom wand: ON suggests zooms around existing regions, OFF removes only the suggested ones. */
  autoZoomEnabled?: boolean
  onToggleAutoZoom?: (enabled: boolean) => void
  autoEditDisabled?: boolean
  onAnalyzeCursor?: () => void
  cursorAnalysisProgress?: number | null
  onGenerateSubtitles?: () => void
  onApplyRoughCut?: () => void
  analysisRunning?: boolean
  subtitleCueCount?: number
  roughCutSuggestionCount?: number
  /** C-1: which engine "Generate Subtitles" uses (native macOS speech / on-device Whisper). */
  captionEngine?: CaptionEngineSetting
  onCaptionEngineChange?: (engine: CaptionEngineSetting) => void
  /** P2-F4: transcription quality - Whisper weights, forced language, vocabulary hint. */
  captionModelId?: string
  onCaptionModelIdChange?: (modelId: string) => void
  captionLanguage?: string
  onCaptionLanguageChange?: (language: string) => void
  captionVocabulary?: string
  onCaptionVocabularyChange?: (vocabulary: string) => void
  /** P2-F1: caption look, shared by the preview overlay and the export renderer. */
  subtitleStyle?: SubtitleStyle
  onSubtitleStyleChange?: (patch: Partial<SubtitleStyle>) => void
  /** P2-F2: the caption track and the cue selected on the timeline. */
  subtitleCues?: SubtitleCue[]
  selectedSubtitleCueId?: string | null
  onSelectSubtitleCue?: (id: string | null) => void
  onSubtitleCueTextChange?: (id: string, text: string) => void
  onSubtitleCueSplit?: (id: string) => void
  onSubtitleCueMergeNext?: (id: string) => void
  onSubtitleCueMergePrevious?: (id: string) => void
  onSubtitleCueDelete?: (id: string) => void
  /** P2-F3: which caption sidecars are written next to the export. */
  captionSidecarFormats?: SubtitleSidecarFormat[]
  onCaptionSidecarFormatsChange?: (formats: SubtitleSidecarFormat[]) => void
  seekStepSeconds?: number
  onSeekStepSecondsChange?: (step: number) => void
  // Timeline section (W2-b)
  showTimelineWaveform?: boolean
  onTimelineWaveformChange?: (show: boolean) => void
}

export default SettingsPanel

const ZOOM_DEPTH_OPTIONS: Array<{ depth: ZoomDepth; label: string }> = [
  { depth: 1, label: '1.25×' },
  { depth: 2, label: '1.5×' },
  { depth: 3, label: '1.8×' },
  { depth: 4, label: '2.2×' },
  { depth: 5, label: '3.5×' },
  { depth: 6, label: '5×' },
]

/**
 * Percentage input for one zoom-focus axis. While focused it keeps a local draft
 * so partial entries ("5", "") survive re-renders; when not focused it mirrors
 * the live prop so overlay drags update the number. Blur / Enter commits.
 */
function ZoomFocusCoordInput({
  percent,
  onChange,
  onCommit,
  disabled,
  ariaLabel,
}: {
  percent: number
  onChange: (nextPercent: number) => void
  onCommit?: () => void
  disabled?: boolean
  ariaLabel: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const display = percent.toFixed(1)

  return (
    <input
      type="number"
      inputMode="decimal"
      min={0}
      max={100}
      step={0.1}
      value={draft ?? display}
      disabled={disabled}
      aria-label={ariaLabel}
      onFocus={() => setDraft(display)}
      onChange={(e) => {
        const next = e.target.value
        setDraft(next)
        const parsed = Number(next)
        if (next !== '' && Number.isFinite(parsed)) {
          onChange(Math.min(100, Math.max(0, parsed)))
        }
      }}
      onBlur={() => {
        setDraft(null)
        onCommit?.()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      className="h-7 w-full rounded-md border border-white/10 bg-white/5 px-2 text-[11px] text-slate-200 outline-none focus:border-[#34B27B]/50 focus:ring-1 focus:ring-[#34B27B]/30 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none disabled:opacity-50 disabled:cursor-not-allowed"
    />
  )
}

const CURSOR_MOVEMENT_PRESETS: Array<{
  style: Exclude<CursorMovementStyle, 'custom'>
  smoothingMs: number
  labelKey: string
}> = [
  { style: 'rapid', smoothingMs: 0, labelKey: 'settings.cursorMovementRapid' },
  { style: 'quick', smoothingMs: 36, labelKey: 'settings.cursorMovementQuick' },
  { style: 'default', smoothingMs: 78, labelKey: 'settings.cursorMovementDefault' },
  { style: 'slow', smoothingMs: 130, labelKey: 'settings.cursorMovementSlow' },
]

export function SettingsPanel({
  selected,
  onWallpaperChange,
  selectedZoomDepth,
  onZoomDepthChange,
  selectedZoomCustomScale = null,
  onZoomCustomScaleChange,
  onZoomCustomScaleCommit,
  selectedZoomFocus = null,
  onZoomFocusCoordinateChange,
  onZoomFocusCoordinateCommit,
  selectedZoomFocusMode = null,
  onZoomFocusModeChange,
  onZoomApplyLevelToAll,
  selectedZoomTransition = null,
  onZoomTransitionChange,
  selectedZoomRotationPreset = null,
  onZoomRotationPresetChange,
  autoFocusAll = false,
  onToggleAutoFocusAll,
  onZoomPreviewStart,
  onZoomPreviewEnd,
  selectedZoomId,
  onZoomDelete,
  selectedSegment = null,
  onSegmentSpeedApplyToAll,
  onDeleteSegment,
  onSegmentSpeedChange,
  onSegmentSpeedCommit,
  shadowIntensity = 0,
  onShadowChange,
  showBlur,
  onBlurChange,
  motionBlurAmount = 0,
  onMotionBlurChange,
  borderRadius = 0,
  onBorderRadiusChange,
  padding = 50,
  onPaddingChange,
  paddingDisabled = false,
  cropRegion,
  onCropChange,
  cropAspectPreset = 'free',
  cropAspectLocked = false,
  cropLockAspectRatio = null,
  onCropAspectPresetChange,
  onCropAspectLockedChange,
  aspectRatio,
  videoElement,
  exportQuality = 'good',
  onExportQualityChange,
  exportQualityDimensions,
  exportFrameRate,
  availableExportFrameRates = [],
  onExportFrameRateChange,
  sourceFrameRate,
  exportCodec = 'h264',
  availableExportCodecs = ['h264'],
  onExportCodecChange,
  exportFormat = 'mp4',
  onExportFormatChange,
  exportAspectRatios = [],
  onExportAspectRatiosChange,
  onPreviewAspectRatioChange,
  gifFrameRate = 15,
  onGifFrameRateChange,
  gifLoop = true,
  onGifLoopChange,
  gifSizePreset = 'medium',
  onGifSizePresetChange,
  gifOutputDimensions = { width: 1280, height: 720 },
  onExport,
  selectedAnnotationId,
  annotationRegions = [],
  onAnnotationContentChange,
  onAnnotationTypeChange,
  onAnnotationStyleChange,
  onAnnotationFigureDataChange,
  onAnnotationBlurDataChange,
  onAnnotationDuplicate,
  onAnnotationDelete,
  hasAudioTrack = true,
  audioEnabled = true,
  onAudioEnabledChange,
  audioGain = 1,
  onAudioGainChange,
  audioNormalizeLoudness = true,
  onAudioNormalizeLoudnessChange,
  audioTargetLufs = -16,
  onAudioTargetLufsChange,
  audioLimiterDb = -1,
  onAudioLimiterDbChange,
  cursorStyle = DEFAULT_CURSOR_STYLE,
  onCursorStyleChange,
  hasCursorTrack = true,
  autoZoomEnabled = true,
  onToggleAutoZoom,
  autoEditDisabled = false,
  onAnalyzeCursor,
  cursorAnalysisProgress = null,
  onGenerateSubtitles,
  onApplyRoughCut,
  analysisRunning = false,
  subtitleCueCount = 0,
  roughCutSuggestionCount = 0,
  captionEngine = 'auto',
  onCaptionEngineChange,
  captionModelId = DEFAULT_CAPTION_MODEL_ID,
  onCaptionModelIdChange,
  captionLanguage = CAPTION_LANGUAGE_AUTO,
  onCaptionLanguageChange,
  captionVocabulary = '',
  onCaptionVocabularyChange,
  subtitleStyle,
  onSubtitleStyleChange,
  subtitleCues = [],
  selectedSubtitleCueId = null,
  onSelectSubtitleCue,
  onSubtitleCueTextChange,
  onSubtitleCueSplit,
  onSubtitleCueMergeNext,
  onSubtitleCueMergePrevious,
  onSubtitleCueDelete,
  captionSidecarFormats = [],
  onCaptionSidecarFormatsChange,
  seekStepSeconds = 5,
  onSeekStepSecondsChange,
  showTimelineWaveform = false,
  onTimelineWaveformChange,
}: SettingsPanelProps) {
  const { t } = useI18n()
  const [wallpaperPaths, setWallpaperPaths] = useState<string[]>([])
  const [customImages, setCustomImages] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const openSupportUrl = async (url: string, context: string) => {
    try {
      const result = await window.electronAPI.openExternalUrl(url)
      if (!result.success) {
        throw new Error(result.error || 'openExternalUrl returned unsuccessful result')
      }
    } catch (error) {
      reportUserActionError({
        t,
        userMessage: t('common.error.reportOpenFailed'),
        error,
        context,
        details: { url },
        dedupeKey: context,
      })
    }
  }

  // The grid paints the small pre-generated thumbs (see WALLPAPER_THUMB_PATHS),
  // never the originals; the value handed to onWallpaperChange stays the
  // canonical "/wallpapers/wallpaperN.jpg" so projects persist portably and
  // only the selected wallpaper is decoded at full size (by the preview).
  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const resolved = await Promise.all(
          WALLPAPER_PATHS.map(async (p) => (await resolveWallpaperThumbUrl(p)) ?? p),
        )
        if (mounted) setWallpaperPaths(resolved)
      } catch {
        if (mounted) setWallpaperPaths([...WALLPAPER_PATHS])
      }
    })()
    return () => {
      mounted = false
    }
  }, [])
  const colorPalette = [
    '#FF0000',
    '#FFD700',
    '#00FF00',
    '#FFFFFF',
    '#0000FF',
    '#FF6B00',
    '#9B59B6',
    '#E91E63',
    '#00BCD4',
    '#FF5722',
    '#8BC34A',
    '#FFC107',
    '#34B27B',
    '#000000',
    '#607D8B',
    '#795548',
  ]

  const [selectedColor, setSelectedColor] = useState('#ADADAD')
  const [gradient, setGradient] = useState<string>(GRADIENTS[0])
  const [showGradientEditor, setShowGradientEditor] = useState(false)
  const [showCropDropdown, setShowCropDropdown] = useState(false)
  const activeExportAspectRatios = exportAspectRatios

  const zoomEnabled = Boolean(selectedZoomDepth)
  // Effective scale of the selected zoom: customScale wins over the depth preset
  // (mirrors getZoomScale). Drives the badge, the active preset and the slider.
  const effectiveZoomScale =
    selectedZoomCustomScale ??
    (selectedZoomDepth ? ZOOM_DEPTH_SCALES[selectedZoomDepth] : MIN_ZOOM_SCALE)
  const effectiveZoomScaleLabel = `${
    Number.isInteger(effectiveZoomScale)
      ? effectiveZoomScale.toFixed(0)
      : effectiveZoomScale.toFixed(2).replace(/0$/, '')
  }×`
  const segmentSelected = Boolean(selectedSegment)

  const handleDeleteClick = () => {
    if (selectedZoomId && onZoomDelete) {
      onZoomDelete(selectedZoomId)
    }
  }

  const toggleExportAspectRatio = (ratio: AspectRatio) => {
    onPreviewAspectRatioChange?.(ratio)
    if (!onExportAspectRatiosChange) return
    const currentlySelected = activeExportAspectRatios.includes(ratio)

    const nextSelection = new Set(activeExportAspectRatios)
    if (currentlySelected) {
      nextSelection.delete(ratio)
    } else {
      nextSelection.add(ratio)
    }

    const ordered = ASPECT_RATIOS.filter((candidate) => nextSelection.has(candidate))
    onExportAspectRatiosChange(ordered)
  }

  const updateCursorStyle = (patch: Partial<CursorStyleConfig>) => {
    if (!onCursorStyleChange) return
    onCursorStyleChange({
      ...cursorStyle,
      ...patch,
    })
  }

  const applyMovementPreset = (style: Exclude<CursorMovementStyle, 'custom'>) => {
    const preset = CURSOR_MOVEMENT_PRESETS.find((item) => item.style === style)
    if (!preset) return
    updateCursorStyle({
      movementStyle: preset.style,
      smoothingMs: preset.smoothingMs,
    })
  }

  const activeMovementStyle: CursorMovementStyle = cursorStyle.movementStyle ?? 'custom'

  const formatSignedPx = (value: number) => {
    const rounded = Math.round(value)
    return `${rounded > 0 ? '+' : ''}${rounded}px`
  }

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files || files.length === 0) return

    const file = files[0]

    // Validate file type - JPG/JPEG/PNG only
    if (!isSupportedBackgroundImageType(file.type, file.name)) {
      toast.error(t('settings.fileTypeInvalid'), {
        description: t('settings.uploadJpgOnly'),
      })
      event.target.value = ''
      return
    }

    const reader = new FileReader()

    reader.onload = (e) => {
      const dataUrl = e.target?.result as string
      if (dataUrl) {
        setCustomImages((prev) => [...prev, dataUrl])
        onWallpaperChange(dataUrl)
        toast.success(t('settings.uploadOk'))
      }
    }

    reader.onerror = () => {
      toast.error(t('settings.uploadFailed'), {
        description: t('settings.uploadReadError'),
      })
    }

    reader.readAsDataURL(file)
    // Reset input so the same file can be selected again
    event.target.value = ''
  }

  const handleRemoveCustomImage = (imageUrl: string, event: React.MouseEvent) => {
    event.stopPropagation()
    setCustomImages((prev) => prev.filter((img) => img !== imageUrl))
    // If the removed image was selected, clear selection
    if (selected === imageUrl) {
      onWallpaperChange(DEFAULT_WALLPAPER)
    }
  }

  // Find selected annotation
  const selectedAnnotation = selectedAnnotationId
    ? annotationRegions.find((a) => a.id === selectedAnnotationId)
    : null

  // A selected blur region gets its own panel (shape, shade, block size).
  if (
    BLUR_REGIONS_ENABLED &&
    selectedAnnotation?.type === 'blur' &&
    onAnnotationBlurDataChange &&
    onAnnotationDelete
  ) {
    return (
      <BlurSettingsPanel
        blurRegion={selectedAnnotation}
        onBlurDataChange={(blurData) => onAnnotationBlurDataChange(selectedAnnotation.id, blurData)}
        onDuplicate={
          onAnnotationDuplicate ? () => onAnnotationDuplicate(selectedAnnotation.id) : undefined
        }
        onDelete={() => onAnnotationDelete(selectedAnnotation.id)}
      />
    )
  }

  // If an annotation is selected, show annotation settings instead
  if (
    selectedAnnotation &&
    selectedAnnotation.type !== 'blur' &&
    onAnnotationContentChange &&
    onAnnotationTypeChange &&
    onAnnotationStyleChange &&
    onAnnotationDelete
  ) {
    return (
      <AnnotationSettingsPanel
        annotation={selectedAnnotation}
        onContentChange={(content) => onAnnotationContentChange(selectedAnnotation.id, content)}
        onTypeChange={(type) => onAnnotationTypeChange(selectedAnnotation.id, type)}
        onStyleChange={(style) => onAnnotationStyleChange(selectedAnnotation.id, style)}
        onFigureDataChange={
          onAnnotationFigureDataChange
            ? (figureData) => onAnnotationFigureDataChange(selectedAnnotation.id, figureData)
            : undefined
        }
        onDuplicate={
          onAnnotationDuplicate ? () => onAnnotationDuplicate(selectedAnnotation.id) : undefined
        }
        onDelete={() => onAnnotationDelete(selectedAnnotation.id)}
      />
    )
  }

  return (
    <div className="w-full min-w-0 bg-[#09090b] border border-white/5 rounded-2xl flex flex-col shadow-xl h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 pb-0">
        <div className="mb-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-slate-200">{t('settings.zoomLevel')}</span>
            <div className="flex items-center gap-2">
              {zoomEnabled && selectedZoomDepth && (
                <span className="text-[10px] uppercase tracking-wider font-medium text-[#34B27B] bg-[#34B27B]/10 px-2 py-0.5 rounded-full">
                  {effectiveZoomScaleLabel}
                </span>
              )}
              <KeyboardShortcutsHelp />
            </div>
          </div>
          <div className="grid grid-cols-6 gap-1.5">
            {ZOOM_DEPTH_OPTIONS.map((option) => {
              // A preset is "active" when the effective scale equals it, so a custom
              // scale that lands exactly on a preset lights that preset up.
              const isActive =
                zoomEnabled &&
                Math.abs(effectiveZoomScale - ZOOM_DEPTH_SCALES[option.depth]) < 0.005
              return (
                <Button
                  key={option.depth}
                  type="button"
                  disabled={!zoomEnabled}
                  onClick={() => onZoomDepthChange?.(option.depth)}
                  className={cn(
                    'h-auto w-full rounded-lg border px-1 py-2 text-center shadow-sm transition-all',
                    'duration-200 ease-out',
                    zoomEnabled ? 'opacity-100 cursor-pointer' : 'opacity-40 cursor-not-allowed',
                    isActive
                      ? 'border-[#34B27B] bg-[#34B27B] text-white shadow-[#34B27B]/20'
                      : 'border-white/5 bg-white/5 text-slate-400 hover:bg-white/10 hover:border-white/10 hover:text-slate-200',
                  )}
                >
                  <span className="text-xs font-semibold">{option.label}</span>
                </Button>
              )
            })}
          </div>
          {!zoomEnabled && (
            <p className="text-[10px] text-slate-500 mt-2 text-center">
              {t('settings.selectZoomToAdjust')}
            </p>
          )}
          {zoomEnabled && onZoomApplyLevelToAll && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onZoomApplyLevelToAll()}
              className="mt-2 w-full gap-2 bg-white/5 text-slate-300 border border-white/10 hover:bg-white/10 hover:border-white/20 hover:text-white transition-all h-8 text-xs"
            >
              <CopyCheck className="w-3 h-3" />
              {t('settings.zoomApplyLevelToAll')}
            </Button>
          )}
          {zoomEnabled && onZoomCustomScaleChange && (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] font-medium text-slate-400">
                  {t('settings.zoomCustomScale')}
                </span>
                <span className="text-[11px] font-semibold text-slate-300 tabular-nums">
                  {effectiveZoomScale.toFixed(2)}×
                </span>
              </div>
              <SliderPrimitive.Root
                min={MIN_ZOOM_SCALE}
                max={MAX_ZOOM_SCALE}
                step={0.01}
                value={[effectiveZoomScale]}
                onValueChange={(values) => onZoomCustomScaleChange(values[0])}
                onValueCommit={() => onZoomCustomScaleCommit?.()}
                disabled={!zoomEnabled}
                aria-label={t('settings.zoomCustomScale')}
                className="relative flex w-full touch-none select-none items-center py-1"
              >
                <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full border border-white/10 bg-white/5">
                  <SliderPrimitive.Range
                    className={cn(
                      'absolute h-full transition-colors duration-150',
                      selectedZoomCustomScale != null ? 'bg-[#34B27B]' : 'bg-white/20',
                    )}
                  />
                </SliderPrimitive.Track>
                <SliderPrimitive.Thumb
                  className={cn(
                    'block h-3.5 w-3.5 rounded-full border-2 shadow transition-all duration-150',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#34B27B]/50',
                    'disabled:pointer-events-none disabled:opacity-50 cursor-grab active:cursor-grabbing',
                    selectedZoomCustomScale != null
                      ? 'border-[#34B27B] bg-[#34B27B] shadow-[0_0_6px_rgba(52,178,123,0.4)]'
                      : 'border-white/20 bg-[#2a2a30] hover:border-white/40',
                  )}
                />
              </SliderPrimitive.Root>
              <div className="flex justify-between text-[10px] text-slate-600 mt-1">
                <span>{MIN_ZOOM_SCALE.toFixed(1)}×</span>
                <span>{MAX_ZOOM_SCALE.toFixed(1)}×</span>
              </div>
            </div>
          )}
          {zoomEnabled && hasCursorTrack && onZoomFocusModeChange && (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-medium text-slate-400">
                  {t('settings.zoomFocusMode')}
                </span>
                <div
                  role="radiogroup"
                  aria-label={t('settings.zoomFocusMode')}
                  className="grid w-32 grid-cols-2 gap-0.5 rounded-lg border border-white/[0.06] bg-white/[0.035] p-0.5"
                >
                  {ZOOM_FOCUS_MODES.map((mode) => {
                    const isActive = (selectedZoomFocusMode ?? 'manual') === mode
                    const label =
                      mode === 'auto'
                        ? t('settings.zoomFocusModeAuto')
                        : t('settings.zoomFocusModeManual')
                    return (
                      <Button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={isActive}
                        disabled={autoFocusAll}
                        title={
                          mode === 'auto' ? t('settings.zoomFocusModeAutoDescription') : undefined
                        }
                        onClick={() => !autoFocusAll && onZoomFocusModeChange(mode)}
                        className={cn(
                          'h-6 w-full rounded-md border px-1 text-center transition-all duration-150 ease-out',
                          isActive
                            ? 'border-[#34B27B]/50 bg-[#34B27B] text-white hover:bg-[#34B27B]'
                            : 'border-transparent bg-transparent text-slate-400 hover:bg-white/[0.06] hover:text-slate-200',
                          autoFocusAll ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                        )}
                      >
                        <span className="text-[10px] font-semibold">{label}</span>
                      </Button>
                    )
                  })}
                </div>
              </div>
              {autoFocusAll && (
                <div className="flex items-start gap-1 text-[10px] leading-snug text-slate-500">
                  <Info size={11} className="mt-px shrink-0" />
                  <span>{t('settings.zoomFocusModeLockedDisclaimer')}</span>
                </div>
              )}
            </div>
          )}
          {zoomEnabled && onZoomTransitionChange && (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-medium text-slate-400">
                  {t('settings.zoomTransition')}
                </span>
                <div
                  role="radiogroup"
                  aria-label={t('settings.zoomTransition')}
                  className="grid w-32 grid-cols-2 gap-0.5 rounded-lg border border-white/[0.06] bg-white/[0.035] p-0.5"
                >
                  {ZOOM_TRANSITION_MODES.map((mode) => {
                    const isActive = (selectedZoomTransition ?? 'animated') === mode
                    return (
                      <Button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={isActive}
                        title={
                          mode === 'instant'
                            ? t('settings.zoomTransitionInstantDescription')
                            : undefined
                        }
                        onClick={() => onZoomTransitionChange(mode)}
                        className={cn(
                          'h-6 w-full rounded-md border px-1 text-center transition-all duration-150 ease-out cursor-pointer',
                          isActive
                            ? 'border-[#34B27B]/50 bg-[#34B27B] text-white hover:bg-[#34B27B]'
                            : 'border-transparent bg-transparent text-slate-400 hover:bg-white/[0.06] hover:text-slate-200',
                        )}
                      >
                        <span className="text-[10px] font-semibold">
                          {mode === 'instant'
                            ? t('settings.zoomTransitionInstant')
                            : t('settings.zoomTransitionAnimated')}
                        </span>
                      </Button>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
          {zoomEnabled && onZoomRotationPresetChange && (
            <div className="mt-3 space-y-1.5">
              <span className="text-[11px] font-medium text-slate-400 block">
                {t('settings.zoom3dTitle')}
              </span>
              <div
                role="radiogroup"
                aria-label={t('settings.zoom3dTitle')}
                className="grid grid-cols-4 gap-0.5 rounded-lg border border-white/[0.06] bg-white/[0.035] p-0.5"
              >
                {([null, ...ROTATION_3D_PRESET_ORDER] as Array<Rotation3DPreset | null>).map(
                  (preset) => {
                    const isActive = (selectedZoomRotationPreset ?? null) === preset
                    const label =
                      preset === null
                        ? t('settings.zoom3dNone')
                        : preset === 'iso'
                          ? t('settings.zoom3dIso')
                          : preset === 'left'
                            ? t('settings.zoom3dLeft')
                            : t('settings.zoom3dRight')
                    return (
                      <Button
                        key={preset ?? 'none'}
                        type="button"
                        role="radio"
                        aria-checked={isActive}
                        onClick={() => onZoomRotationPresetChange(preset)}
                        className={cn(
                          'h-6 w-full rounded-md border px-1 text-center transition-all duration-150 ease-out cursor-pointer',
                          isActive
                            ? 'border-[#34B27B]/50 bg-[#34B27B] text-white hover:bg-[#34B27B]'
                            : 'border-transparent bg-transparent text-slate-400 hover:bg-white/[0.06] hover:text-slate-200',
                        )}
                      >
                        <span className="text-[10px] font-semibold">{label}</span>
                      </Button>
                    )
                  },
                )}
              </div>
            </div>
          )}
          {zoomEnabled && onZoomPreviewStart && onZoomPreviewEnd && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onPointerDown={() => onZoomPreviewStart()}
              onPointerUp={() => onZoomPreviewEnd()}
              onPointerLeave={() => onZoomPreviewEnd()}
              onPointerCancel={() => onZoomPreviewEnd()}
              onKeyDown={(e) => {
                if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                  e.preventDefault()
                  onZoomPreviewStart()
                }
              }}
              onKeyUp={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault()
                  onZoomPreviewEnd()
                }
              }}
              onBlur={() => onZoomPreviewEnd()}
              className="mt-2 w-full select-none gap-2 bg-white/5 text-slate-300 border border-white/10 hover:bg-white/10 hover:border-white/20 hover:text-white active:border-[#34B27B]/50 active:bg-[#34B27B] active:text-white transition-all h-8 text-xs"
            >
              <ScanSearch className="w-3 h-3" />
              {t('settings.zoomPreviewHold')}
            </Button>
          )}
          {zoomEnabled &&
            selectedZoomFocus &&
            onZoomFocusCoordinateChange &&
            selectedZoomFocusMode !== 'auto' &&
            (() => {
              // 0-100 % spans the focus range allowed at the effective scale, so the
              // typed value always lands on a reachable position.
              const bounds = getFocusBoundsForScale(effectiveZoomScale)
              const xRange = bounds.maxX - bounds.minX
              const yRange = bounds.maxY - bounds.minY
              const toPercent = (value: number, min: number, range: number) =>
                range <= 0 ? 50 : Math.max(0, Math.min(100, ((value - min) / range) * 100))
              const fromPercent = (p: number, min: number, range: number) =>
                range <= 0 ? min : min + (p / 100) * range
              return (
                <div className="mt-3">
                  <span className="text-[11px] font-medium text-slate-400 mb-1.5 block">
                    {t('settings.zoomFocusPosition')}
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">
                        {t('settings.zoomFocusX')}
                      </label>
                      <ZoomFocusCoordInput
                        ariaLabel={t('settings.zoomFocusX')}
                        percent={toPercent(selectedZoomFocus.cx, bounds.minX, xRange)}
                        onChange={(p) =>
                          onZoomFocusCoordinateChange({
                            cx: fromPercent(p, bounds.minX, xRange),
                            cy: selectedZoomFocus.cy,
                          })
                        }
                        onCommit={onZoomFocusCoordinateCommit}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">
                        {t('settings.zoomFocusY')}
                      </label>
                      <ZoomFocusCoordInput
                        ariaLabel={t('settings.zoomFocusY')}
                        percent={toPercent(selectedZoomFocus.cy, bounds.minY, yRange)}
                        onChange={(p) =>
                          onZoomFocusCoordinateChange({
                            cx: selectedZoomFocus.cx,
                            cy: fromPercent(p, bounds.minY, yRange),
                          })
                        }
                        onCommit={onZoomFocusCoordinateCommit}
                      />
                    </div>
                  </div>
                </div>
              )
            })()}
          {zoomEnabled && (
            <Button
              onClick={handleDeleteClick}
              variant="destructive"
              size="sm"
              className="mt-2 w-full gap-2 bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 hover:border-red-500/30 transition-all h-8 text-xs"
            >
              <Trash2 className="w-3 h-3" />
              {t('settings.deleteZoom')}
            </Button>
          )}
          <Button
            type="button"
            onClick={() => onToggleAutoZoom?.(!autoZoomEnabled)}
            variant="outline"
            size="sm"
            disabled={autoEditDisabled}
            aria-pressed={autoZoomEnabled}
            title={autoZoomEnabled ? t('settings.autoZoomOn') : t('settings.autoZoomOff')}
            className={cn(
              'mt-2 w-full gap-2 border transition-all h-8 text-xs disabled:opacity-50',
              autoZoomEnabled
                ? 'bg-[#34B27B]/15 text-[#34B27B] border-[#34B27B]/30 hover:bg-[#34B27B]/25 hover:border-[#34B27B]/40 hover:text-[#34B27B]'
                : 'bg-white/5 text-slate-200 border-white/10 hover:bg-white/10 hover:border-white/20 hover:text-white',
            )}
          >
            <WandSparkles className="w-3 h-3" />
            {t('settings.autoEdit')}
          </Button>
          {hasCursorTrack && onToggleAutoFocusAll && (
            <Button
              type="button"
              onClick={() => onToggleAutoFocusAll(!autoFocusAll)}
              variant="outline"
              size="sm"
              aria-pressed={autoFocusAll}
              title={autoFocusAll ? t('settings.autoFocusAllOn') : t('settings.autoFocusAllOff')}
              className={cn(
                'mt-2 w-full gap-2 border transition-all h-8 text-xs disabled:opacity-50',
                autoFocusAll
                  ? 'bg-[#34B27B]/15 text-[#34B27B] border-[#34B27B]/30 hover:bg-[#34B27B]/25 hover:border-[#34B27B]/40 hover:text-[#34B27B]'
                  : 'bg-white/5 text-slate-200 border-white/10 hover:bg-white/10 hover:border-white/20 hover:text-white',
              )}
            >
              <MousePointer2 className="w-3 h-3" />
              {t('settings.autoFocusAll')}
            </Button>
          )}
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button
              onClick={() => onGenerateSubtitles?.()}
              variant="outline"
              size="sm"
              disabled={analysisRunning}
              className="gap-1.5 bg-white/5 text-slate-200 border border-white/10 hover:bg-white/10 hover:border-white/20 hover:text-white transition-all h-8 text-[10px] disabled:opacity-50"
            >
              <Captions className="w-3 h-3 text-[#34B27B]" />
              {t('settings.generateSubtitles')}
            </Button>
            <Button
              onClick={() => onApplyRoughCut?.()}
              variant="outline"
              size="sm"
              disabled={analysisRunning || roughCutSuggestionCount <= 0}
              className="gap-1.5 bg-white/5 text-slate-200 border border-white/10 hover:bg-white/10 hover:border-white/20 hover:text-white transition-all h-8 text-[10px] disabled:opacity-50"
            >
              <Scissors className="w-3 h-3 text-[#34B27B]" />
              {t('settings.applyRoughCut')}
            </Button>
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500 px-1">
            <span>
              {t('timeline.subtitle')}: {subtitleCueCount}
            </span>
            <span>
              {t('settings.applyRoughCut')}: {roughCutSuggestionCount}
            </span>
          </div>
          {onCaptionEngineChange && (
            <div className="mt-2 px-1">
              <div className="flex items-center justify-between text-[10px] text-slate-500">
                <span>{t('settings.captionsEngine')}</span>
              </div>
              <div
                className="mt-1 grid grid-cols-3 gap-1"
                role="radiogroup"
                aria-label={t('settings.captionsEngine')}
              >
                {CAPTION_ENGINE_SETTINGS.map((engine) => (
                  <button
                    key={engine}
                    type="button"
                    role="radio"
                    aria-checked={captionEngine === engine}
                    disabled={analysisRunning}
                    onClick={() => onCaptionEngineChange(engine)}
                    title={t(
                      `settings.captionsEngine${engine === 'auto' ? 'Auto' : engine === 'native' ? 'Native' : 'Whisper'}Hint`,
                    )}
                    className={cn(
                      'h-7 rounded-md border text-[10px] transition-all disabled:opacity-50',
                      captionEngine === engine
                        ? 'bg-[#34B27B]/15 text-[#34B27B] border-[#34B27B]/30'
                        : 'bg-white/5 text-slate-300 border-white/10 hover:bg-white/10 hover:border-white/20 hover:text-white',
                    )}
                  >
                    {t(
                      `settings.captionsEngine${engine === 'auto' ? 'Auto' : engine === 'native' ? 'Native' : 'Whisper'}`,
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
          {onCaptionModelIdChange && onCaptionLanguageChange && onCaptionVocabularyChange && (
            <TranscriptionQualityPanel
              modelId={captionModelId}
              onModelIdChange={onCaptionModelIdChange}
              language={captionLanguage}
              onLanguageChange={onCaptionLanguageChange}
              vocabulary={captionVocabulary}
              onVocabularyChange={onCaptionVocabularyChange}
              disabled={analysisRunning}
            />
          )}
          {subtitleStyle && onSubtitleStyleChange && (
            <SubtitleStylePanel
              style={subtitleStyle}
              onChange={onSubtitleStyleChange}
              disabled={analysisRunning}
            />
          )}
          {onSelectSubtitleCue &&
            onSubtitleCueTextChange &&
            onSubtitleCueSplit &&
            onSubtitleCueMergeNext &&
            onSubtitleCueMergePrevious &&
            onSubtitleCueDelete && (
              <SubtitleCueEditor
                cues={subtitleCues}
                selectedCueId={selectedSubtitleCueId}
                onSelectCue={onSelectSubtitleCue}
                onTextChange={onSubtitleCueTextChange}
                onSplit={onSubtitleCueSplit}
                onMergeNext={onSubtitleCueMergeNext}
                onMergePrevious={onSubtitleCueMergePrevious}
                onDelete={onSubtitleCueDelete}
                disabled={analysisRunning}
              />
            )}
        </div>

        {segmentSelected && selectedSegment && (
          <div className="mb-4 rounded-xl bg-white/[0.02] border border-white/5 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium text-slate-300">
                {t('timeline.segmentSpeed')}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-500 tabular-nums">
                  {(selectedSegment.startMs / 1000).toFixed(1)}s –{' '}
                  {(selectedSegment.endMs / 1000).toFixed(1)}s
                </span>
                <span className="text-[10px] tabular-nums">
                  <span className="text-slate-400">
                    {((selectedSegment.endMs - selectedSegment.startMs) / 1000).toFixed(1)}s
                  </span>
                  {selectedSegment.speed !== 1 && (
                    <span className="text-[#34B27B]">
                      {' → '}
                      {(
                        (selectedSegment.endMs - selectedSegment.startMs) /
                        1000 /
                        selectedSegment.speed
                      ).toFixed(1)}
                      s
                    </span>
                  )}
                </span>
              </div>
            </div>

            {/* Speed preset grid */}
            <div className="flex flex-wrap gap-1">
              {SEGMENT_SPEED_PRESETS.map((speed) => (
                <button
                  key={speed}
                  onClick={() => {
                    // A preset click is one settled edit: change then commit,
                    // so it never joins the typed field's history batch.
                    onSegmentSpeedChange?.(selectedSegment.id, speed)
                    onSegmentSpeedCommit?.()
                  }}
                  className={cn(
                    'px-2 py-1 rounded text-[10px] font-medium transition-colors',
                    selectedSegment.speed === speed
                      ? 'bg-[#34B27B] text-white'
                      : 'bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white border border-white/5',
                  )}
                >
                  {speed}x
                </button>
              ))}
            </div>

            {/* Custom speed input; keyed by segment so a new selection never shows a stale draft */}
            <div className="flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.03] px-2 py-1.5">
              <span className="text-[10px] text-slate-500">
                {t('settings.customPlaybackSpeed')}
              </span>
              <SegmentSpeedInput
                key={selectedSegment.id}
                value={selectedSegment.speed}
                ariaLabel={t('settings.customPlaybackSpeed')}
                onChange={(speed) => onSegmentSpeedChange?.(selectedSegment.id, speed)}
                onCommit={onSegmentSpeedCommit}
                onError={() =>
                  toast.error(t('settings.maxSpeedError', { max: MAX_PLAYBACK_SPEED }))
                }
              />
            </div>

            {onSegmentSpeedApplyToAll && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onSegmentSpeedApplyToAll(selectedSegment.speed)}
                className="w-full gap-2 bg-white/5 text-slate-300 border border-white/10 hover:bg-white/10 hover:border-white/20 hover:text-white transition-all h-7 text-[10px]"
              >
                <CopyCheck className="w-3 h-3" />
                {t('timeline.segmentSpeedApplyToAll')}
              </Button>
            )}

            {/* Delete / Restore segment */}
            {!selectedSegment.deleted ? (
              <Button
                onClick={() => onDeleteSegment?.()}
                variant="destructive"
                size="sm"
                className="w-full gap-2 bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 hover:border-red-500/30 transition-all h-7 text-[10px]"
              >
                <Trash2 className="w-3 h-3" />
                {t('settings.deleteTrim')}
              </Button>
            ) : null}
          </div>
        )}

        <Accordion type="multiple" defaultValue={['effects', 'background']} className="space-y-1">
          <AccordionItem value="effects" className="border-white/5 rounded-xl bg-white/[0.02] px-3">
            <AccordionTrigger className="py-2.5 hover:no-underline">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-[#34B27B]" />
                <span className="text-xs font-medium">{t('settings.videoEffects')}</span>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-3">
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="p-2 rounded-lg bg-white/5 border border-white/5">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[10px] font-medium text-slate-300">
                      {t('settings.motionBlur')}
                    </div>
                    <span className="text-[10px] text-slate-500 font-mono">
                      {motionBlurAmount === 0
                        ? t('settings.motionBlurOff')
                        : motionBlurAmount.toFixed(2)}
                    </span>
                  </div>
                  <Slider
                    value={[motionBlurAmount]}
                    onValueChange={(values) => onMotionBlurChange?.(values[0])}
                    min={0}
                    max={1}
                    step={0.01}
                    className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
                  />
                </div>
                <div className="flex items-center justify-between p-2 rounded-lg bg-white/5 border border-white/5">
                  <div className="text-[10px] font-medium text-slate-300">
                    {t('settings.blurBg')}
                  </div>
                  <Switch
                    checked={showBlur}
                    onCheckedChange={onBlurChange}
                    className="data-[state=checked]:bg-[#34B27B] scale-90"
                  />
                </div>
              </div>

              <div className="rounded-lg bg-white/5 border border-white/5 p-2 mb-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[10px] font-medium text-slate-300">
                    {t('settings.cursorComposer')}
                  </div>
                  <Switch
                    checked={cursorStyle.enabled}
                    onCheckedChange={(enabled) => updateCursorStyle({ enabled })}
                    className="data-[state=checked]:bg-[#34B27B] scale-90"
                  />
                </div>
                {cursorStyle.enabled && !hasCursorTrack && (
                  <div className="rounded-md bg-amber-500/10 border border-amber-500/20 p-2 mb-2">
                    <div className="text-[10px] text-amber-400/90">
                      {t('settings.cursorTrackUnavailable')}
                    </div>
                    {onAnalyzeCursor && (
                      <div className="mt-2">
                        <Button
                          onClick={() => onAnalyzeCursor()}
                          variant="outline"
                          size="sm"
                          disabled={cursorAnalysisProgress !== null}
                          className="w-full gap-2 bg-[#34B27B]/10 text-[#9DF3CB] border border-[#34B27B]/20 hover:bg-[#34B27B]/20 hover:border-[#34B27B]/30 transition-all h-7 text-[10px] disabled:opacity-50"
                        >
                          <ScanSearch className="w-3 h-3" />
                          {cursorAnalysisProgress !== null
                            ? t('settings.analyzingCursor', { progress: cursorAnalysisProgress })
                            : t('settings.analyzeCursor')}
                        </Button>
                        {cursorAnalysisProgress !== null && (
                          <div className="mt-1.5 h-1 rounded-full bg-white/10 overflow-hidden">
                            <div
                              className="h-full bg-[#34B27B] rounded-full transition-all duration-300"
                              style={{ width: `${cursorAnalysisProgress}%` }}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <div className="rounded-md bg-black/20 border border-white/5 p-2 mb-2 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-[10px] text-slate-300">
                      {t('settings.cursorMovementStyle')}
                    </div>
                    <span className="text-[10px] text-slate-500">
                      {activeMovementStyle === 'custom'
                        ? t('settings.cursorMovementCustom')
                        : t(
                            `settings.cursorMovement${activeMovementStyle.charAt(0).toUpperCase()}${activeMovementStyle.slice(1)}`,
                          )}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-1">
                    {CURSOR_MOVEMENT_PRESETS.map((preset) => (
                      <Button
                        key={preset.style}
                        type="button"
                        variant="outline"
                        size="sm"
                        className={cn(
                          'h-6 px-0 text-[10px] border transition-all',
                          activeMovementStyle === preset.style
                            ? 'bg-[#34B27B]/20 border-[#34B27B]/40 text-[#9DF3CB] hover:bg-[#34B27B]/25'
                            : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 hover:text-white',
                        )}
                        onClick={() => applyMovementPreset(preset.style)}
                      >
                        {t(preset.labelKey)}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="rounded-md bg-black/20 border border-white/5 p-2 mb-2 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-[10px] text-slate-300">
                      {t('settings.cursorAutoHideStatic')}
                    </div>
                    <Switch
                      checked={cursorStyle.autoHideStatic}
                      onCheckedChange={(autoHideStatic) => updateCursorStyle({ autoHideStatic })}
                      className="data-[state=checked]:bg-[#34B27B] scale-90"
                    />
                  </div>
                  {cursorStyle.autoHideStatic && (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <div className="text-[10px] text-slate-400">
                            {t('settings.cursorStaticHideDelay')}
                          </div>
                          <span className="text-[10px] text-slate-500 font-mono">
                            {Math.round(cursorStyle.staticHideDelayMs)}ms
                          </span>
                        </div>
                        <Slider
                          value={[cursorStyle.staticHideDelayMs]}
                          onValueChange={(values) =>
                            updateCursorStyle({ staticHideDelayMs: values[0] })
                          }
                          min={0}
                          max={4000}
                          step={20}
                          className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
                        />
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <div className="text-[10px] text-slate-400">
                            {t('settings.cursorStaticHideFade')}
                          </div>
                          <span className="text-[10px] text-slate-500 font-mono">
                            {Math.round(cursorStyle.staticHideFadeMs)}ms
                          </span>
                        </div>
                        <Slider
                          value={[cursorStyle.staticHideFadeMs]}
                          onValueChange={(values) =>
                            updateCursorStyle({ staticHideFadeMs: values[0] })
                          }
                          min={40}
                          max={1200}
                          step={20}
                          className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
                        />
                      </div>
                    </div>
                  )}
                </div>
                <div className="rounded-md bg-black/20 border border-white/5 p-2 mb-2 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-[10px] text-slate-300">
                      {t('settings.cursorLoopPosition')}
                    </div>
                    <Switch
                      checked={cursorStyle.loopCursorPosition}
                      onCheckedChange={(loopCursorPosition) =>
                        updateCursorStyle({ loopCursorPosition })
                      }
                      className="data-[state=checked]:bg-[#34B27B] scale-90"
                    />
                  </div>
                  {cursorStyle.loopCursorPosition && (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-[10px] text-slate-400">
                          {t('settings.cursorLoopBlend')}
                        </div>
                        <span className="text-[10px] text-slate-500 font-mono">
                          {Math.round(cursorStyle.loopBlendMs)}ms
                        </span>
                      </div>
                      <Slider
                        value={[cursorStyle.loopBlendMs]}
                        onValueChange={(values) => updateCursorStyle({ loopBlendMs: values[0] })}
                        min={80}
                        max={3000}
                        step={20}
                        className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
                      />
                    </div>
                  )}
                </div>
                <div className="rounded-md bg-black/20 border border-white/5 p-2 mb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1 text-[10px] text-slate-300">
                      <span>{t('settings.cursorClipToBounds')}</span>
                      <TooltipProvider>
                        <Tooltip content={t('settings.cursorClipToBoundsDescription')}>
                          <button
                            type="button"
                            aria-label={t('settings.cursorClipToBoundsDescription')}
                            className="text-slate-500 hover:text-slate-300 transition-colors"
                          >
                            <Info size={11} />
                          </button>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <Switch
                      checked={cursorStyle.clipToBounds ?? false}
                      onCheckedChange={(clipToBounds) => updateCursorStyle({ clipToBounds })}
                      className="data-[state=checked]:bg-[#34B27B] scale-90"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[10px] text-slate-400">{t('settings.cursorSize')}</div>
                      <span className="text-[10px] text-slate-500 font-mono">
                        {cursorStyle.size.toFixed(2)}x
                      </span>
                    </div>
                    <Slider
                      value={[cursorStyle.size]}
                      onValueChange={(values) => updateCursorStyle({ size: values[0] })}
                      min={0.8}
                      max={3}
                      step={0.05}
                      className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[10px] text-slate-400">
                        {t('settings.cursorHighlight')}
                      </div>
                      <span className="text-[10px] text-slate-500 font-mono">
                        {Math.round(cursorStyle.highlight * 100)}%
                      </span>
                    </div>
                    <Slider
                      value={[cursorStyle.highlight]}
                      onValueChange={(values) => updateCursorStyle({ highlight: values[0] })}
                      min={0}
                      max={1}
                      step={0.01}
                      className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[10px] text-slate-400">{t('settings.cursorRipple')}</div>
                      <span className="text-[10px] text-slate-500 font-mono">
                        {Math.round(cursorStyle.ripple * 100)}%
                      </span>
                    </div>
                    <Slider
                      value={[cursorStyle.ripple]}
                      onValueChange={(values) => updateCursorStyle({ ripple: values[0] })}
                      min={0}
                      max={1}
                      step={0.01}
                      className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[10px] text-slate-400">
                        {t('settings.cursorSmoothing')}
                      </div>
                      <span className="text-[10px] text-slate-500 font-mono">
                        {Math.round(cursorStyle.smoothingMs)}ms
                      </span>
                    </div>
                    <Slider
                      value={[cursorStyle.smoothingMs]}
                      onValueChange={(values) =>
                        updateCursorStyle({ smoothingMs: values[0], movementStyle: 'custom' })
                      }
                      min={0}
                      max={200}
                      step={5}
                      className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[10px] text-slate-400">
                        {t('settings.cursorMotionBlur')}
                      </div>
                      <span className="text-[10px] text-slate-500 font-mono">
                        {Math.round((cursorStyle.motionBlur ?? 0) * 100)}%
                      </span>
                    </div>
                    <Slider
                      value={[cursorStyle.motionBlur ?? 0]}
                      onValueChange={(values) => updateCursorStyle({ motionBlur: values[0] })}
                      min={0}
                      max={1}
                      step={0.01}
                      className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[10px] text-slate-400">
                        {t('settings.cursorTimeOffset')}
                      </div>
                      <span className="text-[10px] text-slate-500 font-mono">
                        {formatSignedPx(cursorStyle.timeOffsetMs).replace('px', 'ms')}
                      </span>
                    </div>
                    <Slider
                      value={[cursorStyle.timeOffsetMs]}
                      onValueChange={(values) => updateCursorStyle({ timeOffsetMs: values[0] })}
                      min={-200}
                      max={200}
                      step={1}
                      className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[10px] text-slate-400">
                        {t('settings.cursorOffsetX')}
                      </div>
                      <span className="text-[10px] text-slate-500 font-mono">
                        {formatSignedPx(cursorStyle.offsetX)}
                      </span>
                    </div>
                    <Slider
                      value={[cursorStyle.offsetX]}
                      onValueChange={(values) => updateCursorStyle({ offsetX: values[0] })}
                      min={-120}
                      max={120}
                      step={1}
                      className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[10px] text-slate-400">
                        {t('settings.cursorOffsetY')}
                      </div>
                      <span className="text-[10px] text-slate-500 font-mono">
                        {formatSignedPx(cursorStyle.offsetY)}
                      </span>
                    </div>
                    <Slider
                      value={[cursorStyle.offsetY]}
                      onValueChange={(values) => updateCursorStyle({ offsetY: values[0] })}
                      min={-120}
                      max={120}
                      step={1}
                      className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
                    />
                  </div>
                  <div className="col-span-2 flex justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[10px] bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 hover:text-white"
                      onClick={() => updateCursorStyle({ offsetX: 0, offsetY: 0, timeOffsetMs: 0 })}
                    >
                      {t('settings.cursorOffsetReset')}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="col-span-2 rounded-lg bg-white/5 border border-white/5 p-2">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[10px] font-medium text-slate-300">
                      {t('settings.audioTrack')}
                    </div>
                    <Switch
                      checked={hasAudioTrack && audioEnabled}
                      disabled={!hasAudioTrack}
                      onCheckedChange={onAudioEnabledChange}
                      className="data-[state=checked]:bg-[#34B27B] scale-90 disabled:opacity-50"
                    />
                  </div>
                  {hasAudioTrack ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-[10px] text-slate-400">
                          {t('settings.audioVolume')}
                        </div>
                        <span className="text-[10px] text-slate-500 font-mono">
                          {Math.round(audioGain * 100)}%
                        </span>
                      </div>
                      <Slider
                        value={[audioGain]}
                        onValueChange={(values) => onAudioGainChange?.(values[0])}
                        min={0}
                        max={2}
                        step={0.01}
                        disabled={!audioEnabled}
                        className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3 disabled:opacity-50"
                      />
                      <div className="mt-1 rounded-md border border-white/10 bg-black/20 p-2">
                        <div className="flex items-center justify-between">
                          <div className="text-[10px] text-slate-300">
                            {t('settings.audioNormalizeLoudness')}
                          </div>
                          <Switch
                            checked={audioNormalizeLoudness}
                            disabled={!audioEnabled}
                            onCheckedChange={onAudioNormalizeLoudnessChange}
                            className="data-[state=checked]:bg-[#34B27B] scale-90 disabled:opacity-50"
                          />
                        </div>
                        <div className="mt-1 text-[10px] text-slate-500">
                          {t('settings.audioNormalizeHint')}
                        </div>
                        <div className="mt-2">
                          <div className="flex items-center justify-between mb-1">
                            <div className="text-[10px] text-slate-400">
                              {t('settings.audioTargetLufs')}
                            </div>
                            <span className="text-[10px] text-slate-500 font-mono">
                              {audioTargetLufs.toFixed(1)} LUFS
                            </span>
                          </div>
                          <Slider
                            value={[audioTargetLufs]}
                            onValueChange={(values) => onAudioTargetLufsChange?.(values[0])}
                            min={-24}
                            max={-12}
                            step={0.5}
                            disabled={!audioEnabled || !audioNormalizeLoudness}
                            className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3 disabled:opacity-50"
                          />
                        </div>
                        <div className="mt-2">
                          <div className="flex items-center justify-between mb-1">
                            <div className="text-[10px] text-slate-400">
                              {t('settings.audioLimiterCeiling')}
                            </div>
                            <span className="text-[10px] text-slate-500 font-mono">
                              {audioLimiterDb.toFixed(1)} dBFS
                            </span>
                          </div>
                          <Slider
                            value={[audioLimiterDb]}
                            onValueChange={(values) => onAudioLimiterDbChange?.(values[0])}
                            min={-6}
                            max={-0.1}
                            step={0.1}
                            disabled={!audioEnabled}
                            className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3 disabled:opacity-50"
                          />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-[10px] text-slate-500">
                      {t('settings.audioTrackMissing')}
                    </div>
                  )}
                </div>
                <div className="p-2 rounded-lg bg-white/5 border border-white/5">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[10px] font-medium text-slate-300">
                      {t('settings.shadow')}
                    </div>
                    <span className="text-[10px] text-slate-500 font-mono">
                      {Math.round(shadowIntensity * 100)}%
                    </span>
                  </div>
                  <Slider
                    value={[shadowIntensity]}
                    onValueChange={(values) => onShadowChange?.(values[0])}
                    min={0}
                    max={1}
                    step={0.01}
                    className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
                  />
                </div>
                <div className="p-2 rounded-lg bg-white/5 border border-white/5">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[10px] font-medium text-slate-300">
                      {t('settings.roundness')}
                    </div>
                    <span className="text-[10px] text-slate-500 font-mono">{borderRadius}px</span>
                  </div>
                  <Slider
                    value={[borderRadius]}
                    onValueChange={(values) => onBorderRadiusChange?.(values[0])}
                    min={0}
                    max={64}
                    step={0.5}
                    className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
                  />
                </div>
                <div className="p-2 rounded-lg bg-white/5 border border-white/5">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[10px] font-medium text-slate-300">
                      {t('settings.padding')}
                    </div>
                    <span className="text-[10px] text-slate-500 font-mono">{padding}%</span>
                  </div>
                  <Slider
                    value={[padding]}
                    onValueChange={(values) => onPaddingChange?.(values[0])}
                    min={0}
                    max={100}
                    step={1}
                    disabled={paddingDisabled}
                    className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
                  />
                  {paddingDisabled ? (
                    <p className="mt-1 text-[10px] leading-snug text-slate-500">
                      {t('settings.paddingNativeHint')}
                    </p>
                  ) : null}
                </div>
                <div className="p-2 rounded-lg bg-white/5 border border-white/5">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[10px] font-medium text-slate-300">
                      {t('settings.seekStep')}
                    </div>
                    <span className="text-[10px] text-slate-500 font-mono">{seekStepSeconds}s</span>
                  </div>
                  <Slider
                    value={[seekStepSeconds]}
                    onValueChange={(values) => onSeekStepSecondsChange?.(values[0])}
                    min={1}
                    max={30}
                    step={1}
                    className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
                  />
                </div>
              </div>

              {onCropAspectPresetChange && onCropAspectLockedChange && (
                <div className="mt-2 rounded-md bg-black/20 border border-white/5 p-2 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="crop-aspect-preset"
                      className="text-[10px] text-slate-300 whitespace-nowrap"
                    >
                      {t('settings.cropAspectRatio')}
                    </label>
                    <select
                      id="crop-aspect-preset"
                      value={cropAspectPreset}
                      onChange={(e) => {
                        const next = e.target.value
                        if (isCropAspectPreset(next)) onCropAspectPresetChange(next)
                      }}
                      className="h-6 min-w-[72px] rounded border border-white/10 bg-[#1a1a1f] px-1.5 text-[10px] text-slate-200 outline-none focus:border-[#34B27B]/50 cursor-pointer"
                    >
                      {CROP_ASPECT_PRESETS.map((preset) => (
                        <option key={preset} value={preset} className="bg-[#1a1a1f]">
                          {preset === 'free'
                            ? t('settings.cropAspectFree')
                            : getAspectRatioLabel(preset)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1 text-[10px] text-slate-300">
                      {cropAspectLocked ? (
                        <Lock className="w-3 h-3 text-[#34B27B]" />
                      ) : (
                        <LockOpen className="w-3 h-3 text-slate-500" />
                      )}
                      <span>{t('settings.cropLockAspectRatio')}</span>
                    </div>
                    <Switch
                      checked={cropAspectLocked}
                      onCheckedChange={onCropAspectLockedChange}
                      aria-label={t('settings.cropLockAspectRatio')}
                      className="data-[state=checked]:bg-[#34B27B] scale-90"
                    />
                  </div>
                </div>
              )}

              <Button
                onClick={() => setShowCropDropdown(!showCropDropdown)}
                variant="outline"
                className="w-full mt-2 gap-1.5 bg-white/5 text-slate-200 border-white/10 hover:bg-white/10 hover:border-white/20 hover:text-white text-[10px] h-8 transition-all"
              >
                <Crop className="w-3 h-3" />
                {t('settings.cropVideo')}
              </Button>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem
            value="background"
            className="border-white/5 rounded-xl bg-white/[0.02] px-3"
          >
            <AccordionTrigger className="py-2.5 hover:no-underline">
              <div className="flex items-center gap-2">
                <Palette className="w-4 h-4 text-[#34B27B]" />
                <span className="text-xs font-medium">{t('settings.background')}</span>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-3">
              <Tabs defaultValue="image" className="w-full">
                <TabsList className="mb-2 bg-white/5 border border-white/5 p-0.5 w-full grid grid-cols-3 h-7 rounded-lg">
                  <TabsTrigger
                    value="image"
                    className="data-[state=active]:bg-[#34B27B] data-[state=active]:text-white text-slate-400 text-[10px] py-1 rounded-md transition-all"
                  >
                    {t('settings.backgroundImage')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="color"
                    className="data-[state=active]:bg-[#34B27B] data-[state=active]:text-white text-slate-400 text-[10px] py-1 rounded-md transition-all"
                  >
                    {t('settings.backgroundColor')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="gradient"
                    className="data-[state=active]:bg-[#34B27B] data-[state=active]:text-white text-slate-400 text-[10px] py-1 rounded-md transition-all"
                  >
                    {t('settings.backgroundGradient')}
                  </TabsTrigger>
                </TabsList>

                <div className="max-h-[min(200px,25vh)] overflow-y-auto custom-scrollbar">
                  <TabsContent value="image" className="mt-0 space-y-2">
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleImageUpload}
                      accept={BACKGROUND_IMAGE_ACCEPT}
                      className="hidden"
                    />
                    <Button
                      onClick={() => fileInputRef.current?.click()}
                      variant="outline"
                      className="w-full gap-2 bg-white/5 text-slate-200 border-white/10 hover:bg-[#34B27B] hover:text-white hover:border-[#34B27B] transition-all h-7 text-[10px]"
                    >
                      <Upload className="w-3 h-3" />
                      {t('settings.uploadCustom')}
                    </Button>

                    <div className="grid grid-cols-7 gap-1.5">
                      {customImages.map((imageUrl, idx) => {
                        const isSelected = selected === imageUrl
                        return (
                          <div
                            key={`custom-${idx}`}
                            className={cn(
                              'aspect-square w-9 h-9 rounded-md border-2 overflow-hidden cursor-pointer transition-all duration-200 relative group shadow-sm',
                              isSelected
                                ? 'border-[#34B27B] ring-1 ring-[#34B27B]/30'
                                : 'border-white/10 hover:border-[#34B27B]/40 opacity-80 hover:opacity-100 bg-white/5',
                            )}
                            style={{
                              backgroundImage: `url(${imageUrl})`,
                              backgroundSize: 'cover',
                              backgroundPosition: 'center',
                            }}
                            onClick={() => onWallpaperChange(imageUrl)}
                            role="button"
                          >
                            <button
                              onClick={(e) => handleRemoveCustomImage(imageUrl, e)}
                              className="absolute top-0.5 right-0.5 w-3 h-3 bg-red-500/90 hover:bg-red-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                            >
                              <X className="w-2 h-2 text-white" />
                            </button>
                          </div>
                        )
                      })}

                      {WALLPAPER_PATHS.map((path, index) => {
                        const thumbnailUrl = wallpaperPaths[index] ?? path
                        const isSelected = isSameBuiltInWallpaper(selected, path)
                        return (
                          <div
                            key={path}
                            className={cn(
                              'aspect-square w-9 h-9 rounded-md border-2 overflow-hidden cursor-pointer transition-all duration-200 shadow-sm',
                              isSelected
                                ? 'border-[#34B27B] ring-1 ring-[#34B27B]/30'
                                : 'border-white/10 hover:border-[#34B27B]/40 opacity-80 hover:opacity-100 bg-white/5',
                            )}
                            style={{
                              backgroundImage: `url(${thumbnailUrl})`,
                              backgroundSize: 'cover',
                              backgroundPosition: 'center',
                            }}
                            onClick={() => onWallpaperChange(path)}
                            role="button"
                          />
                        )
                      })}
                    </div>
                  </TabsContent>

                  <TabsContent value="color" className="mt-0">
                    <ColorPicker
                      selectedColor={selectedColor}
                      colorPalette={colorPalette}
                      onUpdateColor={(color) => {
                        setSelectedColor(color)
                        onWallpaperChange(color)
                      }}
                      translations={{
                        colorWheel: t('settings.colorWheel'),
                        colorPalette: t('settings.colorPalette'),
                      }}
                    />
                  </TabsContent>

                  <TabsContent value="gradient" className="mt-0">
                    <div className="grid grid-cols-7 gap-1.5">
                      {GRADIENTS.map((g, idx) => (
                        <div
                          key={g}
                          className={cn(
                            'aspect-square w-9 h-9 rounded-md border-2 overflow-hidden cursor-pointer transition-all duration-200 shadow-sm',
                            gradient === g
                              ? 'border-[#34B27B] ring-1 ring-[#34B27B]/30'
                              : 'border-white/10 hover:border-[#34B27B]/40 opacity-80 hover:opacity-100 bg-white/5',
                          )}
                          style={{ background: g }}
                          aria-label={`Gradient ${idx + 1}`}
                          onClick={() => {
                            setGradient(g)
                            onWallpaperChange(g)
                          }}
                          role="button"
                        />
                      ))}
                    </div>
                    <button
                      type="button"
                      aria-expanded={showGradientEditor}
                      onClick={() => setShowGradientEditor((prev) => !prev)}
                      className="mt-2 w-full h-7 rounded-md border border-white/10 bg-white/5 text-[10px] text-slate-300 hover:bg-white/10 hover:text-white transition-all flex items-center justify-center gap-1"
                    >
                      <ChevronDown
                        className={cn(
                          'w-3 h-3 transition-transform',
                          showGradientEditor && 'rotate-180',
                        )}
                      />
                      {t('settings.gradientEditor.toggle')}
                    </button>
                    {showGradientEditor && (
                      <div className="mt-2">
                        <GradientEditor
                          value={selected}
                          onChange={(css) => {
                            setGradient(css)
                            onWallpaperChange(css)
                          }}
                        />
                      </div>
                    )}
                  </TabsContent>
                </div>
              </Tabs>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem
            value="timeline"
            className="border-white/5 rounded-xl bg-white/[0.02] px-3"
          >
            <AccordionTrigger className="py-2.5 hover:no-underline">
              <div className="flex items-center gap-2">
                <AudioWaveform className="w-4 h-4 text-[#34B27B]" />
                <span className="text-xs font-medium">{t('settings.timeline.title')}</span>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-3">
              <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-white/5 border border-white/5">
                <div className="min-w-0">
                  <div className="text-[10px] font-medium text-slate-300">
                    {t('settings.timeline.waveform')}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    {t('settings.timeline.waveformDesc')}
                  </div>
                </div>
                <Switch
                  checked={showTimelineWaveform}
                  onCheckedChange={(checked) => onTimelineWaveformChange?.(checked)}
                  className="data-[state=checked]:bg-[#34B27B] scale-90 shrink-0"
                />
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>

      {showCropDropdown && cropRegion && onCropChange && (
        <>
          <div
            className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 animate-in fade-in duration-200"
            onClick={() => setShowCropDropdown(false)}
          />
          {/* aria-modal keeps the editor's global shortcuts off while this
              hand-rolled dialog is open (see lib/modalDialog.ts). */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('settings.cropDialogTitle')}
            className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-[60] bg-[#09090b] rounded-2xl shadow-2xl border border-white/10 p-8 w-[90vw] max-w-5xl max-h-[90vh] overflow-auto animate-in zoom-in-95 duration-200"
          >
            <div className="flex items-center justify-between mb-6">
              <div>
                <span className="text-xl font-bold text-slate-200">
                  {t('settings.cropDialogTitle')}
                </span>
                <p className="text-sm text-slate-400 mt-2">{t('settings.cropDialogDesc')}</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowCropDropdown(false)}
                className="hover:bg-white/10 text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </Button>
            </div>
            <CropControl
              videoElement={videoElement || null}
              cropRegion={cropRegion}
              onCropChange={onCropChange}
              aspectRatio={aspectRatio}
              lockAspectRatio={cropLockAspectRatio}
            />
            <div className="mt-6 flex justify-end">
              <Button
                onClick={() => setShowCropDropdown(false)}
                size="lg"
                className="bg-[#34B27B] hover:bg-[#34B27B]/90 text-white"
              >
                {t('common.done')}
              </Button>
            </div>
          </div>
        </>
      )}

      <div className="flex-shrink-0 p-4 pt-3 border-t border-white/5 bg-[#09090b]">
        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={() => onExportFormatChange?.('mp4')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border transition-all text-xs font-medium',
              exportFormat === 'mp4'
                ? 'bg-[#34B27B]/10 border-[#34B27B]/50 text-white'
                : 'bg-white/5 border-white/10 text-slate-400 hover:bg-white/10 hover:text-slate-200',
            )}
          >
            <Film className="w-3.5 h-3.5" />
            MP4
          </button>
          <button
            onClick={() => onExportFormatChange?.('gif')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border transition-all text-xs font-medium',
              exportFormat === 'gif'
                ? 'bg-[#34B27B]/10 border-[#34B27B]/50 text-white'
                : 'bg-white/5 border-white/10 text-slate-400 hover:bg-white/10 hover:text-slate-200',
            )}
          >
            <Image className="w-3.5 h-3.5" />
            GIF
          </button>
        </div>

        {exportFormat === 'mp4' && (
          <div className="mb-3 space-y-2">
            <div className="grid grid-cols-3 gap-1">
              {QUALITY_TILES.map(({ value, labelKey }) => {
                const dimensions = exportQualityDimensions?.[value]
                return (
                  <button
                    key={value}
                    type="button"
                    data-testid={`export-quality-${value}`}
                    onClick={() => onExportQualityChange?.(value)}
                    className={cn(
                      'rounded-lg border px-1 py-1 transition-all',
                      exportQuality === value
                        ? 'border-[#34B27B]/70 bg-[#34B27B]/20 text-white'
                        : 'border-white/10 bg-white/5 text-slate-400 hover:border-[#34B27B]/50 hover:text-slate-200',
                    )}
                  >
                    <span className="block text-[10px] font-medium leading-tight">
                      {t(labelKey)}
                    </span>
                    <span
                      data-testid={`export-quality-${value}-dimensions`}
                      className="block text-[9px] leading-tight text-slate-500 tabular-nums"
                    >
                      {dimensions ? `${dimensions.width} × ${dimensions.height}` : '—'}
                    </span>
                  </button>
                )
              })}
            </div>

            {availableExportFrameRates.length > 1 && (
              <div className="rounded-lg border border-white/10 bg-white/5 p-2">
                <div className="mb-1.5 flex items-center justify-between text-[10px]">
                  <span className="uppercase tracking-wide text-slate-400">
                    {t('settings.exportFrameRate')}
                  </span>
                  <span className="text-slate-500">
                    {t('settings.exportFrameRateHint', {
                      fps: normalizeExportSourceFrameRate(sourceFrameRate),
                    })}
                  </span>
                </div>
                <div
                  className="grid gap-1"
                  style={{
                    gridTemplateColumns: `repeat(${availableExportFrameRates.length}, minmax(0, 1fr))`,
                  }}
                >
                  {availableExportFrameRates.map((rate) => (
                    <button
                      key={rate}
                      type="button"
                      data-testid={`export-frame-rate-${rate}`}
                      onClick={() => onExportFrameRateChange?.(rate)}
                      className={cn(
                        'h-6 rounded-md border text-[10px] font-medium tabular-nums transition-all',
                        exportFrameRate === rate
                          ? 'border-[#34B27B]/70 bg-[#34B27B]/20 text-white'
                          : 'border-white/10 text-slate-400 hover:border-[#34B27B]/50 hover:text-slate-200',
                      )}
                    >
                      {rate}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="rounded-lg border border-white/10 bg-white/5 p-2">
              <div className="mb-1.5 text-[10px] uppercase tracking-wide text-slate-400">
                {t('settings.exportCodec')}
              </div>
              <div className="grid grid-cols-2 gap-1">
                {EXPORT_CODEC_TILES.map(({ value, label }) => {
                  const supported = availableExportCodecs.includes(value)
                  return (
                    <button
                      key={value}
                      type="button"
                      disabled={!supported}
                      data-testid={`export-codec-${value}`}
                      title={
                        supported
                          ? value === 'hevc'
                            ? t('settings.exportCodecHevcHint')
                            : undefined
                          : t('settings.exportCodecHevcUnavailable')
                      }
                      onClick={() => onExportCodecChange?.(value)}
                      className={cn(
                        'h-6 rounded-md border text-[10px] font-medium transition-all',
                        !supported
                          ? 'cursor-not-allowed border-white/5 text-slate-600'
                          : exportCodec === value
                            ? 'border-[#34B27B]/70 bg-[#34B27B]/20 text-white'
                            : 'border-white/10 text-slate-400 hover:border-[#34B27B]/50 hover:text-slate-200',
                      )}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
              {exportCodec === 'hevc' && (
                <p className="mt-1.5 text-[10px] leading-snug text-slate-500">
                  {t('settings.exportCodecHevcHint')}
                </p>
              )}
            </div>

            <div className="rounded-lg border border-white/10 bg-white/5 p-2">
              <div className="mb-2 flex items-center justify-between text-[10px]">
                <span className="uppercase tracking-wide text-slate-400">
                  {t('settings.exportAspectRatios')}
                </span>
                <span className="text-slate-500">
                  {t('settings.exportAspectRatioCount', { count: activeExportAspectRatios.length })}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-1">
                {ASPECT_RATIOS.map((ratio) => {
                  const isSelected = activeExportAspectRatios.includes(ratio)
                  return (
                    <button
                      key={ratio}
                      type="button"
                      onClick={() => toggleExportAspectRatio(ratio)}
                      className={cn(
                        'h-6 rounded-md border text-[10px] font-medium transition-all',
                        isSelected
                          ? 'border-[#34B27B]/70 bg-[#34B27B]/20 text-white'
                          : 'border-white/10 text-slate-400 hover:border-[#34B27B]/50 hover:text-slate-200',
                      )}
                    >
                      {ratio === 'native'
                        ? t('settings.aspectRatioNative')
                        : getAspectRatioLabel(ratio)}
                    </button>
                  )
                })}
              </div>
              <p className="mt-2 text-[10px] leading-snug text-slate-500">
                {t('settings.exportAspectRatioHint')}
              </p>
            </div>
          </div>
        )}

        {exportFormat === 'gif' && (
          <div className="mb-3 space-y-2">
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-white/5 border border-white/5 p-0.5 grid grid-cols-4 h-7 rounded-lg">
                {GIF_FRAME_RATES.map((rate) => (
                  <button
                    key={rate.value}
                    onClick={() => onGifFrameRateChange?.(rate.value)}
                    className={cn(
                      'rounded-md transition-all text-[10px] font-medium',
                      gifFrameRate === rate.value
                        ? 'bg-white text-black'
                        : 'text-slate-400 hover:text-slate-200',
                    )}
                  >
                    {rate.value}
                  </button>
                ))}
              </div>
              <div className="flex-1 bg-white/5 border border-white/5 p-0.5 grid grid-cols-3 h-7 rounded-lg">
                {Object.keys(GIF_SIZE_PRESETS).map((key) => (
                  <button
                    key={key}
                    onClick={() => onGifSizePresetChange?.(key as GifSizePreset)}
                    className={cn(
                      'rounded-md transition-all text-[10px] font-medium',
                      gifSizePreset === key
                        ? 'bg-white text-black'
                        : 'text-slate-400 hover:text-slate-200',
                    )}
                  >
                    {key === 'original'
                      ? t('settings.gif.original')
                      : key.charAt(0).toUpperCase() + key.slice(1, 3)}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-500">
                {gifOutputDimensions.width} × {gifOutputDimensions.height}px
              </span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-400">{t('common.loop')}</span>
                <Switch
                  checked={gifLoop}
                  onCheckedChange={onGifLoopChange}
                  className="data-[state=checked]:bg-[#34B27B] scale-75"
                />
              </div>
            </div>
          </div>
        )}

        {onCaptionSidecarFormatsChange && subtitleCues.length > 0 && (
          <div className="mb-3 rounded-lg border border-white/10 bg-white/5 p-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              {t('settings.captionSidecars')}
            </div>
            <div className="mt-1.5 flex items-center gap-3">
              {SUBTITLE_SIDECAR_FORMATS.map((format) => {
                const checked = captionSidecarFormats.includes(format)
                return (
                  <label
                    key={format}
                    className="flex cursor-pointer items-center gap-1.5 text-[10px] text-slate-300"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        onCaptionSidecarFormatsChange(
                          checked
                            ? captionSidecarFormats.filter((entry) => entry !== format)
                            : [...captionSidecarFormats, format],
                        )
                      }
                      className="h-3 w-3 accent-[#34B27B]"
                    />
                    {format === 'srt'
                      ? t('settings.captionSidecarSrt')
                      : t('settings.captionSidecarVtt')}
                  </label>
                )
              })}
            </div>
            <p className="mt-1.5 text-[10px] leading-snug text-slate-500">
              {t('settings.captionSidecarsHint')}
            </p>
          </div>
        )}

        <Button
          type="button"
          size="lg"
          onClick={onExport}
          className="w-full py-5 text-sm font-semibold flex items-center justify-center gap-2 bg-[#34B27B] text-white rounded-xl shadow-lg shadow-[#34B27B]/20 hover:bg-[#34B27B]/90 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200"
        >
          <Download className="w-4 h-4" />
          {t('settings.exportVideo', { format: exportFormat === 'gif' ? 'GIF' : 'Video' })}
        </Button>

        <div className="flex gap-2 mt-3">
          <button
            type="button"
            onClick={() => {
              void openSupportUrl(GITHUB_ISSUES_URL, 'settings-panel.open-report-bug-link')
            }}
            className="flex-1 flex items-center justify-center gap-1.5 text-[10px] text-slate-500 hover:text-slate-300 py-1.5 transition-colors"
          >
            <Bug className="w-3 h-3 text-[#34B27B]" />
            {t('settings.reportBug')}
          </button>
          <button
            type="button"
            onClick={() => {
              void openSupportUrl(GITHUB_REPO_URL, 'settings-panel.open-star-repo-link')
            }}
            className="flex-1 flex items-center justify-center gap-1.5 text-[10px] text-slate-500 hover:text-slate-300 py-1.5 transition-colors"
          >
            <Star className="w-3 h-3 text-yellow-400" />
            {t('settings.starGithub')}
          </button>
        </div>
        <div className="text-center text-[10px] text-slate-600 mt-2 pt-2 border-t border-white/5 select-text">
          Capturia v{__APP_VERSION__}
        </div>
      </div>
    </div>
  )
}
