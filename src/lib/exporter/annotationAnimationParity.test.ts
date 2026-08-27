import { describe, expect, it } from 'vitest';
import type { AnnotationRegion, AnnotationTextAnimation } from '@/components/video-editor/types';
import { DEFAULT_ANNOTATION_STYLE } from '@/components/video-editor/types';
import {
  getRevealedText,
  getTextAnimationState,
  TEXT_ANIMATION_DURATION_MS,
  TEXT_ANIMATION_OPTIONS,
  textAnimationToCss,
} from '@/lib/annotationTextAnimation';
import { renderAnnotations } from './annotationRenderer';
import { splitGraphemes } from './textWrap';

/**
 * Preview (CSS in AnnotationOverlay) and export (canvas in annotationRenderer)
 * both derive from getTextAnimationState. This test evaluates each preset at
 * fixed times and checks the numbers that reach the DOM style and the canvas
 * context are the same.
 */

type Call = { name: string; args: unknown[] };

function createRecordingContext(graphemeWidth = 10) {
  const calls: Call[] = [];
  const fillTexts: Array<{ text: string; x: number; y: number; alpha: number }> = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
    };
  const ctx = {
    globalAlpha: 1,
    font: '',
    textBaseline: 'alphabetic',
    textAlign: 'start',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    save: record('save'),
    restore: record('restore'),
    translate: record('translate'),
    scale: record('scale'),
    beginPath: record('beginPath'),
    rect: record('rect'),
    clip: record('clip'),
    roundRect: record('roundRect'),
    fill: record('fill'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
    measureText: (text: string) => ({ width: splitGraphemes(text).length * graphemeWidth }),
    fillText(text: string, x: number, y: number) {
      fillTexts.push({ text, x, y, alpha: ctx.globalAlpha });
      calls.push({ name: 'fillText', args: [text, x, y] });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, fillTexts };
}

function textAnnotation(textAnimation: AnnotationTextAnimation, content = 'Hello world'): AnnotationRegion {
  return {
    id: 'annotation-1',
    startMs: 1000,
    endMs: 5000,
    type: 'text',
    content,
    position: { x: 10, y: 10 },
    size: { width: 50, height: 20 },
    style: { ...DEFAULT_ANNOTATION_STYLE, textAlign: 'left', textAnimation },
    zIndex: 1,
  };
}

const CSS_NUMBER = '(-?[\\d.]+(?:e-?\\d+)?)';

function parseCssTransform(transform: string) {
  const match = transform.match(
    new RegExp(`^translate\\(${CSS_NUMBER}px, ${CSS_NUMBER}px\\) scale\\(${CSS_NUMBER}\\)$`),
  );
  if (!match) throw new Error(`Unexpected transform: ${transform}`);
  return { translateX: Number(match[1]), translateY: Number(match[2]), scale: Number(match[3]) };
}

function expectArgsClose(actual: unknown[] | undefined, expected: number[]) {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, i) => expect(actual?.[i]).toBeCloseTo(value, 10));
}

const SAMPLE_OFFSETS_MS = [0, 100, 350, TEXT_ANIMATION_DURATION_MS - 1, TEXT_ANIMATION_DURATION_MS, 2500];
const PRESETS = TEXT_ANIMATION_OPTIONS.map((option) => option.value);

describe('text animation parity between preview CSS and export canvas', () => {
  for (const preset of PRESETS) {
    for (const offset of SAMPLE_OFFSETS_MS) {
      it(`${preset} at +${offset}ms applies the same opacity, scale and translation`, async () => {
        const annotation = textAnnotation(preset);
        const timeMs = annotation.startMs + offset;
        const scaleFactor = 2;
        const canvasWidth = 1000;
        const canvasHeight = 500;

        const state = getTextAnimationState(annotation, timeMs);
        const css = parseCssTransform(textAnimationToCss(state).transform);
        const cssOpacity = textAnimationToCss(state).opacity;

        const { ctx, calls, fillTexts } = createRecordingContext();
        await renderAnnotations(ctx, [annotation], canvasWidth, canvasHeight, timeMs, scaleFactor);

        const scaleCall = calls.find((c) => c.name === 'scale');
        expectArgsClose(scaleCall?.args, [css.scale, css.scale]);

        // translate(origin) -> translate(offset * scaleFactor) -> scale -> translate(-origin)
        const translateCalls = calls.filter((c) => c.name === 'translate');
        expect(translateCalls).toHaveLength(3);
        const originX = (annotation.position.x / 100) * canvasWidth + ((annotation.size.width / 100) * canvasWidth) / 2;
        const originY = (annotation.position.y / 100) * canvasHeight + ((annotation.size.height / 100) * canvasHeight) / 2;
        expectArgsClose(translateCalls[0].args, [originX, originY]);
        expectArgsClose(translateCalls[1].args, [css.translateX * scaleFactor, css.translateY * scaleFactor]);
        expectArgsClose(translateCalls[2].args, [-originX, -originY]);

        if (fillTexts.length > 0) {
          expect(fillTexts[0].alpha).toBeCloseTo(cssOpacity, 10);
        } else {
          // Nothing drawn only happens for the typewriter before the first grapheme reveals
          expect(preset).toBe('typewriter');
          expect(state.revealProgress).toBe(0);
        }
      });
    }
  }

  it('typewriter reveals the same fraction: CSS clip-path inset vs exported grapheme slice', async () => {
    const content = 'Xin chào 你好世界';
    const annotation = textAnnotation('typewriter', content);
    const graphemes = splitGraphemes(content);

    for (const offset of SAMPLE_OFFSETS_MS) {
      const timeMs = annotation.startMs + offset;
      const state = getTextAnimationState(annotation, timeMs);
      const css = textAnimationToCss(state);

      const { ctx, fillTexts } = createRecordingContext();
      await renderAnnotations(ctx, [annotation], 2000, 1000, timeMs, 1);
      const drawn = fillTexts.map((f) => f.text).join('');

      if (state.revealProgress >= 1) {
        expect(css.clipPath).toBeUndefined();
        expect(drawn).toBe(content);
      } else {
        const hiddenPercent = Number(css.clipPath?.match(/inset\(0 ([\d.]+)% 0 0\)/)?.[1]);
        expect(hiddenPercent).toBeCloseTo(100 - state.revealProgress * 100, 10);
        const expectedVisible = graphemes.slice(0, Math.ceil(graphemes.length * state.revealProgress)).join('');
        expect(drawn).toBe(expectedVisible);
        expect(getRevealedText(content, state.revealProgress)).toBe(expectedVisible);
      }
    }
  });

  it('typewriter keeps the full line alignment origin while revealing (centre aligned)', async () => {
    const annotation = textAnnotation('typewriter', 'abcdefghij');
    annotation.style.textAlign = 'center';
    const halfway = annotation.startMs + TEXT_ANIMATION_DURATION_MS / 2;

    const full = createRecordingContext();
    await renderAnnotations(full.ctx, [annotation], 1000, 500, annotation.startMs + 3000, 1);
    const partial = createRecordingContext();
    await renderAnnotations(partial.ctx, [annotation], 1000, 500, halfway, 1);

    expect(partial.fillTexts[0].text.length).toBeLessThan(full.fillTexts[0].text.length);
    // Same x: the revealed prefix starts where the full line starts, like clip-path does
    expect(partial.fillTexts[0].x).toBe(full.fillTexts[0].x);
  });

  it('static preview (no playhead) resolves to the finished state for every preset', () => {
    for (const preset of PRESETS) {
      const state = getTextAnimationState(textAnnotation(preset), Number.POSITIVE_INFINITY);
      expect(state.opacity).toBe(1);
      expect(state.scale).toBeCloseTo(1, 10);
      expect(state.translateX).toBeCloseTo(0, 10);
      expect(state.translateY).toBeCloseTo(0, 10);
      expect(state.revealProgress).toBe(1);
    }
  });
});
