import type { AnnotationRegion, ArrowDirection } from '@/components/video-editor/types'
import { getRenderableAnnotations } from '@/lib/annotations/renderOrder'
import {
  applyTextAnimationToCanvas,
  getRevealedText,
  getTextAnimationState,
} from '@/lib/annotationTextAnimation'
import { wrapTextLines } from './textWrap'

// SVG path data for each arrow direction
const ARROW_PATHS: Record<ArrowDirection, string[]> = {
  'up': ['M 50 20 L 50 80', 'M 50 20 L 35 35', 'M 50 20 L 65 35'],
  'down': ['M 50 20 L 50 80', 'M 50 80 L 35 65', 'M 50 80 L 65 65'],
  'left': ['M 80 50 L 20 50', 'M 20 50 L 35 35', 'M 20 50 L 35 65'],
  'right': ['M 20 50 L 80 50', 'M 80 50 L 65 35', 'M 80 50 L 65 65'],
  'up-right': ['M 25 75 L 75 25', 'M 75 25 L 60 30', 'M 75 25 L 70 40'],
  'up-left': ['M 75 75 L 25 25', 'M 25 25 L 40 30', 'M 25 25 L 30 40'],
  'down-right': ['M 25 25 L 75 75', 'M 75 75 L 70 60', 'M 75 75 L 60 70'],
  'down-left': ['M 75 25 L 25 75', 'M 25 75 L 30 60', 'M 25 75 L 40 70'],
}

const ANNOTATION_IMAGE_CACHE_LIMIT = 128
const annotationImageCache = new Map<string, Promise<HTMLImageElement | null>>()

function loadAnnotationImage(content: string): Promise<HTMLImageElement | null> {
  const cached = annotationImageCache.get(content)
  if (cached) {
    return cached
  }

  const loading = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => {
      console.error('[AnnotationRenderer] Failed to load image annotation')
      resolve(null)
    }
    img.src = content
  })

  annotationImageCache.set(content, loading)
  if (annotationImageCache.size > ANNOTATION_IMAGE_CACHE_LIMIT) {
    const oldestKey = annotationImageCache.keys().next().value as string | undefined
    if (oldestKey) {
      annotationImageCache.delete(oldestKey)
    }
  }

  return loading
}

function parseSvgPath(
  pathString: string,
  scaleX: number,
  scaleY: number,
): Array<{ cmd: string; args: number[] }> {
  const commands: Array<{ cmd: string; args: number[] }> = []
  const parts = pathString.trim().split(/\s+/)

  let i = 0
  while (i < parts.length) {
    const cmd = parts[i]
    if (cmd === 'M' || cmd === 'L') {
      const x = parseFloat(parts[i + 1]) * scaleX
      const y = parseFloat(parts[i + 2]) * scaleY
      commands.push({ cmd, args: [x, y] })
      i += 3
    } else {
      i++
    }
  }

  return commands
}

function renderArrow(
  ctx: CanvasRenderingContext2D,
  direction: ArrowDirection,
  color: string,
  strokeWidth: number,
  x: number,
  y: number,
  width: number,
  height: number,
  _scaleFactor: number,
) {
  const paths = ARROW_PATHS[direction]
  if (!paths) return

  ctx.save()
  ctx.translate(x, y)

  const padding = 8 * _scaleFactor
  const availableWidth = Math.max(0, width - padding * 2)
  const availableHeight = Math.max(0, height - padding * 2)

  const scale = Math.min(availableWidth / 100, availableHeight / 100)

  const offsetX = padding + (availableWidth - 100 * scale) / 2
  const offsetY = padding + (availableHeight - 100 * scale) / 2

  // Apply centering offset
  ctx.translate(offsetX, offsetY)

  // Apply shadow filter
  ctx.shadowColor = 'rgba(0, 0, 0, 0.3)'
  ctx.shadowBlur = 8 * scale
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 4 * scale

  ctx.strokeStyle = color
  ctx.lineWidth = strokeWidth * scale
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // Draw all paths as a single shape to avoid overlapping shadows/strokes
  ctx.beginPath()

  for (const pathString of paths) {
    const commands = parseSvgPath(pathString, scale, scale)

    for (const { cmd, args } of commands) {
      if (cmd === 'M') {
        ctx.moveTo(args[0], args[1])
      } else if (cmd === 'L') {
        ctx.lineTo(args[0], args[1])
      }
    }
  }

  ctx.stroke()

  ctx.restore()
}

/**
 * Layout constants mirrored from the preview overlay (`AnnotationOverlay`):
 * Tailwind `p-2` on the container, `padding: 0.1em 0.2em` and
 * `line-height: 1.4` on the span. The wrap width and the per-line background
 * box derive from the same numbers so preview and export break lines at the
 * same width.
 */
const TEXT_BOX_PADDING_PX = 8
const TEXT_SPAN_HORIZONTAL_PADDING_EM = 0.2
const TEXT_SPAN_VERTICAL_PADDING_EM = 0.1
const TEXT_LINE_HEIGHT = 1.4

function renderText(
  ctx: CanvasRenderingContext2D,
  annotation: AnnotationRegion,
  x: number,
  y: number,
  width: number,
  height: number,
  scaleFactor: number,
  currentTimeMs: number,
) {
  const style = annotation.style
  const animationState = getTextAnimationState(annotation, currentTimeMs)

  ctx.save()

  // Entrance animation about the box centre (preview: transform-origin center)
  applyTextAnimationToCanvas(ctx, animationState, x + width / 2, y + height / 2, scaleFactor)

  // Clip to the box, matching the preview's overflow: hidden
  ctx.beginPath()
  ctx.rect(x, y, width, height)
  ctx.clip()

  const scaledFontSize = style.fontSize * scaleFactor
  ctx.font = getAnnotationFontShorthand(style, scaleFactor)
  ctx.textBaseline = 'middle'

  const containerPadding = TEXT_BOX_PADDING_PX * scaleFactor
  const horizontalPadding = scaledFontSize * TEXT_SPAN_HORIZONTAL_PADDING_EM
  const verticalPadding = scaledFontSize * TEXT_SPAN_VERTICAL_PADDING_EM

  let textX = x
  const textY = y + height / 2

  if (style.textAlign === 'center') {
    textX = x + width / 2
  } else if (style.textAlign === 'right') {
    textX = x + width - containerPadding - horizontalPadding
  } else {
    textX = x + containerPadding + horizontalPadding
  }

  // Same available width as the preview span: the box minus the container
  // padding and the span's own horizontal padding on both sides.
  const availableWidth = width - containerPadding * 2 - horizontalPadding * 2
  const lines = wrapTextLines(
    annotation.content,
    availableWidth,
    (text) => ctx.measureText(text).width,
  )
  const lineHeight = scaledFontSize * TEXT_LINE_HEIGHT

  const startY = textY - ((lines.length - 1) * lineHeight) / 2

  // Lines are drawn left-aligned from their own start x so the typewriter
  // reveal keeps the full line's alignment origin (the preview clips the span
  // from the right instead of re-centring the visible part).
  ctx.textAlign = 'left'

  lines.forEach((fullLine, index) => {
    const currentY = startY + index * lineHeight
    const line = getRevealedText(fullLine, animationState.revealProgress)
    if (!line && animationState.revealProgress < 1) return

    const fullWidth = ctx.measureText(fullLine).width
    const lineStartX =
      style.textAlign === 'center'
        ? textX - fullWidth / 2
        : style.textAlign === 'right'
          ? textX - fullWidth
          : textX

    if (style.backgroundColor && style.backgroundColor !== 'transparent') {
      const metrics = ctx.measureText(line)
      const borderRadius = 4 * scaleFactor

      const bgX = lineStartX - horizontalPadding
      const bgWidth = metrics.width + horizontalPadding * 2

      const bgHeight = lineHeight + verticalPadding * 2
      const bgY = currentY - bgHeight / 2

      ctx.fillStyle = style.backgroundColor
      ctx.beginPath()
      ctx.roundRect(bgX, bgY, bgWidth, bgHeight, borderRadius)
      ctx.fill()
    }

    ctx.fillStyle = style.color
    ctx.fillText(line, lineStartX, currentY)

    if (style.textDecoration === 'underline') {
      const metrics = ctx.measureText(line)
      const underlineX = lineStartX
      const underlineY = currentY + scaledFontSize * 0.15

      ctx.strokeStyle = style.color
      ctx.lineWidth = Math.max(1, scaledFontSize / 16)
      ctx.beginPath()
      ctx.moveTo(underlineX, underlineY)
      ctx.lineTo(underlineX + metrics.width, underlineY)
      ctx.stroke()
    }
  })

  ctx.restore()
}

async function renderImage(
  ctx: CanvasRenderingContext2D,
  annotation: AnnotationRegion,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  if (!annotation.content || !annotation.content.startsWith('data:image')) {
    return
  }

  const img = await loadAnnotationImage(annotation.content)
  if (!img) {
    return
  }

  // Preserve aspect ratio - contain the image within the bounds
  const imgAspect = img.width / img.height
  const boxAspect = width / height

  let drawWidth = width
  let drawHeight = height
  let drawX = x
  let drawY = y

  if (imgAspect > boxAspect) {
    drawHeight = width / imgAspect
    drawY = y + (height - drawHeight) / 2
  } else {
    drawWidth = height * imgAspect
    drawX = x + (width - drawWidth) / 2
  }

  ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight)
}

const FONT_LOAD_TIMEOUT_MS = 5000

/** The CSS font shorthand used both to load a family and to draw with it. */
export function getAnnotationFontShorthand(
  style: AnnotationRegion['style'],
  scaleFactor = 1,
): string {
  const fontWeight = style.fontWeight === 'bold' ? 'bold' : 'normal'
  const fontStyle = style.fontStyle === 'italic' ? 'italic' : 'normal'
  return `${fontStyle} ${fontWeight} ${style.fontSize * scaleFactor}px ${style.fontFamily}`
}

/**
 * Wait for the web fonts used by text annotations to be loaded. Canvas
 * `fillText` falls back silently when a `@font-face` family has not been
 * fetched yet (they load lazily, on first use in the DOM), so the exporter
 * awaits `document.fonts.load` for every distinct face before rendering.
 * Failures and timeouts are logged, never thrown: a fallback font is better
 * than a failed export.
 */
export async function preloadAnnotationFonts(
  annotations: AnnotationRegion[],
  fontFaceSet: Pick<FontFaceSet, 'load'> | undefined = typeof document !== 'undefined'
    ? document.fonts
    : undefined,
): Promise<void> {
  if (!fontFaceSet || typeof fontFaceSet.load !== 'function') return
  const shorthands = new Set<string>()
  for (const annotation of annotations) {
    if (annotation.type !== 'text' || !annotation.content) continue
    shorthands.add(getAnnotationFontShorthand(annotation.style))
  }
  if (shorthands.size === 0) return

  await Promise.all(
    Array.from(shorthands, async (shorthand) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          fontFaceSet.load(shorthand),
          new Promise<void>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Font load timeout')), FONT_LOAD_TIMEOUT_MS)
          }),
        ])
      } catch (err) {
        console.warn(
          '[AnnotationRenderer] Font not ready for export, falling back:',
          shorthand,
          err,
        )
      } finally {
        if (timer) clearTimeout(timer)
      }
    }),
  )
}

/** Pre-load all image annotations so renderAnnotations never blocks on I/O. */
export async function preloadAnnotationImages(annotations: AnnotationRegion[]): Promise<void> {
  const imageAnnotations = annotations.filter(
    (a) => a.type === 'image' && a.content && a.content.startsWith('data:image'),
  )
  if (imageAnnotations.length === 0) return
  await Promise.all(imageAnnotations.map((a) => loadAnnotationImage(a.content)))
}

export async function renderAnnotations(
  ctx: CanvasRenderingContext2D,
  annotations: AnnotationRegion[],
  canvasWidth: number,
  canvasHeight: number,
  currentTimeMs: number,
  scaleFactor: number = 1.0,
): Promise<void> {
  const sortedAnnotations = getRenderableAnnotations(annotations, currentTimeMs)

  for (const annotation of sortedAnnotations) {
    const x = (annotation.position.x / 100) * canvasWidth
    const y = (annotation.position.y / 100) * canvasHeight
    const width = (annotation.size.width / 100) * canvasWidth
    const height = (annotation.size.height / 100) * canvasHeight

    switch (annotation.type) {
      case 'text':
        renderText(ctx, annotation, x, y, width, height, scaleFactor, currentTimeMs)
        break

      case 'image':
        await renderImage(ctx, annotation, x, y, width, height)
        break

      case 'figure':
        if (annotation.figureData) {
          renderArrow(
            ctx,
            annotation.figureData.arrowDirection,
            annotation.figureData.color,
            annotation.figureData.strokeWidth,
            x,
            y,
            width,
            height,
            scaleFactor,
          )
        }
        break
    }
  }
}
