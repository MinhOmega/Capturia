import { describe, expect, it } from 'vitest'
import {
  computeRotation3DContainScale,
  DEFAULT_ROTATION_3D,
  ROTATION_3D_PRESET_ORDER,
  ROTATION_3D_PRESETS,
  rotation3DPerspective,
  type Rotation3D,
} from '@/components/video-editor/types'
import {
  buildMvpMatrix,
  multiplyMat4,
  perspectiveFovY,
  transformPoint,
  unpremultiplyAndFlipRows,
} from './threeDPass'

/** Runs a quad corner (pixel units, +y down, z = 0) through the MVP the way the
 * vertex shader does (including the clip.y flip) and perspective-divides. */
function projectCorner(mvp: Float32Array, x: number, y: number): { x: number; y: number } {
  const [cx, cy, , cw] = transformPoint(mvp, x, y, 0)
  return { x: cx / cw, y: -cy / cw }
}

function corners(w: number, h: number): Array<[number, number]> {
  return [
    [-w / 2, -h / 2], // TL
    [w / 2, -h / 2], // TR
    [w / 2, h / 2], // BR
    [-w / 2, h / 2], // BL
  ]
}

function maxExtent(rot: Rotation3D, w: number, h: number) {
  const mvp = buildMvpMatrix(rot, w, h)
  let maxX = 0
  let maxY = 0
  for (const [x, y] of corners(w, h)) {
    const p = projectCorner(mvp, x, y)
    maxX = Math.max(maxX, Math.abs(p.x))
    maxY = Math.max(maxY, Math.abs(p.y))
  }
  return { maxX, maxY }
}

describe('multiplyMat4 / transformPoint (column-major)', () => {
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  const translate = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1])

  it('multiplies with the identity and applies translation from the last column', () => {
    expect(Array.from(multiplyMat4(identity, translate))).toEqual(Array.from(translate))
    expect(transformPoint(translate, 1, 2, 3)).toEqual([6, 8, 10, 1])
  })
})

describe('perspectiveFovY', () => {
  it('puts a point at half the height on the clip-space edge for a viewer at `perspective`', () => {
    const h = 1080
    const d = rotation3DPerspective(1920, h)
    const fov = perspectiveFovY(h, d)
    expect(Math.tan(fov / 2) * d).toBeCloseTo(h / 2, 6)
  })
})

describe('buildMvpMatrix', () => {
  const W = 1920
  const H = 1080

  it('maps the unrotated quad exactly onto the clip-space square, top-left up', () => {
    const mvp = buildMvpMatrix(DEFAULT_ROTATION_3D, W, H)
    const [tl, tr, br, bl] = corners(W, H).map(([x, y]) => projectCorner(mvp, x, y))
    expect(tl.x).toBeCloseTo(-1, 5)
    expect(tl.y).toBeCloseTo(1, 5)
    expect(tr.x).toBeCloseTo(1, 5)
    expect(tr.y).toBeCloseTo(1, 5)
    expect(br.x).toBeCloseTo(1, 5)
    expect(br.y).toBeCloseTo(-1, 5)
    expect(bl.x).toBeCloseTo(-1, 5)
    expect(bl.y).toBeCloseTo(-1, 5)
  })

  it('keeps every preset inside the viewport, close to the limiting edge (contain scale)', () => {
    // The contain scale is derived from the unscaled projection, but (like CSS
    // `scale(s) rotate...`) it is applied in 3D before the perspective divide,
    // which also scales z and softens the perspective. It is therefore slightly
    // conservative: the quad lands just inside the clip square, never outside.
    // The closer the camera (lower perspective factor), the more conservative.
    for (const preset of ROTATION_3D_PRESET_ORDER) {
      const { maxX, maxY } = maxExtent(ROTATION_3D_PRESETS[preset], W, H)
      expect(maxX).toBeLessThanOrEqual(1 + 1e-5)
      expect(maxY).toBeLessThanOrEqual(1 + 1e-5)
      expect(Math.max(maxX, maxY)).toBeGreaterThan(0.9)
    }
  })

  it('agrees with the preview contain scale: without it the quad would spill over', () => {
    const rot = ROTATION_3D_PRESETS.iso
    const d = rotation3DPerspective(W, H)
    const contain = computeRotation3DContainScale(rot, W, H, d)
    expect(contain).toBeLessThan(1)
    // Undo the contain scale by feeding a quad `1 / contain` larger through the same MVP:
    // the limiting extent then exceeds the clip square by exactly that factor.
    const mvp = buildMvpMatrix(rot, W, H)
    let spill = 0
    for (const [x, y] of corners(W, H)) {
      const p = projectCorner(mvp, x / contain, y / contain)
      spill = Math.max(spill, Math.abs(p.x), Math.abs(p.y))
    }
    expect(spill).toBeGreaterThan(1)
  })

  it('"right" recedes the right edge and "left" the left edge (CSS rotateY sign)', () => {
    const right = buildMvpMatrix(ROTATION_3D_PRESETS.right, W, H)
    const [tl, tr] = corners(W, H).map(([x, y]) => projectCorner(right, x, y))
    // The receding edge is farther from the viewer, so it projects shorter (smaller |y|).
    expect(Math.abs(tr.y)).toBeLessThan(Math.abs(tl.y))

    const left = buildMvpMatrix(ROTATION_3D_PRESETS.left, W, H)
    const [ltl, ltr] = corners(W, H).map(([x, y]) => projectCorner(left, x, y))
    expect(Math.abs(ltl.y)).toBeLessThan(Math.abs(ltr.y))
    // Mirror presets are mirror images.
    expect(ltl.y).toBeCloseTo(tr.y, 5)
    expect(ltr.y).toBeCloseTo(tl.y, 5)
  })

  it('"iso" brings the top edge toward the viewer (rotateX -12) and recedes the left edge (rotateY -18)', () => {
    const mvp = buildMvpMatrix(ROTATION_3D_PRESETS.iso, W, H)
    const [tl, tr, br, bl] = corners(W, H).map(([x, y]) => projectCorner(mvp, x, y))
    // CSS rotateX(-12) with +y down: z' = y sin(-12deg), so the top (y < 0) gets z' > 0,
    // i.e. moves toward the viewer and projects wider than the bottom edge.
    expect(tr.x - tl.x).toBeGreaterThan(br.x - bl.x)
    // CSS rotateY(-18): z' = -x sin(-18deg) < 0 for x < 0, so the left edge recedes (shorter).
    expect(Math.abs(bl.y - tl.y)).toBeLessThan(Math.abs(br.y - tr.y))
  })

  it('no preset projects an edge parallel to the frame (the "truncated" look)', () => {
    // Each projected edge must be at least 1 degree off the horizontal / vertical it
    // would otherwise coincide with; a parallel edge reads as a clipping rectangle.
    const MIN_DEG = 1
    for (const preset of ROTATION_3D_PRESET_ORDER) {
      const mvp = buildMvpMatrix(ROTATION_3D_PRESETS[preset], W, H)
      const [tl, tr, br, bl] = corners(W, H).map(([x, y]) => projectCorner(mvp, x, y))
      // Compare in pixel-ish units so the clip-space aspect does not skew the angle.
      const px = (p: { x: number; y: number }) => ({ x: (p.x * W) / 2, y: (p.y * H) / 2 })
      const horizontal: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
        [px(tl), px(tr)],
        [px(bl), px(br)],
      ]
      const vertical: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
        [px(tl), px(bl)],
        [px(tr), px(br)],
      ]
      for (const [a, b] of horizontal) {
        const deg = Math.abs((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI)
        expect(Math.min(deg, 180 - deg)).toBeGreaterThanOrEqual(MIN_DEG)
      }
      for (const [a, b] of vertical) {
        const deg = Math.abs((Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI)
        expect(Math.min(deg, 180 - deg)).toBeGreaterThanOrEqual(MIN_DEG)
      }
    }
  })

  it('applies the rotations in CSS order (Z, then Y, then X) like the preview contain scale', () => {
    // Project each corner by hand in CSS order with the same viewer distance and
    // contain scale; the MVP must land on the same clip-space points.
    const rot = ROTATION_3D_PRESETS.iso
    const d = rotation3DPerspective(W, H)
    const s = computeRotation3DContainScale(rot, W, H, d)
    const a = (rot.rotationX * Math.PI) / 180
    const b = (rot.rotationY * Math.PI) / 180
    const g = (rot.rotationZ * Math.PI) / 180
    const mvp = buildMvpMatrix(rot, W, H)
    for (const [x0, y0] of corners(W, H)) {
      let x = x0 * s
      let y = y0 * s
      let z = 0
      ;[x, y] = [x * Math.cos(g) - y * Math.sin(g), x * Math.sin(g) + y * Math.cos(g)]
      ;[x, z] = [x * Math.cos(b) + z * Math.sin(b), -x * Math.sin(b) + z * Math.cos(b)]
      ;[y, z] = [y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)]
      const f = d / (d - z)
      // projectCorner flips y (clip-space up = pixel-space top).
      const expected = { x: (x * f) / (W / 2), y: -(y * f) / (H / 2) }
      const got = projectCorner(mvp, x0, y0)
      expect(got.x).toBeCloseTo(expected.x, 5)
      expect(got.y).toBeCloseTo(expected.y, 5)
    }
  })

  it('is resolution independent: 1080p and 4K project to the same clip-space corners', () => {
    for (const preset of ROTATION_3D_PRESET_ORDER) {
      const rot = ROTATION_3D_PRESETS[preset]
      const a = buildMvpMatrix(rot, 1920, 1080)
      const b = buildMvpMatrix(rot, 3840, 2160)
      const ca = corners(1920, 1080).map(([x, y]) => projectCorner(a, x, y))
      const cb = corners(3840, 2160).map(([x, y]) => projectCorner(b, x, y))
      for (let i = 0; i < 4; i += 1) {
        expect(ca[i].x).toBeCloseTo(cb[i].x, 5)
        expect(ca[i].y).toBeCloseTo(cb[i].y, 5)
      }
    }
  })
})

describe('unpremultiplyAndFlipRows (readPixels fallback)', () => {
  it('flips rows top-down and un-premultiplies partial alpha, leaving opaque / clear pixels alone', () => {
    // 1 px wide, 3 rows tall, bottom-up as gl.readPixels returns them.
    const bottomUp = new Uint8Array([
      100,
      50,
      0,
      255, // row 0 (bottom): opaque
      64,
      32,
      16,
      128, // row 1: premultiplied at 50 %
      7,
      7,
      7,
      0, // row 2 (top): fully transparent with garbage rgb
    ])
    const out = unpremultiplyAndFlipRows(bottomUp, 1, 3)
    expect(Array.from(out.slice(0, 4))).toEqual([0, 0, 0, 0])
    expect(Array.from(out.slice(4, 8))).toEqual([128, 64, 32, 128])
    expect(Array.from(out.slice(8, 12))).toEqual([100, 50, 0, 255])
  })

  it('clamps un-premultiplied channels to 255', () => {
    const out = unpremultiplyAndFlipRows(new Uint8Array([200, 0, 0, 100]), 1, 1)
    expect(out[0]).toBe(255)
    expect(out[3]).toBe(100)
  })
})
