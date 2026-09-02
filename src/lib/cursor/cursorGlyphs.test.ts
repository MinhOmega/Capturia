import { describe, expect, it } from 'vitest';
import {
  CURSOR_GLYPH_ASSETS,
  CURSOR_GLYPH_SCALE,
  CURSOR_GLYPH_VIEWBOX,
  parseCursorGlyphSvg,
  resolveCursorGlyphDrawPlan,
  resolveCursorGlyphHotspot,
} from './cursorGlyphs';
import { CURSOR_KINDS } from './cursorKinds';

describe('bundled cursor glyph assets', () => {
  it('ships one SVG per kind except arrow, all on the 32-unit viewBox with a hotspot inside it', () => {
    for (const kind of CURSOR_KINDS) {
      const asset = CURSOR_GLYPH_ASSETS[kind];
      if (kind === 'arrow') {
        expect(asset).toBeUndefined();
        continue;
      }
      expect(asset, kind).toBeDefined();
      const parsed = parseCursorGlyphSvg(asset!.svg);
      expect(parsed.viewBox, kind).toEqual({ width: CURSOR_GLYPH_VIEWBOX, height: CURSOR_GLYPH_VIEWBOX });
      expect(parsed.shapes.length, kind).toBeGreaterThan(0);
      expect(asset!.hotspot.x, kind).toBeGreaterThanOrEqual(0);
      expect(asset!.hotspot.x, kind).toBeLessThanOrEqual(CURSOR_GLYPH_VIEWBOX);
      expect(asset!.hotspot.y, kind).toBeGreaterThanOrEqual(0);
      expect(asset!.hotspot.y, kind).toBeLessThanOrEqual(CURSOR_GLYPH_VIEWBOX);
      // Every shape paints something.
      for (const shape of parsed.shapes) {
        expect(shape.fill !== null || shape.stroke !== null, `${kind}: ${shape.d.slice(0, 20)}`).toBe(true);
      }
    }
  });

  it('carries the licence note in every asset', () => {
    for (const [kind, asset] of Object.entries(CURSOR_GLYPH_ASSETS)) {
      expect(asset?.svg, kind).toContain('Capturia original cursor glyph');
    }
  });

  it('hotspot table matches upstream semantics: centred for text/crosshair/resize, tip for arrows, fingertip for pointer', () => {
    const centred = ['text', 'crosshair', 'resize-ew', 'resize-ns', 'resize-nesw', 'resize-nwse', 'move', 'not-allowed', 'wait'] as const;
    for (const kind of centred) {
      expect(CURSOR_GLYPH_ASSETS[kind]?.hotspot, kind).toEqual({ x: 16, y: 16 });
    }
    expect(CURSOR_GLYPH_ASSETS['app-starting']?.hotspot).toEqual({ x: 5, y: 4 });
    expect(CURSOR_GLYPH_ASSETS.help?.hotspot).toEqual({ x: 5, y: 4 });
    expect(CURSOR_GLYPH_ASSETS['up-arrow']?.hotspot).toEqual({ x: 16, y: 3 });
    expect(CURSOR_GLYPH_ASSETS.pointer?.hotspot).toEqual({ x: 12, y: 3 });
    expect(CURSOR_GLYPH_ASSETS['open-hand']?.hotspot.y).toBeLessThan(16);
    expect(CURSOR_GLYPH_ASSETS['closed-hand']?.hotspot.y).toBeLessThan(16);
  });
});

describe('parseCursorGlyphSvg', () => {
  it('reads path data, paint, fill rule and stroke attributes', () => {
    const parsed = parseCursorGlyphSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 48">
        <!-- licence comment; a <path d="M0 0"/> inside it is ignored -->
        <path d="M1 1L2 2Z" fill="#abcdef" fill-rule="evenodd"/>
        <path d="M3 3V4" fill="none" stroke="#123456" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
        <path d="  " fill="#000"/>
        <path d="M5 5"/>
        <rect x="0" y="0" width="1" height="1"/>
      </svg>`);
    expect(parsed.viewBox).toEqual({ width: 64, height: 48 });
    expect(parsed.shapes).toEqual([
      { d: 'M1 1L2 2Z', fill: '#abcdef', fillRule: 'evenodd', stroke: null, strokeWidth: 1, lineCap: 'butt', lineJoin: 'miter' },
      { d: 'M3 3V4', fill: null, fillRule: 'nonzero', stroke: '#123456', strokeWidth: 2.5, lineCap: 'round', lineJoin: 'round' },
      // SVG default paint is black.
      { d: 'M5 5', fill: '#000000', fillRule: 'nonzero', stroke: null, strokeWidth: 1, lineCap: 'butt', lineJoin: 'miter' },
    ]);
  });

  it('falls back to the default viewBox when none is declared', () => {
    expect(parseCursorGlyphSvg('<svg><path d="M0 0"/></svg>').viewBox).toEqual({
      width: CURSOR_GLYPH_VIEWBOX,
      height: CURSOR_GLYPH_VIEWBOX,
    });
  });
});

describe('resolveCursorGlyphDrawPlan / resolveCursorGlyphHotspot', () => {
  it('returns a cached plan per kind scaled from the viewBox to 28 glyph units', () => {
    const plan = resolveCursorGlyphDrawPlan('text');
    expect(plan).not.toBeNull();
    expect(plan!.scale).toBeCloseTo(CURSOR_GLYPH_SCALE, 9);
    expect(plan!.scale * CURSOR_GLYPH_VIEWBOX).toBeCloseTo(28, 9);
    expect(resolveCursorGlyphDrawPlan('text')).toBe(plan);
    expect(resolveCursorGlyphDrawPlan('arrow')).toBeNull();
  });

  it('exposes the hotspot in glyph units, and (0,0) for the arrow tip', () => {
    expect(resolveCursorGlyphHotspot('arrow')).toEqual({ x: 0, y: 0 });
    const text = resolveCursorGlyphHotspot('text');
    expect(text.x).toBeCloseTo(16 * CURSOR_GLYPH_SCALE, 9);
    expect(text.y).toBeCloseTo(16 * CURSOR_GLYPH_SCALE, 9);
    const pointer = resolveCursorGlyphHotspot('pointer');
    expect(pointer.x).toBeCloseTo(12 * CURSOR_GLYPH_SCALE, 9);
    expect(pointer.y).toBeCloseTo(3 * CURSOR_GLYPH_SCALE, 9);
  });
});
