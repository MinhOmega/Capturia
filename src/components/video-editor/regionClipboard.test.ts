import { beforeEach, describe, expect, it } from 'vitest';
import {
  applySegmentSpeed,
  buildPastedAnnotation,
  buildZoomRegion,
  clearCopiedRegion,
  extractAnnotationAttributes,
  extractSegmentSpeedAttributes,
  extractZoomAttributes,
  getCopiedRegion,
  replaceAnnotationAttributes,
  setCopiedRegion,
} from './regionClipboard';
import {
  type AnnotationRegion,
  DEFAULT_ANNOTATION_POSITION,
  DEFAULT_ANNOTATION_SIZE,
  DEFAULT_ANNOTATION_STYLE,
  DEFAULT_FIGURE_DATA,
  type VideoSegment,
  type ZoomRegion,
} from './types';

const zoom: ZoomRegion = {
  id: 'zoom-1',
  startMs: 1000,
  endMs: 3000,
  depth: 4,
  customScale: 2.75,
  focus: { cx: 0.2, cy: 0.8 },
  source: 'auto',
};

const segment: VideoSegment = { id: 'seg-1', startMs: 0, endMs: 500, deleted: false, speed: 2 };

const annotation: AnnotationRegion = {
  id: 'annotation-1',
  startMs: 0,
  endMs: 2000,
  type: 'figure',
  content: 'hello',
  position: { x: 10, y: 90 },
  size: { width: 40, height: 25 },
  style: { ...DEFAULT_ANNOTATION_STYLE, color: '#ff0000', textAnimation: 'pop' },
  zIndex: 3,
  figureData: { ...DEFAULT_FIGURE_DATA, color: '#123456' },
};

beforeEach(() => {
  clearCopiedRegion();
});

describe('session clipboard', () => {
  it('starts empty, stores the last copied region and can be cleared', () => {
    expect(getCopiedRegion()).toBeNull();
    setCopiedRegion(extractZoomAttributes(zoom));
    expect(getCopiedRegion()?.kind).toBe('zoom');
    setCopiedRegion(extractSegmentSpeedAttributes(segment));
    expect(getCopiedRegion()).toEqual({ kind: 'segmentSpeed', speed: 2 });
    clearCopiedRegion();
    expect(getCopiedRegion()).toBeNull();
  });
});

describe('zoom attribute copy/paste', () => {
  it('round-trips the copyable attributes onto a different clip while keeping its identity/timing', () => {
    const attrs = extractZoomAttributes(zoom);
    const target: ZoomRegion = {
      id: 'zoom-2',
      startMs: 9000,
      endMs: 9500,
      depth: 1,
      focus: { cx: 0.5, cy: 0.5 },
      source: 'manual',
    };
    const result = buildZoomRegion(target, attrs);

    expect(result.id).toBe('zoom-2');
    expect(result.startMs).toBe(9000);
    expect(result.endMs).toBe(9500);
    expect(result.depth).toBe(4);
    expect(result.customScale).toBe(2.75);
    expect(result.focus).toEqual({ cx: 0.2, cy: 0.8 });
  });

  it('deep-copies focus so the source and target are decoupled', () => {
    const attrs = extractZoomAttributes(zoom);
    const result = buildZoomRegion({ ...zoom, id: 'zoom-2' }, attrs);
    result.focus.cx = 0.99;
    expect(zoom.focus.cx).toBe(0.2);
    attrs.focus.cy = 0.01;
    expect(zoom.focus.cy).toBe(0.8);
  });

  it('tags the pasted region as manual so the auto-zoom wand toggle keeps it', () => {
    const attrs = extractZoomAttributes(zoom);
    expect(buildZoomRegion({ id: 'zoom-9', startMs: 0, endMs: 100 }, attrs).source).toBe('manual');
    expect(buildZoomRegion(zoom, attrs).source).toBe('manual');
  });

  it('builds a brand-new region from a stub base', () => {
    const attrs = extractZoomAttributes(zoom);
    const result = buildZoomRegion({ id: 'zoom-3', startMs: 100, endMs: 600 }, attrs);
    expect(result).toEqual({
      id: 'zoom-3',
      startMs: 100,
      endMs: 600,
      depth: 4,
      customScale: 2.75,
      focus: { cx: 0.2, cy: 0.8 },
      source: 'manual',
    });
  });
});

describe('segment speed copy/paste', () => {
  it('copies only the speed value', () => {
    const attrs = extractSegmentSpeedAttributes(segment);
    expect(attrs).toEqual({ kind: 'segmentSpeed', speed: 2 });
  });

  it('keeps the target segment timing, id and deletion state', () => {
    const attrs = extractSegmentSpeedAttributes(segment);
    const target: VideoSegment = { id: 'seg-2', startMs: 4000, endMs: 5000, deleted: true, speed: 1 };
    expect(applySegmentSpeed(target, attrs)).toEqual({
      id: 'seg-2',
      startMs: 4000,
      endMs: 5000,
      deleted: true,
      speed: 2,
    });
  });
});

describe('annotation copy captures everything', () => {
  it('captures styling plus content, type, and position', () => {
    const attrs = extractAnnotationAttributes(annotation);
    expect(attrs.type).toBe('figure');
    expect(attrs.content).toBe('hello');
    expect(attrs.position).toEqual({ x: 10, y: 90 });
    expect(attrs.style.color).toBe('#ff0000');
    expect(attrs.figureData?.color).toBe('#123456');
  });

  it('deep-copies nested objects so later edits to the source do not leak into the copy', () => {
    const source: AnnotationRegion = { ...annotation, style: { ...annotation.style } };
    const attrs = extractAnnotationAttributes(source);
    source.style.color = '#00ff00';
    source.position.x = 55;
    expect(attrs.style.color).toBe('#ff0000');
    expect(attrs.position.x).toBe(10);
    source.position.x = 10;
  });
});

describe('paste onto an existing annotation applies styling only', () => {
  it("overwrites the look/feel but keeps the target's content, position, timing, and zIndex", () => {
    const attrs = extractAnnotationAttributes(annotation);
    const target: AnnotationRegion = {
      id: 'annotation-2',
      startMs: 7000,
      endMs: 8000,
      type: 'text',
      content: 'world',
      position: { ...DEFAULT_ANNOTATION_POSITION },
      size: { ...DEFAULT_ANNOTATION_SIZE },
      style: { ...DEFAULT_ANNOTATION_STYLE },
      zIndex: 9,
    };
    const result = replaceAnnotationAttributes(target, attrs);

    expect(result.content).toBe('world');
    expect(result.position).toEqual(DEFAULT_ANNOTATION_POSITION);
    expect(result.startMs).toBe(7000);
    expect(result.zIndex).toBe(9);
    expect(result.style.color).toBe('#ff0000');
    expect(result.style.textAnimation).toBe('pop');
    expect(result.size).toEqual({ width: 40, height: 25 });
    // Target is text, so the copied figure's figureData must NOT attach (F5 guard).
    expect(result.figureData).toBeUndefined();
  });

  it("keeps the target's own figure data when the copied region has none", () => {
    const textAttrs = extractAnnotationAttributes({ ...annotation, figureData: undefined });
    const figureTarget: AnnotationRegion = { ...annotation, id: 'annotation-3' };
    const result = replaceAnnotationAttributes(figureTarget, textAttrs);
    expect(result.figureData?.color).toBe('#123456');
  });
});

describe('paste as a new annotation clones the full copy', () => {
  it('clones type, content, styling, and position; takes timing/identity from the base', () => {
    const attrs = extractAnnotationAttributes(annotation);
    const result = buildPastedAnnotation(
      { id: 'annotation-4', startMs: 12000, endMs: 14000, zIndex: 5 },
      attrs,
    );

    expect(result.id).toBe('annotation-4');
    expect(result.startMs).toBe(12000);
    expect(result.endMs).toBe(14000);
    expect(result.zIndex).toBe(5);
    expect(result.type).toBe('figure');
    expect(result.content).toBe('hello');
    expect(result.position).toEqual({ x: 10, y: 90 });
    expect(result.style.color).toBe('#ff0000');
    expect(result.figureData?.color).toBe('#123456');
  });

  it('deep-copies position so source and clone are decoupled', () => {
    const attrs = extractAnnotationAttributes(annotation);
    const result = buildPastedAnnotation(
      { id: 'annotation-5', startMs: 0, endMs: 1000, zIndex: 1 },
      attrs,
    );
    result.position.x = 99;
    expect(annotation.position.x).toBe(10);
    expect(attrs.position.x).toBe(10);
  });

  it('nudges the clone by the offset, clamped so the box stays inside the frame', () => {
    const attrs = extractAnnotationAttributes(annotation);
    const nudged = buildPastedAnnotation(
      { id: 'annotation-6', startMs: 0, endMs: 1000, zIndex: 1 },
      attrs,
      4,
    );
    // x: 10 + 4 = 14; y: 90 + 4 = 94 but the 25%-tall box may not exceed 75.
    expect(nudged.position).toEqual({ x: 14, y: 75 });
  });
});

describe('zoom paste replaces customScale destructively (F4)', () => {
  it("clears the target's customScale when the copied zoom is preset-only", () => {
    const presetOnly = extractZoomAttributes({ ...zoom, customScale: undefined });
    expect('customScale' in presetOnly).toBe(false);
    const target: ZoomRegion = { ...zoom, id: 'zoom-3', customScale: 1.5 };
    const result = buildZoomRegion(target, presetOnly);
    expect(result.customScale).toBeUndefined();
    expect('customScale' in result).toBe(false);
  });
});

describe('figureData guard on paste-onto-existing (F5)', () => {
  it('does not attach figureData onto a non-figure target', () => {
    const figureAttrs = extractAnnotationAttributes(annotation);
    const textTarget: AnnotationRegion = {
      id: 'annotation-7',
      startMs: 0,
      endMs: 1000,
      type: 'text',
      content: 'hi',
      position: { ...DEFAULT_ANNOTATION_POSITION },
      size: { ...DEFAULT_ANNOTATION_SIZE },
      style: { ...DEFAULT_ANNOTATION_STYLE },
      zIndex: 1,
    };
    const result = replaceAnnotationAttributes(textTarget, figureAttrs);
    expect(result.figureData).toBeUndefined();
    // Styling still applies regardless of type.
    expect(result.style.color).toBe('#ff0000');
  });

  it('applies figureData when the target is itself a figure', () => {
    const figureAttrs = extractAnnotationAttributes(annotation);
    const figureTarget: AnnotationRegion = {
      ...annotation,
      id: 'annotation-8',
      figureData: { ...DEFAULT_FIGURE_DATA, color: '#000000' },
    };
    const result = replaceAnnotationAttributes(figureTarget, figureAttrs);
    expect(result.figureData?.color).toBe('#123456');
  });
});
