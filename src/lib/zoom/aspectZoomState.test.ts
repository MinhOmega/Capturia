import { describe, expect, it } from 'vitest'

import type { ZoomRegion } from '@/components/video-editor/types'

import {
  applyZoomLevelToAllAspects,
  clearStaleSelectedZoomIdForAspect,
  getSelectedZoomIdForAspect,
  getZoomLevel,
  getZoomRegionsForAspect,
  setSelectedZoomIdForAspect,
  setZoomRegionsForAspect,
  type SelectedZoomIdByAspect,
  type ZoomRegionsByAspect,
} from './aspectZoomState'

function createZoomRegion(id: string): ZoomRegion {
  return {
    id,
    startMs: 0,
    endMs: 500,
    depth: 3,
    focus: { cx: 0.5, cy: 0.5 },
  }
}

describe('aspectZoomState', () => {
  it('returns empty regions and null selected id for missing aspect state', () => {
    const regionsByAspect: ZoomRegionsByAspect = {}
    const selectedByAspect: SelectedZoomIdByAspect = {}

    expect(getZoomRegionsForAspect(regionsByAspect, '1:1')).toEqual([])
    expect(getSelectedZoomIdForAspect(selectedByAspect, '1:1')).toBeNull()
  })

  it('writes zoom regions only for the targeted aspect', () => {
    const widescreen = [createZoomRegion('zoom-a')]
    const vertical = [createZoomRegion('zoom-b')]
    const regionsByAspect = setZoomRegionsForAspect({}, '16:9', widescreen)
    const next = setZoomRegionsForAspect(regionsByAspect, '9:16', vertical)

    expect(getZoomRegionsForAspect(next, '16:9')).toBe(widescreen)
    expect(getZoomRegionsForAspect(next, '9:16')).toBe(vertical)
  })

  it('keeps state reference when selected id does not change', () => {
    const selectedByAspect: SelectedZoomIdByAspect = { '16:9': 'zoom-1' }
    const next = setSelectedZoomIdForAspect(selectedByAspect, '16:9', 'zoom-1')
    expect(next).toBe(selectedByAspect)
  })

  it('clears stale selected ids per aspect without touching other aspects', () => {
    const selectedByAspect: SelectedZoomIdByAspect = {
      '16:9': 'missing-zoom',
      '9:16': 'zoom-v',
    }
    const regionsByAspect: ZoomRegionsByAspect = {
      '16:9': [createZoomRegion('zoom-w')],
      '9:16': [createZoomRegion('zoom-v')],
    }

    const next = clearStaleSelectedZoomIdForAspect(selectedByAspect, regionsByAspect, '16:9')
    expect(next['16:9']).toBeNull()
    expect(next['9:16']).toBe('zoom-v')
  })
})

describe('native aspect key', () => {
  it("stores and reads zoom regions and selection under 'native' like any fixed ratio", () => {
    const region = { id: 'zoom-1', startMs: 0, endMs: 1000 } as unknown as ZoomRegion
    const regions: ZoomRegionsByAspect = setZoomRegionsForAspect({ '16:9': [] }, 'native', [region])
    expect(getZoomRegionsForAspect(regions, 'native')).toEqual([region])
    expect(getZoomRegionsForAspect(regions, '16:9')).toEqual([])

    const selected: SelectedZoomIdByAspect = setSelectedZoomIdForAspect({}, 'native', 'zoom-1')
    expect(getSelectedZoomIdForAspect(selected, 'native')).toBe('zoom-1')
    expect(clearStaleSelectedZoomIdForAspect(selected, regions, 'native')).toBe(selected)
    expect(
      getSelectedZoomIdForAspect(
        clearStaleSelectedZoomIdForAspect(selected, { native: [] }, 'native'),
        'native',
      ),
    ).toBeNull()
  })
})

describe('applyZoomLevelToAllAspects', () => {
  const level = (depth: ZoomRegion['depth'], customScale?: number) =>
    customScale == null ? { depth } : { depth, customScale }

  it('gives every zoom of every aspect the same depth and custom scale', () => {
    const regionsByAspect: ZoomRegionsByAspect = {
      '16:9': [createZoomRegion('zoom-a'), { ...createZoomRegion('zoom-b'), depth: 1 }],
      '9:16': [{ ...createZoomRegion('zoom-c'), depth: 6, customScale: 4.2 }],
    }

    const next = applyZoomLevelToAllAspects(regionsByAspect, level(2, 1.6))

    for (const regions of Object.values(next)) {
      for (const region of regions ?? []) {
        expect(region.depth).toBe(2)
        expect(region.customScale).toBe(1.6)
        expect(region.source).toBe('manual')
      }
    }
    // Ids and spans are untouched: only the level is applied.
    expect((next['16:9'] ?? []).map((r) => r.id)).toEqual(['zoom-a', 'zoom-b'])
    expect(next['9:16']?.[0].startMs).toBe(0)
  })

  it('drops customScale when the applied level has none, so the depth preset wins again', () => {
    const regionsByAspect: ZoomRegionsByAspect = {
      '16:9': [{ ...createZoomRegion('zoom-a'), depth: 6, customScale: 4.2 }],
    }

    const next = applyZoomLevelToAllAspects(regionsByAspect, level(4))

    expect(next['16:9']?.[0].depth).toBe(4)
    expect(next['16:9']?.[0]).not.toHaveProperty('customScale')
  })

  it('returns the input untouched when every region already has the level', () => {
    const regionsByAspect: ZoomRegionsByAspect = {
      '16:9': [createZoomRegion('zoom-a')],
      '9:16': [createZoomRegion('zoom-b')],
    }

    expect(applyZoomLevelToAllAspects(regionsByAspect, level(3))).toBe(regionsByAspect)
  })

  it('keeps the array of an aspect that needs no change, so the history dedupe sees no edit', () => {
    const settled = [createZoomRegion('zoom-a')]
    const regionsByAspect: ZoomRegionsByAspect = {
      '16:9': settled,
      '9:16': [{ ...createZoomRegion('zoom-b'), depth: 1 }],
    }

    const next = applyZoomLevelToAllAspects(regionsByAspect, level(3))

    expect(next).not.toBe(regionsByAspect)
    expect(next['16:9']).toBe(settled)
    expect(next['9:16']?.[0].depth).toBe(3)
    // Every aspect the input had is still present.
    expect(Object.keys(next).sort()).toEqual(Object.keys(regionsByAspect).sort())
  })

  it('getZoomLevel reads the level a region resolves to', () => {
    expect(getZoomLevel({ depth: 3 })).toEqual({ depth: 3 })
    expect(getZoomLevel({ depth: 3, customScale: 2.1 })).toEqual({ depth: 3, customScale: 2.1 })
  })
})
