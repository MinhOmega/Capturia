import type { AnnotationTextAnimation } from '@/components/video-editor/types';
import { splitGraphemes } from '@/lib/exporter/textWrap';

export const TEXT_ANIMATION_DURATION_MS = 700;

export interface TextAnimationState {
  opacity: number;
  scale: number;
  translateX: number;
  translateY: number;
  revealProgress: number;
}

export const TEXT_ANIMATION_OPTIONS: Array<{
  value: AnnotationTextAnimation;
  translationKey: string;
}> = [
  { value: 'none', translationKey: 'textAnimation.none' },
  { value: 'fade', translationKey: 'textAnimation.fade' },
  { value: 'rise', translationKey: 'textAnimation.rise' },
  { value: 'pop', translationKey: 'textAnimation.pop' },
  { value: 'slide-left', translationKey: 'textAnimation.slideLeft' },
  { value: 'typewriter', translationKey: 'textAnimation.typewriter' },
  { value: 'pulse', translationKey: 'textAnimation.pulse' },
];

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function easeOutCubic(value: number) {
  const t = clamp(value);
  return 1 - (1 - t) ** 3;
}

function easeOutBack(value: number) {
  const t = clamp(value);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

export function normalizeTextAnimation(value: unknown): AnnotationTextAnimation {
  return TEXT_ANIMATION_OPTIONS.some((option) => option.value === value)
    ? (value as AnnotationTextAnimation)
    : 'none';
}

/**
 * Animation state of a text annotation at `currentTimeMs`. The animation runs
 * for TEXT_ANIMATION_DURATION_MS from the annotation's startMs; both the
 * preview overlay and the exporter derive their transforms from this.
 */
export function getTextAnimationState(
  annotation: {
    startMs: number;
    style: {
      textAnimation?: AnnotationTextAnimation;
    };
  },
  currentTimeMs: number,
): TextAnimationState {
  const animation = normalizeTextAnimation(annotation.style.textAnimation);
  if (animation === 'none') {
    return {
      opacity: 1,
      scale: 1,
      translateX: 0,
      translateY: 0,
      revealProgress: 1,
    };
  }

  const elapsedMs = Math.max(0, currentTimeMs - annotation.startMs);
  const progress = clamp(elapsedMs / TEXT_ANIMATION_DURATION_MS);
  const eased = easeOutCubic(progress);

  switch (animation) {
    case 'fade':
      return {
        opacity: eased,
        scale: 1,
        translateX: 0,
        translateY: 0,
        revealProgress: 1,
      };
    case 'rise':
      return {
        opacity: eased,
        scale: 1,
        translateX: 0,
        translateY: (1 - eased) * 18,
        revealProgress: 1,
      };
    case 'pop':
      return {
        opacity: eased,
        scale: Math.max(0.72, easeOutBack(progress)),
        translateX: 0,
        translateY: 0,
        revealProgress: 1,
      };
    case 'slide-left':
      return {
        opacity: eased,
        scale: 1,
        translateX: (1 - eased) * -28,
        translateY: 0,
        revealProgress: 1,
      };
    case 'typewriter':
      return {
        opacity: 1,
        scale: 1,
        translateX: 0,
        translateY: 0,
        revealProgress: progress,
      };
    case 'pulse':
      return {
        opacity: 1,
        scale: 1 + Math.sin(progress * Math.PI) * 0.06,
        translateX: 0,
        translateY: 0,
        revealProgress: 1,
      };
    default:
      return {
        opacity: 1,
        scale: 1,
        translateX: 0,
        translateY: 0,
        revealProgress: 1,
      };
  }
}

/**
 * CSS applied by the preview overlay for a given animation state. Kept as a
 * pure function so the exporter parity test can compare it with the canvas
 * transform below at fixed times.
 */
export function textAnimationToCss(state: TextAnimationState): {
  opacity: number;
  transform: string;
  transformOrigin: 'center';
  clipPath: string | undefined;
} {
  return {
    opacity: state.opacity,
    transform: `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`,
    transformOrigin: 'center',
    clipPath:
      state.revealProgress < 1
        ? `inset(0 ${100 - state.revealProgress * 100}% 0 0)`
        : undefined,
  };
}

/**
 * Canvas equivalent of `textAnimationToCss`: translate/scale about the box
 * centre (CSS `transform-origin: center`) and multiply the alpha. Translation
 * is in preview pixels, so it is scaled by `scaleFactor` for the export size.
 */
export function applyTextAnimationToCanvas(
  ctx: Pick<CanvasRenderingContext2D, 'translate' | 'scale' | 'globalAlpha'>,
  state: TextAnimationState,
  originX: number,
  originY: number,
  scaleFactor: number,
): void {
  ctx.translate(originX, originY);
  ctx.translate(state.translateX * scaleFactor, state.translateY * scaleFactor);
  ctx.scale(state.scale, state.scale);
  ctx.translate(-originX, -originY);
  ctx.globalAlpha *= state.opacity;
}

/**
 * Typewriter reveal for the exporter: the preview clips the span from the
 * right with `clip-path: inset(...)`; the exporter slices graphemes instead.
 */
export function getRevealedText(line: string, revealProgress: number): string {
  if (revealProgress >= 1) return line;
  const graphemes = splitGraphemes(line);
  const visibleCount = Math.ceil(graphemes.length * Math.max(0, revealProgress));
  return graphemes.slice(0, visibleCount).join('');
}
