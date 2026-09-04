import {
  Application,
  Container,
  Sprite,
  Graphics,
  ImageSource,
  Texture,
  VideoSource,
} from 'pixi.js'
import { MotionBlurFilter } from 'pixi-filters/motion-blur'
import type {
  ZoomRegion,
  CropRegion,
  AnnotationRegion,
  Rotation3D,
} from '@/components/video-editor/types'
import { DEFAULT_ROTATION_3D, isRotation3DIdentity } from '@/components/video-editor/types'
import {
  createPixiLifecycle,
  destroyPixiApplication,
  type PixiLifecycle,
} from '@/lib/rendering/pixiLifecycle'
import { createThreeDPass, type ThreeDPass } from './threeDPass'
import {
  buildMaskGeometryKey,
  buildShadowFilter,
  buildShadowGeometryKey,
  canReuseTextureSource,
  getFrameSourceSize,
  readLegacyCompositorOverride,
} from './compositorKeys'
import {
  applyZoomTransform,
  createMotionBlurState,
  type MotionBlurState,
} from '@/components/video-editor/videoPlayback/zoomTransform'
import { DEFAULT_FOCUS } from '@/components/video-editor/videoPlayback/constants'
import {
  createZoomCameraState,
  stepZoomCamera,
} from '@/components/video-editor/videoPlayback/zoomCamera'
import {
  buildCursorTelemetry,
  type CursorTelemetryPoint,
} from '@/components/video-editor/videoPlayback/cursorFollowUtils'
import {
  renderAnnotations,
  preloadAnnotationFonts,
  preloadAnnotationImages,
} from './annotationRenderer'
import { getExportBackgroundFilter } from '@/lib/rendering/backgroundBlur'
import { classifyWallpaper, resolveImageWallpaperUrl } from '@/lib/wallpaper'
import { BackgroundLoadError } from './backgroundErrors'
import {
  getLinearGradientPoints,
  getRadialGradientShape,
  parseCssGradient,
  resolveLinearGradientAngle,
} from './gradientParser'
import type { SubtitleCue } from '@/lib/analysis/types'
import { findSubtitleCueAtTime, normalizeSubtitleCues } from '@/lib/analysis/subtitleTrack'
import {
  DEFAULT_SUBTITLE_STYLE,
  normalizeSubtitleStyle,
  type SubtitleStyle,
} from '@/lib/rendering/subtitleStyle'
import { renderSubtitleCue } from './subtitleRenderer'
import {
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
} from '@/lib/cursor'

interface FrameRenderConfig {
  width: number
  height: number
  wallpaper: string
  zoomRegions: ZoomRegion[]
  showShadow: boolean
  shadowIntensity: number
  showBlur: boolean
  /** Zoom motion blur amount 0..1 (0 = off); same scale as the preview. */
  motionBlurAmount?: number
  borderRadius?: number
  padding?: number
  cropRegion: CropRegion
  videoWidth: number
  videoHeight: number
  annotationRegions?: AnnotationRegion[]
  subtitleCues?: SubtitleCue[]
  /** Caption look; missing (older projects) means the built-in default. */
  subtitleStyle?: SubtitleStyle
  previewWidth?: number
  previewHeight?: number
  cursorTrack?: CursorTrack | null
  cursorStyle?: Partial<CursorStyleConfig>
  /** `process.platform` of the host; enables the Linux CPU readback path. */
  platform?: string
  /**
   * Forces the pre-cache compositor: a fresh video texture, a fresh mask
   * tessellation and a fresh shadow raster on every frame. Only for A/B'ing a
   * suspected compositing regression; defaults to the
   * `capturia.exportLegacyCompositor` override, else off.
   */
  legacyCompositor?: boolean
}

/**
 * 2D context attributes for canvases the export loop reads back every frame.
 * Only Linux hints `willReadFrequently`; other platforms keep the GPU-backed
 * default so their output stays byte-identical.
 */
export function compositeContextAttributes(platform?: string): CanvasRenderingContext2DSettings {
  return { willReadFrequently: platform === 'linux' }
}

/**
 * `gl.readPixels` returns rows bottom-to-top; flip them in place so the buffer
 * matches canvas/ImageData row order. Pure so it can be unit-tested.
 */
export function flipPixelRowsInPlace(buf: Uint8Array, width: number, height: number): Uint8Array {
  const rowSize = width * 4
  const temp = new Uint8Array(rowSize)
  for (let top = 0, bot = height - 1; top < bot; top++, bot--) {
    const tOff = top * rowSize
    const bOff = bot * rowSize
    temp.set(buf.subarray(tOff, tOff + rowSize))
    buf.copyWithin(tOff, bOff, bOff + rowSize)
    buf.set(temp, bOff)
  }
  return buf
}

/** Camera target for the current frame (mirrors VideoPlayback's animationStateRef). */
interface AnimationState {
  scale: number
  focusX: number
  focusY: number
  progress: number
}

interface FrameRenderOptions {
  effectTimeMs?: number
}

function isExportAudioDebugEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem('capturia.exportDebugAudio') === '1'
  } catch {
    return false
  }
}

// Renders video frames with all effects (background, zoom, crop, blur, shadow) to an offscreen canvas for export.

export class FrameRenderer {
  private app: Application | null = null
  private appLifecycle: PixiLifecycle<Application> | null = null
  private cameraContainer: Container | null = null
  private videoContainer: Container | null = null
  private videoSprite: Sprite | null = null
  private backgroundSprite: Sprite | null = null
  private maskGraphics: Graphics | null = null
  private motionBlurFilter: MotionBlurFilter | null = null
  private motionBlurState: MotionBlurState = createMotionBlurState()
  private shadowCanvas: HTMLCanvasElement | null = null
  private shadowCtx: CanvasRenderingContext2D | null = null
  private compositeCanvas: HTMLCanvasElement | null = null
  private compositeCtx: CanvasRenderingContext2D | null = null
  private rasterCanvas: HTMLCanvasElement | null = null
  private rasterCtx: CanvasRenderingContext2D | null = null
  // 3D tilt (rotationPreset): the foreground (video + cursor) is drawn on its
  // own transparent canvas, run through the WebGL pass and then stamped (with
  // the shadow) onto the background. Null when WebGL2 is unavailable -> flat.
  private threeDPass: ThreeDPass | null = null
  private foregroundCanvas: HTMLCanvasElement | null = null
  private foregroundCtx: CanvasRenderingContext2D | null = null
  private currentRotation3D: Rotation3D = DEFAULT_ROTATION_3D
  private readonly isLinux: boolean
  private config: FrameRenderConfig
  private animationState: AnimationState
  // Same camera step as the preview ticker (spring + auto-follow focus), driven
  // by content time (effectTimeMs).
  private zoomCamera = createZoomCameraState()
  // Auto-follow telemetry (focusMode 'auto'), built once from config.cursorTrack.
  private cursorTelemetry: CursorTelemetryPoint[] = []
  private layoutCache: any = null
  private cursorMotionBlurState = createCursorMotionBlurState()
  private currentVideoTime = 0
  private currentVideoSource: HTMLVideoElement | VideoFrame | null = null
  private subtitleCues: SubtitleCue[]
  private subtitleStyle: SubtitleStyle
  // Cached CSS filter string — constant across frames, computed once.
  private cachedShadowFilter: string | null = null
  /**
   * One `ImageSource` reused for every decoded `VideoFrame`: the frame is
   * swapped into `.resource` and re-uploaded into the *same* GL texture rather
   * than allocating and deleting one per frame. Null on the `<video>` path,
   * which has its own reusable `VideoSource`.
   */
  private videoFrameSource: ImageSource | null = null
  /** Identity of `videoFrameSource`'s pixel size; a change forces a new source. */
  private videoFrameSourceSize: { width: number; height: number } | null = null
  /** Mask tessellation identity; `updateLayout` is a no-op while it holds. */
  private maskGeometryKey: string | null = null
  /** Silhouette identity of the cached shadow raster. */
  private shadowGeometryKey: string | null = null
  /** Black-with-alpha shadow layer for `shadowGeometryKey`, drawn under the video. */
  private shadowLayerCanvas: HTMLCanvasElement | null = null
  private shadowLayerCtx: CanvasRenderingContext2D | null = null
  /** Scratch canvas the silhouette is rasterised on before the filter runs. */
  private silhouetteCanvas: HTMLCanvasElement | null = null
  private silhouetteCtx: CanvasRenderingContext2D | null = null
  /**
   * Shadow key of the previous frame. The layer is only rasterised once the
   * same key has been seen twice in a row, so a moving camera — whose key
   * changes every frame — never pays for a raster it would throw away.
   */
  private previousShadowKey: string | null = null
  private readonly legacyCompositor: boolean
  /** Counters the perf harness reads; not part of the export contract. */
  readonly stats = {
    layoutRebuilds: 0,
    textureAllocations: 0,
    shadowRasterisations: 0,
    framesRendered: 0,
  }

  constructor(config: FrameRenderConfig) {
    this.config = config
    this.legacyCompositor = config.legacyCompositor ?? readLegacyCompositorOverride() ?? false
    this.isLinux = config.platform === 'linux'
    this.subtitleCues = normalizeSubtitleCues(config.subtitleCues ?? [])
    this.subtitleStyle = config.subtitleStyle
      ? normalizeSubtitleStyle(config.subtitleStyle)
      : DEFAULT_SUBTITLE_STYLE
    this.cursorTelemetry = buildCursorTelemetry(config.cursorTrack)
    this.animationState = {
      scale: 1,
      focusX: DEFAULT_FOCUS.cx,
      focusY: DEFAULT_FOCUS.cy,
      progress: 0,
    }
  }

  /** A fresh render target per backend attempt: a canvas only ever holds one context. */
  private createRenderCanvas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.width = this.config.width
    canvas.height = this.config.height

    // Try to set colorSpace if supported (may not be available on all platforms)
    try {
      if (canvas && 'colorSpace' in canvas) {
        ;(canvas as HTMLCanvasElement & { colorSpace?: string }).colorSpace = 'srgb'
      }
    } catch (error) {
      // Silently ignore colorSpace errors on platforms that don't support it
      console.warn('[FrameRenderer] colorSpace not supported on this platform:', error)
    }
    return canvas
  }

  async initialize(): Promise<void> {
    // Initialize PixiJS with optimized settings for export performance.
    // An export that waits forever on a context request is worse than one that
    // fails: the progress bar sits at zero and the user has nothing to report.
    // The lifecycle bounds each attempt and destroys whatever a failed attempt
    // managed to build.
    this.appLifecycle = createPixiLifecycle<Application>({
      create: () => new Application(),
      initOptions: () => ({
        canvas: this.createRenderCanvas(),
        width: this.config.width,
        height: this.config.height,
        backgroundAlpha: 0,
        antialias: true,
        resolution: 1,
        autoDensity: true,
      }),
    })

    const outcome = await this.appLifecycle.init()
    if (outcome.status === 'destroyed') {
      throw new Error('Export renderer was torn down while it was starting up')
    }
    if (outcome.status === 'failed') {
      throw outcome.error instanceof Error
        ? outcome.error
        : new Error(`Failed to initialise the export renderer: ${String(outcome.error)}`)
    }
    this.app = outcome.app

    // Setup containers
    this.cameraContainer = new Container()
    this.videoContainer = new Container()
    this.app.stage.addChild(this.cameraContainer)
    this.cameraContainer.addChild(this.videoContainer)

    // Setup background (render separately, not in PixiJS)
    await this.setupBackground()

    // Directional motion blur. Kept attached for the whole export (every frame
    // is rendered anyway); at zero velocity the filter is a passthrough.
    if ((this.config.motionBlurAmount ?? 0) > 0) {
      this.motionBlurFilter = new MotionBlurFilter({
        velocity: { x: 0, y: 0 },
        kernelSize: 5,
        offset: 0,
      })
      this.motionBlurFilter.resolution = this.app.renderer.resolution
      this.videoContainer.filters = [this.motionBlurFilter]
    }

    // Setup composite canvas for final output with shadows
    this.compositeCanvas = document.createElement('canvas')
    this.compositeCanvas.width = this.config.width
    this.compositeCanvas.height = this.config.height
    // On Linux the export loop calls getImageData() on every frame, so hint
    // frequent CPU readback. Elsewhere the GPU-backed default is kept as-is.
    this.compositeCtx = this.compositeCanvas.getContext(
      '2d',
      compositeContextAttributes(this.config.platform),
    )

    if (!this.compositeCtx) {
      throw new Error('Failed to get 2D context for composite canvas')
    }

    if (this.isLinux) {
      // Raster staging canvas for the WebGL readPixels readback (see readbackVideoCanvas).
      this.rasterCanvas = document.createElement('canvas')
      this.rasterCanvas.width = this.config.width
      this.rasterCanvas.height = this.config.height
      this.rasterCtx = this.rasterCanvas.getContext('2d')
      if (!this.rasterCtx) {
        throw new Error('Failed to get 2D context for raster canvas')
      }
    }

    // 3D tilt pass. Only used on frames whose rotation is non-identity; when
    // WebGL2 is unavailable the export stays flat instead of failing.
    try {
      this.threeDPass = createThreeDPass(this.config.width, this.config.height)
      this.foregroundCanvas = document.createElement('canvas')
      this.foregroundCanvas.width = this.config.width
      this.foregroundCanvas.height = this.config.height
      this.foregroundCtx = this.foregroundCanvas.getContext('2d', {
        willReadFrequently: this.isLinux,
      })
      if (!this.foregroundCtx) {
        throw new Error('Failed to get 2D context for foreground canvas')
      }
    } catch (error) {
      console.warn('[FrameRenderer] 3D pass unavailable, rotation presets will be ignored:', error)
      this.threeDPass?.destroy()
      this.threeDPass = null
      this.foregroundCanvas = null
      this.foregroundCtx = null
    }

    // Setup shadow canvas if needed
    if (this.config.showShadow) {
      this.shadowCanvas = document.createElement('canvas')
      this.shadowCanvas.width = this.config.width
      this.shadowCanvas.height = this.config.height
      this.shadowCtx = this.shadowCanvas.getContext('2d', { willReadFrequently: false })

      if (!this.shadowCtx) {
        throw new Error('Failed to get 2D context for shadow canvas')
      }
    }

    // Setup mask
    this.maskGraphics = new Graphics()
    this.videoContainer.addChild(this.maskGraphics)
    this.videoContainer.mask = this.maskGraphics

    // Pre-load annotation images and web fonts so renderFrame never blocks on
    // I/O and canvas text is drawn with the chosen family, not a fallback.
    if (this.config.annotationRegions && this.config.annotationRegions.length > 0) {
      await Promise.all([
        preloadAnnotationImages(this.config.annotationRegions),
        preloadAnnotationFonts(this.config.annotationRegions),
      ])
    }
  }

  private async setupBackground(): Promise<void> {
    const wallpaper = this.config.wallpaper

    // Create background canvas for separate rendering (not affected by zoom)
    const bgCanvas = document.createElement('canvas')
    bgCanvas.width = this.config.width
    bgCanvas.height = this.config.height
    const bgCtx = bgCanvas.getContext('2d')!

    // Render background based on type. Failures throw BackgroundLoadError so the
    // exporter reports them instead of silently exporting a black background.
    const classified = classifyWallpaper(wallpaper)
    if (classified.kind === 'image') {
      // Image background: canonical "/wallpapers/wallpaperN.jpg" values are
      // resolved through the asset path so they load in both the dev server
      // and the packaged app; absolute URLs and data URIs pass through.
      const img = new Image()
      const imageUrl = await resolveImageWallpaperUrl(classified.path)
      if (imageUrl.startsWith('http') && !imageUrl.startsWith(window.location.origin)) {
        img.crossOrigin = 'anonymous'
      }

      try {
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = (err) => reject(err)
          img.src = imageUrl
        })
      } catch (err) {
        console.error('[FrameRenderer] Failed to load background image:', imageUrl, err)
        throw new BackgroundLoadError(imageUrl, err)
      }

      // Draw the image using cover and center positioning
      const imgAspect = img.width / img.height
      const canvasAspect = this.config.width / this.config.height

      let drawWidth, drawHeight, drawX, drawY

      if (imgAspect > canvasAspect) {
        drawHeight = this.config.height
        drawWidth = drawHeight * imgAspect
        drawX = (this.config.width - drawWidth) / 2
        drawY = 0
      } else {
        drawWidth = this.config.width
        drawHeight = drawWidth / imgAspect
        drawX = 0
        drawY = (this.config.height - drawHeight) / 2
      }

      bgCtx.drawImage(img, drawX, drawY, drawWidth, drawHeight)
    } else if (classified.kind === 'gradient') {
      const parsedGradient = parseCssGradient(classified.value)
      if (!parsedGradient) {
        throw new BackgroundLoadError(wallpaper)
      }

      let gradient: CanvasGradient
      if (parsedGradient.type === 'linear') {
        const points = getLinearGradientPoints(
          resolveLinearGradientAngle(parsedGradient.descriptor),
          this.config.width,
          this.config.height,
        )
        gradient = bgCtx.createLinearGradient(points.x0, points.y0, points.x1, points.y1)
      } else {
        const shape = getRadialGradientShape(
          parsedGradient.descriptor,
          this.config.width,
          this.config.height,
        )
        gradient = bgCtx.createRadialGradient(
          shape.cx,
          shape.cy,
          0,
          shape.cx,
          shape.cy,
          shape.radius,
        )
      }

      parsedGradient.stops.forEach((stop) => {
        gradient.addColorStop(stop.offset, stop.color)
      })

      bgCtx.fillStyle = gradient
      bgCtx.fillRect(0, 0, this.config.width, this.config.height)
    } else {
      bgCtx.fillStyle = classified.value
      bgCtx.fillRect(0, 0, this.config.width, this.config.height)
    }

    // Pre-bake background blur into the canvas so compositeWithShadows() can
    // skip the per-frame CSS filter — the background never changes between frames.
    if (this.config.showBlur) {
      const blurFilterStr = getExportBackgroundFilter({
        showBlur: true,
        outputWidth: this.config.width,
        previewWidth: this.config.previewWidth,
      })
      const blurredCanvas = document.createElement('canvas')
      blurredCanvas.width = this.config.width
      blurredCanvas.height = this.config.height
      const blurredCtx = blurredCanvas.getContext('2d')!
      blurredCtx.filter = blurFilterStr
      blurredCtx.drawImage(bgCanvas, 0, 0, this.config.width, this.config.height)
      this.backgroundSprite = blurredCanvas as any
    } else {
      // Store the background canvas for compositing
      this.backgroundSprite = bgCanvas as any
    }
  }

  private updateVideoSpriteSource(videoSource: HTMLVideoElement | VideoFrame): void {
    if (!this.videoContainer) {
      throw new Error('Renderer not initialized')
    }

    const sourceIsReusableVideo =
      this.currentVideoSource instanceof HTMLVideoElement &&
      videoSource instanceof HTMLVideoElement &&
      this.currentVideoSource === videoSource

    if (!this.videoSprite) {
      const texture = this.createTextureFromVideoSource(videoSource)
      this.videoSprite = new Sprite(texture)
      this.videoContainer.addChild(this.videoSprite)
      this.currentVideoSource = videoSource
      return
    }

    if (sourceIsReusableVideo) {
      const textureSource = (this.videoSprite.texture as any)?.source
      if (textureSource && typeof textureSource.update === 'function') {
        textureSource.update()
      }
      return
    }

    // Decoded `VideoFrame`s arrive one per frame and are closed by the caller
    // straight afterwards. `Texture.from` would build a new ImageSource, a new
    // Texture and a new GL texture for each of them, then `destroy(true)`
    // would delete all three — an allocate/free pair per exported frame. Swap
    // the resource into the source we already have instead, which re-uploads
    // into the same GL texture. Only a change of pixel size needs a new one.
    if (!this.legacyCompositor && !(videoSource instanceof HTMLVideoElement)) {
      const size = getFrameSourceSize(videoSource)
      if (this.videoFrameSource && canReuseTextureSource(this.videoFrameSourceSize, size)) {
        this.videoFrameSource.resource = videoSource
        this.videoFrameSource.update()
        this.currentVideoSource = videoSource
        return
      }
    }

    const oldTexture = this.videoSprite.texture
    const newTexture = this.createTextureFromVideoSource(videoSource)
    this.videoSprite.texture = newTexture
    this.currentVideoSource = videoSource
    if (oldTexture !== newTexture) {
      oldTexture.destroy(true)
    }
  }

  private createTextureFromVideoSource(videoSource: HTMLVideoElement | VideoFrame): Texture {
    this.stats.textureAllocations += 1
    if (!(videoSource instanceof HTMLVideoElement)) {
      if (this.legacyCompositor) {
        this.videoFrameSource = null
        this.videoFrameSourceSize = null
        return Texture.from(videoSource as any)
      }
      // Same source class `Texture.from` would pick for a `VideoFrame`
      // (`ImageSource.test` matches it), built directly so the instance can be
      // kept and re-fed instead of going through the resource cache.
      const source = new ImageSource({ resource: videoSource })
      this.videoFrameSource = source
      this.videoFrameSourceSize = getFrameSourceSize(videoSource)
      return new Texture({ source })
    }
    this.videoFrameSource = null
    this.videoFrameSourceSize = null

    // Enforce silent source behavior and explicitly disable Pixi auto-play in export pipeline.
    videoSource.defaultMuted = true
    videoSource.muted = true
    videoSource.volume = 0

    if (isExportAudioDebugEnabled()) {
      console.log('[ExportAudioDebug][FrameRenderer] create video texture', {
        currentTime: Number(videoSource.currentTime?.toFixed?.(4) ?? videoSource.currentTime ?? 0),
        paused: videoSource.paused,
        muted: videoSource.muted,
        volume: videoSource.volume,
      })
    }

    const source = new VideoSource({
      resource: videoSource,
      autoPlay: false,
      autoLoad: true,
      muted: true,
      playsinline: true,
      preload: false,
    })
    source.autoUpdate = true

    return new Texture({ source })
  }

  async renderFrame(
    videoSource: HTMLVideoElement | VideoFrame,
    timestamp: number,
    options: FrameRenderOptions = {},
  ): Promise<void> {
    if (!this.app || !this.videoContainer || !this.cameraContainer) {
      throw new Error('Renderer not initialized')
    }

    this.stats.framesRendered += 1
    this.currentVideoTime = timestamp / 1000000
    this.updateVideoSpriteSource(videoSource)

    this.updateLayout()
    if (!this.layoutCache) {
      throw new Error('Frame layout is unavailable')
    }

    const sampledTimeMs = this.currentVideoTime * 1000
    const effectTimeMs = Number.isFinite(options.effectTimeMs)
      ? Number(options.effectTimeMs)
      : sampledTimeMs
    this.updateAnimationState(effectTimeMs)

    applyZoomTransform({
      cameraContainer: this.cameraContainer,
      motionBlurFilter: this.motionBlurFilter,
      motionBlurState: this.motionBlurState,
      stageSize: this.layoutCache.stageSize,
      baseMask: this.layoutCache.maskRect,
      zoomScale: this.animationState.scale,
      zoomProgress: this.animationState.progress,
      focusX: this.animationState.focusX,
      focusY: this.animationState.focusY,
      isPlaying: true,
      motionBlurAmount: this.config.motionBlurAmount ?? 0,
      transformOverride: this.zoomCamera.applied,
      frameTimeMs: effectTimeMs,
    })

    // Render the PixiJS stage to its canvas (video only, transparent background)
    this.app.renderer.render(this.app.stage)

    const videoCanvas = this.isLinux
      ? this.readbackVideoCanvas()
      : (this.app.canvas as HTMLCanvasElement)
    const willRotate =
      this.threeDPass !== null &&
      this.foregroundCanvas !== null &&
      this.foregroundCtx !== null &&
      !isRotation3DIdentity(this.currentRotation3D)

    // Background (blur pre-baked at init) always stays flat.
    this.drawBackground()

    if (willRotate && this.threeDPass && this.foregroundCanvas && this.foregroundCtx) {
      // 3D tilt: video + cursor on the transparent foreground canvas, rotated
      // as one, then stamped onto the background with the shadow applied to
      // the rotated silhouette (same as the preview, where the drop-shadow
      // filter sits inside composite3D). Subtitles / annotations stay flat.
      const fgCtx = this.foregroundCtx
      const w = this.foregroundCanvas.width
      const h = this.foregroundCanvas.height
      fgCtx.clearRect(0, 0, w, h)
      fgCtx.drawImage(videoCanvas, 0, 0, w, h)
      this.renderCursorLayer(effectTimeMs, fgCtx)

      const passCanvas = this.threeDPass.apply(this.foregroundCanvas, this.currentRotation3D)
      fgCtx.clearRect(0, 0, w, h)
      if (this.isLinux) {
        // drawImage(webglCanvas) is unreliable on Linux/Wayland (see readbackVideoCanvas).
        const imageData = fgCtx.createImageData(w, h)
        imageData.data.set(this.threeDPass.readPixels())
        fgCtx.putImageData(imageData, 0, 0)
      } else {
        fgCtx.drawImage(passCanvas, 0, 0)
      }
      this.drawVideoLayer(this.foregroundCanvas)
    } else {
      // Flat path (unchanged): video with shadow, then the cursor on top.
      this.drawVideoLayer(videoCanvas)
      this.renderCursorLayer(effectTimeMs, this.compositeCtx)
    }

    // Render subtitle captions above cursor/video but below annotations.
    this.renderSubtitleLayer(effectTimeMs)

    // Render annotations on top if present
    if (
      this.config.annotationRegions &&
      this.config.annotationRegions.length > 0 &&
      this.compositeCtx
    ) {
      // Calculate scale factor based on export vs preview dimensions
      const previewWidth = this.config.previewWidth || 1920
      const previewHeight = this.config.previewHeight || 1080
      const scaleX = this.config.width / previewWidth
      const scaleY = this.config.height / previewHeight
      const scaleFactor = (scaleX + scaleY) / 2

      await renderAnnotations(
        this.compositeCtx,
        this.config.annotationRegions,
        this.config.width,
        this.config.height,
        effectTimeMs,
        scaleFactor,
      )
    }
  }

  private renderSubtitleLayer(timeMs: number): void {
    if (!this.compositeCtx || this.subtitleCues.length === 0) {
      return
    }

    const cue = findSubtitleCueAtTime(this.subtitleCues, timeMs)
    if (!cue) {
      return
    }

    renderSubtitleCue(
      this.compositeCtx,
      cue,
      timeMs,
      this.subtitleStyle,
      this.config.width,
      this.config.height,
    )
  }

  /** Draws the composited cursor onto `ctx` (composite or, when tilting, the foreground canvas). */
  private renderCursorLayer(timeMs: number, ctx: CanvasRenderingContext2D | null): void {
    if (!ctx || !this.layoutCache || !this.cameraContainer) {
      return
    }

    const drawCursorState = resolveCursorState({
      timeMs,
      track: this.config.cursorTrack,
      zoomRegions: this.config.zoomRegions,
      fallbackFocus: { cx: this.animationState.focusX, cy: this.animationState.focusY },
      style: this.config.cursorStyle,
    })

    if (!drawCursorState.visible) return

    const drawProjected = projectCursorToViewport({
      normalizedX: drawCursorState.x,
      normalizedY: drawCursorState.y,
      cropRegion: this.config.cropRegion,
      baseOffset: this.layoutCache.baseOffset,
      maskRect: this.layoutCache.maskRect,
      cameraScale: {
        x: this.cameraContainer.scale.x,
        y: this.cameraContainer.scale.y,
      },
      cameraPosition: {
        x: this.cameraContainer.position.x,
        y: this.cameraContainer.position.y,
      },
      stageSize: this.layoutCache.stageSize,
    })

    if (!drawProjected.inViewport) return

    const cursorSizeNorm = resolveCursorSizeNorm({
      maskRect: this.layoutCache.maskRect,
      cropRegion: this.config.cropRegion,
    })
    const motionBlurPx = getCursorMotionBlurPx({
      motionBlur: this.config.cursorStyle?.motionBlur ?? 0,
      point: { x: drawProjected.x, y: drawProjected.y },
      state: this.cursorMotionBlurState,
      timeMs,
      sizeNorm: cursorSizeNorm,
    })

    drawCompositedCursor(
      ctx,
      { x: drawProjected.x, y: drawProjected.y },
      drawCursorState,
      this.config.cursorStyle,
      resolveCursorContentScale({
        cameraScale: { x: this.cameraContainer.scale.x, y: this.cameraContainer.scale.y },
        maskRect: this.layoutCache.maskRect,
        cropRegion: this.config.cropRegion,
      }),
      {
        motionBlurPx,
        // The export mask is drawn at 0,0 inside the video container placed at
        // baseOffset, so offset the mask rect into camera-local coordinates
        // (same frame the preview overlay uses).
        clipRect: resolveCursorClipRect({
          style: this.config.cursorStyle,
          maskRect: {
            x: this.layoutCache.baseOffset.x + this.layoutCache.maskRect.x,
            y: this.layoutCache.baseOffset.y + this.layoutCache.maskRect.y,
            width: this.layoutCache.maskRect.width,
            height: this.layoutCache.maskRect.height,
          },
          maskBorderRadius: this.layoutCache.maskBorderRadius,
          cameraScale: { x: this.cameraContainer.scale.x, y: this.cameraContainer.scale.y },
          cameraPosition: {
            x: this.cameraContainer.position.x,
            y: this.cameraContainer.position.y,
          },
        }),
      },
    )
  }

  private updateLayout(): void {
    if (!this.app || !this.videoSprite || !this.maskGraphics || !this.videoContainer) return

    const { width, height } = this.config
    const { cropRegion, borderRadius = 0, padding = 0 } = this.config
    const videoWidth = this.config.videoWidth
    const videoHeight = this.config.videoHeight

    // The mask path only depends on the crop rect, the corner radius, the
    // padding and the canvas/preview sizes, none of which move during an
    // export. Keying on them keeps `Graphics.clear()` + `roundRect()` — a
    // re-tessellation and a GPU buffer upload — out of the frame loop, and
    // makes it explicit that a future mid-export crop change would rebuild.
    const geometryKey = buildMaskGeometryKey({
      width,
      height,
      videoWidth,
      videoHeight,
      cropRegion,
      borderRadius,
      padding,
      previewWidth: this.config.previewWidth || 1920,
      previewHeight: this.config.previewHeight || 1080,
    })
    if (this.maskGeometryKey === geometryKey && this.layoutCache) {
      return
    }
    this.maskGeometryKey = geometryKey
    this.stats.layoutRebuilds += 1

    // Calculate cropped video dimensions
    const cropStartX = cropRegion.x
    const cropStartY = cropRegion.y
    const cropEndX = cropRegion.x + cropRegion.width
    const cropEndY = cropRegion.y + cropRegion.height

    const croppedVideoWidth = videoWidth * (cropEndX - cropStartX)
    const croppedVideoHeight = videoHeight * (cropEndY - cropStartY)

    // Calculate scale to fit in viewport
    // Padding is a percentage (0-100), where 50% ~ 0.8 scale
    const paddingScale = 1.0 - (padding / 100) * 0.4
    const viewportWidth = width * paddingScale
    const viewportHeight = height * paddingScale
    const scale = Math.min(viewportWidth / croppedVideoWidth, viewportHeight / croppedVideoHeight)

    // Position video sprite
    this.videoSprite.width = videoWidth * scale
    this.videoSprite.height = videoHeight * scale

    const cropPixelX = cropStartX * videoWidth * scale
    const cropPixelY = cropStartY * videoHeight * scale
    this.videoSprite.x = -cropPixelX
    this.videoSprite.y = -cropPixelY

    // Position video container
    const croppedDisplayWidth = croppedVideoWidth * scale
    const croppedDisplayHeight = croppedVideoHeight * scale
    const centerOffsetX = (width - croppedDisplayWidth) / 2
    const centerOffsetY = (height - croppedDisplayHeight) / 2
    this.videoContainer.x = centerOffsetX
    this.videoContainer.y = centerOffsetY

    // scale border radius by export/preview canvas ratio
    const previewWidth = this.config.previewWidth || 1920
    const previewHeight = this.config.previewHeight || 1080
    const canvasScaleFactor = Math.min(width / previewWidth, height / previewHeight)
    const scaledBorderRadius = borderRadius * canvasScaleFactor

    this.maskGraphics.clear()
    this.maskGraphics.roundRect(0, 0, croppedDisplayWidth, croppedDisplayHeight, scaledBorderRadius)
    this.maskGraphics.fill({ color: 0xffffff })

    // Cache layout info
    this.layoutCache = {
      stageSize: { width, height },
      videoSize: { width: croppedVideoWidth, height: croppedVideoHeight },
      baseScale: scale,
      baseOffset: { x: centerOffsetX, y: centerOffsetY },
      maskRect: { x: 0, y: 0, width: croppedDisplayWidth, height: croppedDisplayHeight },
      maskBorderRadius: scaledBorderRadius,
    }
  }

  /**
   * Same step as the preview ticker (zoomCamera.ts): resolve the eased target
   * for content time `timeMs` (auto-follow regions read the cursor telemetry),
   * smooth the auto-follow focus and spring-chase the transform by the
   * content-time delta. Always "animating" - the exporter never takes the
   * paused/scrub snap branch; only the first frame or a jump larger than
   * ZOOM_SPRING_MAX_STEP_MS snaps the spring.
   */
  private updateAnimationState(timeMs: number): void {
    if (!this.cameraContainer || !this.layoutCache) return

    const { target } = stepZoomCamera(
      this.zoomCamera,
      this.config.zoomRegions,
      timeMs,
      { stageSize: this.layoutCache.stageSize, baseMask: this.layoutCache.maskRect },
      { animating: true, cursorTelemetry: this.cursorTelemetry },
    )

    const state = this.animationState
    state.scale = target.scale
    state.focusX = target.focus.cx
    state.focusY = target.focus.cy
    state.progress = target.progress
    // Already ramped by the eased progress inside the shared step (preview parity).
    this.currentRotation3D = target.rotation3D
  }

  // On Linux/Wayland the implicit GPU-to-2D texture-sharing path behind
  // drawImage(webglCanvas) can fail silently (EGL/Ozone), giving green/empty
  // frames. gl.readPixels copies GPU to CPU directly, bypassing that path.
  private readbackVideoCanvas(): HTMLCanvasElement {
    const glCanvas = this.app!.canvas as HTMLCanvasElement
    const gl =
      (glCanvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
      (glCanvas.getContext('webgl') as WebGLRenderingContext | null)

    if (!gl || !this.rasterCanvas || !this.rasterCtx) {
      return glCanvas
    }

    const w = glCanvas.width
    const h = glCanvas.height
    const buf = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    flipPixelRowsInPlace(buf, w, h)

    const imageData = new ImageData(new Uint8ClampedArray(buf.buffer), w, h)
    this.rasterCtx.putImageData(imageData, 0, 0)

    return this.rasterCanvas
  }

  /** Clears the composite canvas and draws the background (blur pre-baked at init). */
  private drawBackground(): void {
    if (!this.compositeCanvas || !this.compositeCtx) return

    const ctx = this.compositeCtx
    const w = this.compositeCanvas.width
    const h = this.compositeCanvas.height

    ctx.clearRect(0, 0, w, h)

    if (this.backgroundSprite) {
      const bgCanvas = this.backgroundSprite as any as HTMLCanvasElement
      ctx.drawImage(bgCanvas, 0, 0, w, h)
    } else {
      console.warn('[FrameRenderer] No background sprite found during compositing!')
    }
  }

  /**
   * Draws `videoCanvas` (the Pixi stage, or the tilted foreground) onto the
   * composite canvas, through the drop-shadow filter when shadows are on.
   */
  private drawVideoLayer(videoCanvas: HTMLCanvasElement): void {
    if (!this.compositeCanvas || !this.compositeCtx) return

    const ctx = this.compositeCtx
    const w = this.compositeCanvas.width
    const h = this.compositeCanvas.height

    if (
      this.config.showShadow &&
      this.config.shadowIntensity > 0 &&
      this.shadowCanvas &&
      this.shadowCtx
    ) {
      // Shadow intensity never changes mid-export, so the filter string is
      // built once.
      if (!this.cachedShadowFilter) {
        this.cachedShadowFilter = buildShadowFilter(this.config.shadowIntensity)
      }

      if (!this.legacyCompositor && this.drawCachedShadowLayer(videoCanvas)) {
        // The shadow is behind the video, so `shadow over background` then
        // `video over that` is the same composite the filter produces in one
        // step (source-over is associative) — without re-blurring 2 Mpx.
        ctx.drawImage(videoCanvas, 0, 0, w, h)
        return
      }

      const shadowCtx = this.shadowCtx
      shadowCtx.clearRect(0, 0, w, h)
      shadowCtx.save()
      shadowCtx.filter = this.cachedShadowFilter
      shadowCtx.drawImage(videoCanvas, 0, 0, w, h)
      shadowCtx.restore()
      ctx.drawImage(this.shadowCanvas, 0, 0, w, h)
    } else {
      ctx.drawImage(videoCanvas, 0, 0, w, h)
    }
  }

  /**
   * Draws the cached drop-shadow layer for the current silhouette onto the
   * composite canvas and reports whether it did. `false` means the caller must
   * fall back to filtering this frame directly, which is what happens while the
   * camera is moving.
   */
  private drawCachedShadowLayer(videoCanvas: HTMLCanvasElement): boolean {
    if (!this.compositeCtx || !this.layoutCache || !this.cameraContainer) return false

    const key = buildShadowGeometryKey({
      width: this.config.width,
      height: this.config.height,
      shadowIntensity: this.config.shadowIntensity,
      maskWidth: this.layoutCache.maskRect.width,
      maskHeight: this.layoutCache.maskRect.height,
      maskBorderRadius: this.layoutCache.maskBorderRadius,
      baseOffsetX: this.layoutCache.baseOffset.x,
      baseOffsetY: this.layoutCache.baseOffset.y,
      cameraScaleX: this.cameraContainer.scale.x,
      cameraScaleY: this.cameraContainer.scale.y,
      cameraX: this.cameraContainer.position.x,
      cameraY: this.cameraContainer.position.y,
      rotation3D: this.currentRotation3D,
    })

    // Rasterising costs more than one filtered draw, so it is only worth doing
    // for a silhouette that is going to be reused. A camera in motion produces
    // a new key every frame and takes this branch every time, at the price of
    // one string comparison.
    if (key !== this.previousShadowKey) {
      this.previousShadowKey = key
      return false
    }

    if (key !== this.shadowGeometryKey) {
      if (!this.rasteriseShadowLayer(videoCanvas)) return false
      this.shadowGeometryKey = key
      this.stats.shadowRasterisations += 1
    }

    if (!this.shadowLayerCanvas) return false
    this.compositeCtx.drawImage(this.shadowLayerCanvas, 0, 0, this.config.width, this.config.height)
    return true
  }

  /**
   * Rebuilds `shadowLayerCanvas` so it holds the drop shadow *alone*.
   *
   * `ctx.filter = drop-shadow(...)` draws `source over shadow`; the shadow half
   * is what has to be cached, because the source half is the video and changes
   * every frame. All three shadows in the chain are pure black, so the layer is
   * fully described by an alpha channel, and filtering an opaque-black
   * silhouette with the same alpha as the video gives
   * `aF = aSil + aShadow * (1 - aSil)`, which inverts exactly.
   */
  private rasteriseShadowLayer(videoCanvas: HTMLCanvasElement): boolean {
    const w = this.config.width
    const h = this.config.height

    if (!this.silhouetteCanvas || !this.silhouetteCtx) {
      this.silhouetteCanvas = document.createElement('canvas')
      this.silhouetteCanvas.width = w
      this.silhouetteCanvas.height = h
      this.silhouetteCtx = this.silhouetteCanvas.getContext('2d', { willReadFrequently: true })
    }
    if (!this.shadowLayerCanvas || !this.shadowLayerCtx) {
      this.shadowLayerCanvas = document.createElement('canvas')
      this.shadowLayerCanvas.width = w
      this.shadowLayerCanvas.height = h
      this.shadowLayerCtx = this.shadowLayerCanvas.getContext('2d', { willReadFrequently: true })
    }
    const silCtx = this.silhouetteCtx
    const layerCtx = this.shadowLayerCtx
    if (!silCtx || !layerCtx || !this.cachedShadowFilter) return false

    silCtx.save()
    silCtx.globalCompositeOperation = 'source-over'
    silCtx.clearRect(0, 0, w, h)
    silCtx.drawImage(videoCanvas, 0, 0, w, h)
    // Replace the video's colours with black, keeping its alpha: the shadow is
    // cast from the alpha channel only.
    silCtx.globalCompositeOperation = 'source-in'
    silCtx.fillStyle = '#000000'
    silCtx.fillRect(0, 0, w, h)
    silCtx.restore()

    layerCtx.save()
    layerCtx.globalCompositeOperation = 'source-over'
    layerCtx.clearRect(0, 0, w, h)
    layerCtx.filter = this.cachedShadowFilter
    layerCtx.drawImage(this.silhouetteCanvas, 0, 0, w, h)
    layerCtx.restore()

    let filtered: ImageData
    let silhouette: ImageData
    try {
      filtered = layerCtx.getImageData(0, 0, w, h)
      silhouette = silCtx.getImageData(0, 0, w, h)
    } catch {
      // A tainted or zero-sized canvas: stay on the per-frame filter path.
      return false
    }

    const out = filtered.data
    const sil = silhouette.data
    for (let i = 3; i < out.length; i += 4) {
      const aSil = sil[i]
      if (aSil >= 255) {
        // Fully covered by the video; the shadow underneath is never visible.
        out[i] = 0
        continue
      }
      const aFiltered = out[i]
      const shadowAlpha = ((aFiltered - aSil) * 255) / (255 - aSil)
      out[i] = shadowAlpha <= 0 ? 0 : shadowAlpha >= 255 ? 255 : Math.round(shadowAlpha)
    }
    // The layer is black everywhere, so the colour channels stay at zero and
    // only the recovered alpha is written back.
    layerCtx.putImageData(filtered, 0, 0)
    return true
  }

  getCanvas(): HTMLCanvasElement {
    if (!this.compositeCanvas) {
      throw new Error('Renderer not initialized')
    }
    return this.compositeCanvas
  }

  destroy(): void {
    if (this.videoSprite) {
      this.videoSprite.destroy()
      this.videoSprite = null
    }
    this.currentVideoSource = null
    // Only the source this renderer built itself: `videoSprite.destroy()`
    // above leaves the texture alone, and the caller owns the last VideoFrame.
    if (this.videoFrameSource) {
      this.videoFrameSource.destroy()
      this.videoFrameSource = null
    }
    this.videoFrameSourceSize = null
    this.backgroundSprite = null
    // Through the lifecycle so a destroy that arrives while `initialize` is
    // still waiting on the driver is honoured when that init lands. Both paths
    // pass `{ removeView: true }` rather than `true`: `true` also releases
    // Pixi's global batch, texture and canvas pools, which the editor's preview
    // renderer is using at the same time, and its next frame then throws.
    if (this.appLifecycle) {
      this.appLifecycle.destroy()
      this.appLifecycle = null
    } else {
      destroyPixiApplication(this.app)
    }
    this.app = null
    this.cameraContainer = null
    this.videoContainer = null
    this.maskGraphics = null
    this.motionBlurFilter = null
    if (this.threeDPass) {
      this.threeDPass.destroy()
      this.threeDPass = null
    }
    this.foregroundCanvas = null
    this.foregroundCtx = null
    this.shadowCanvas = null
    this.shadowCtx = null
    this.shadowLayerCanvas = null
    this.shadowLayerCtx = null
    this.silhouetteCanvas = null
    this.silhouetteCtx = null
    this.shadowGeometryKey = null
    this.previousShadowKey = null
    this.maskGeometryKey = null
    this.compositeCanvas = null
    this.compositeCtx = null
    this.rasterCanvas = null
    this.rasterCtx = null
  }
}
