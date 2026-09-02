import { describe, expect, it } from 'vitest'
import {
  conformPlanarChannels,
  downmixPlanarChannelsForExport,
  getStereoDownmixWeights,
} from './downmix'

describe('downmixPlanarChannelsForExport', () => {
  it('preserves non-front Windows system audio channels when exporting stereo', () => {
    const sourcePlanes = Array.from({ length: 8 }, (_, channel) => {
      const plane = new Float32Array(2)
      if (channel === 2) {
        plane[0] = 0.8
        plane[1] = 0.4
      }
      if (channel === 6) {
        plane[0] = 0.2
        plane[1] = 0.1
      }
      return plane
    })

    const stereo = downmixPlanarChannelsForExport(sourcePlanes, 2)

    expect(stereo[0]).toBeGreaterThan(0)
    expect(stereo[1]).toBeGreaterThan(0)
    expect(stereo[2]).toBeGreaterThan(0)
    expect(stereo[3]).toBeGreaterThan(0)
  })

  it('duplicates mono microphone audio when exporting stereo', () => {
    const mono = new Float32Array([0.25, -0.5])

    const stereo = downmixPlanarChannelsForExport([mono], 2)

    expect(Array.from(stereo)).toEqual([0.25, -0.5, 0.25, -0.5])
  })

  it('passes stereo through untouched', () => {
    const left = new Float32Array([0.1, 0.2])
    const right = new Float32Array([-0.1, -0.2])

    const out = downmixPlanarChannelsForExport([left, right], 2)
    expect(Array.from(out.subarray(0, 2))).toEqual(Array.from(left))
    expect(Array.from(out.subarray(2, 4))).toEqual(Array.from(right))
  })

  it('averages every channel when exporting mono', () => {
    const planes = [
      new Float32Array([1, 0]),
      new Float32Array([0, 1]),
      new Float32Array([0.5, 0.5]),
    ]

    expect(Array.from(downmixPlanarChannelsForExport(planes, 1))).toEqual([0.5, 0.5])
  })

  it('keeps 5.1 surround content on the correct side', () => {
    // FL, FR, FC, LFE, BL, BR
    const planes = Array.from({ length: 6 }, () => new Float32Array(1))
    planes[4][0] = 1 // back-left only

    const stereo = downmixPlanarChannelsForExport(planes, 2)
    expect(stereo[0]).toBeGreaterThan(0)
    expect(stereo[1]).toBe(0)
  })

  it('rejects unsupported target channel counts', () => {
    expect(() => downmixPlanarChannelsForExport([new Float32Array(1)], 3)).toThrow(
      /Unsupported target channel count/,
    )
  })
})

describe('conformPlanarChannels', () => {
  it('returns the same planes when the channel count already matches', () => {
    const planes = [new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.4])]
    expect(conformPlanarChannels(planes, 2)).toBe(planes)
  })

  it('duplicates mono to stereo and folds surround to two planes', () => {
    const mono = conformPlanarChannels([new Float32Array([0.5, -0.5])], 2)
    expect(mono.length).toBe(2)
    expect(Array.from(mono[0])).toEqual([0.5, -0.5])
    expect(Array.from(mono[1])).toEqual([0.5, -0.5])

    const surround = Array.from(
      { length: 6 },
      (_, channel) => new Float32Array([channel === 1 ? 0.8 : 0]),
    )
    const stereo = conformPlanarChannels(surround, 2)
    expect(stereo.length).toBe(2)
    expect(stereo[0][0]).toBe(0)
    expect(stereo[1][0]).toBeGreaterThan(0)
  })

  it('yields empty planes for an empty input', () => {
    const out = conformPlanarChannels([], 2)
    expect(out.map((plane) => plane.length)).toEqual([0, 0])
  })
})

describe('getStereoDownmixWeights', () => {
  it('maps 7.1 surround and side channels into both stereo channels', () => {
    const { left, right } = getStereoDownmixWeights(8)
    expect(left.map(([channel]) => channel)).toEqual([0, 2, 3, 4, 6])
    expect(right.map(([channel]) => channel)).toEqual([1, 2, 3, 5, 7])
  })

  it('falls back to a front-centre mix for 3-channel sources', () => {
    const { left, right } = getStereoDownmixWeights(3)
    expect(left.map(([channel]) => channel)).toEqual([0, 2])
    expect(right.map(([channel]) => channel)).toEqual([1, 2])
  })
})
