import { describe, expect, it } from 'vitest'
import {
  getSourceCopyFastPathBlockers,
  getSourceCopyProbeBlockers,
  isSourceCopyFastPathEligible,
  probeSourceCopyCandidate,
  type ProbeableInput,
  type SourceCopyFastPathInput,
  type SourceCopyProbe,
} from './sourceCopyFastPath'

/** The configuration the editor produces for an untouched recording. */
const CLEAN: SourceCopyFastPathInput = {
  aspectRatio: 'native',
  quality: 'source',
  padding: 0,
  videoPadding: 0,
  borderRadius: 0,
  showShadow: false,
  shadowIntensity: 0,
  showBlur: false,
  motionBlurAmount: 0,
  cropRegion: { x: 0, y: 0, width: 1, height: 1 },
  zoomRegions: [],
  trimRegions: [],
  segments: [{ id: 's', startMs: 0, endMs: 10_000, deleted: false, speed: 1 }],
  playbackSpeed: 1,
  annotationRegions: [],
  subtitleCues: [],
  cursorTrack: null,
  audioEditRegions: [],
  audioEnabled: true,
  audioGain: 1,
  audioProcessing: { normalizeLoudness: false },
}

function blockersFor(overrides: Partial<SourceCopyFastPathInput>): string[] {
  return getSourceCopyFastPathBlockers({ ...CLEAN, ...overrides })
}

describe('getSourceCopyFastPathBlockers', () => {
  it('has no blockers for an untouched native/source export', () => {
    expect(getSourceCopyFastPathBlockers(CLEAN)).toEqual([])
    expect(isSourceCopyFastPathEligible(CLEAN)).toBe(true)
  })

  it('tolerates absent optional fields but not an absent aspect ratio or quality', () => {
    expect(getSourceCopyFastPathBlockers({ aspectRatio: 'native', quality: 'source' })).toEqual([])
    expect(getSourceCopyFastPathBlockers({ quality: 'source' })).toEqual([
      'aspect ratio is unknown',
    ])
    expect(getSourceCopyFastPathBlockers({ aspectRatio: 'native' })).toEqual([
      'quality preset is unknown',
    ])
  })

  const cases: Array<[string, Partial<SourceCopyFastPathInput>, RegExp]> = [
    ['a fixed aspect ratio', { aspectRatio: '16:9' }, /aspect ratio 16:9 is not native/],
    ['a lower quality preset', { quality: 'good' }, /quality preset good/],
    ['a crop', { cropRegion: { x: 0.1, y: 0, width: 0.9, height: 1 } }, /crop/],
    ['padding', { padding: 4 }, /padding is not zero/],
    ['video padding', { videoPadding: 2 }, /video padding/],
    ['a corner radius', { borderRadius: 8 }, /corner radius/],
    ['a shadow flag', { showShadow: true }, /shadow/],
    ['a shadow intensity', { shadowIntensity: 0.5 }, /shadow/],
    ['background blur', { showBlur: true }, /blur/],
    ['motion blur', { motionBlurAmount: 0.3 }, /motion blur/],
    ['a trim region', { trimRegions: [{ id: 't', startMs: 0, endMs: 500 }] }, /trim/],
    [
      'a deleted segment',
      { segments: [{ id: 'a', startMs: 0, endMs: 100, deleted: true, speed: 1 }] },
      /deleted segments/,
    ],
    [
      'a segment speed',
      { segments: [{ id: 'a', startMs: 0, endMs: 100, deleted: false, speed: 1.5 }] },
      /speed other than 1x/,
    ],
    ['a global playback speed', { playbackSpeed: 2 }, /playback speed 2x/],
    [
      'a zoom region (also carries the 3D tilt preset)',
      {
        zoomRegions: [
          {
            id: 'z',
            startMs: 0,
            endMs: 1000,
            depth: 2,
            focus: { x: 0.5, y: 0.5 },
          } as unknown as NonNullable<SourceCopyFastPathInput['zoomRegions']>[number],
        ],
      },
      /zoom/,
    ],
    [
      'an annotation',
      {
        annotationRegions: [
          { id: 'a', startMs: 0, endMs: 1000 } as unknown as NonNullable<
            SourceCopyFastPathInput['annotationRegions']
          >[number],
        ],
      },
      /annotations/,
    ],
    [
      'subtitles',
      { subtitleCues: [{ id: 'c', startMs: 0, endMs: 900, text: 'hi', source: 'manual' }] },
      /subtitles/,
    ],
    [
      'a cursor track with samples',
      {
        cursorTrack: {
          samples: [{ tMs: 0, x: 0, y: 0 }],
        } as unknown as NonNullable<SourceCopyFastPathInput['cursorTrack']>,
      },
      /cursor overlay/,
    ],
    ['a webcam overlay', { webcamVideoUrl: 'file:///cam.webm' }, /webcam/],
    ['muted audio', { audioEnabled: false }, /audio is muted/],
    [
      'an audio edit region',
      { audioEditRegions: [{ id: 'e', startMs: 0, endMs: 200, mode: 'mute', gain: 0 }] },
      /audio edit regions/,
    ],
    ['an audio gain', { audioGain: 1.5 }, /audio gain 1.5/],
    ['loudness normalisation', { audioProcessing: { normalizeLoudness: true } }, /loudness/],
  ]

  for (const [label, overrides, pattern] of cases) {
    it(`blocks on ${label}`, () => {
      const blockers = blockersFor(overrides)
      expect(blockers).toHaveLength(1)
      expect(blockers[0]).toMatch(pattern)
    })
  }

  it('ignores empty regions and an empty cursor track', () => {
    expect(
      blockersFor({
        trimRegions: [{ id: 't', startMs: 100, endMs: 100 }],
        audioEditRegions: [{ id: 'e', startMs: 50, endMs: 50, mode: 'mute', gain: 0 }],
        cursorTrack: { samples: [] } as unknown as NonNullable<
          SourceCopyFastPathInput['cursorTrack']
        >,
      }),
    ).toEqual([])
  })

  it('lists every blocker, not just the first', () => {
    const blockers = blockersFor({ aspectRatio: '1:1', quality: 'medium', padding: 10 })
    expect(blockers).toHaveLength(3)
  })
})

describe('getSourceCopyProbeBlockers', () => {
  const MP4_PROBE: SourceCopyProbe = {
    isMp4: true,
    videoTrackCount: 1,
    audioTrackCount: 1,
    videoCodec: 'avc',
    audioCodec: 'aac',
    width: 1920,
    height: 1080,
  }
  const target = { width: 1920, height: 1080 }

  it('accepts a plain H.264 + AAC MP4 at the planned size', () => {
    expect(getSourceCopyProbeBlockers(MP4_PROBE, target)).toEqual([])
    expect(getSourceCopyProbeBlockers({ ...MP4_PROBE, videoCodec: 'hevc' }, target)).toEqual([])
    expect(getSourceCopyProbeBlockers({ ...MP4_PROBE, audioCodec: 'opus' }, target)).toEqual([])
    expect(
      getSourceCopyProbeBlockers({ ...MP4_PROBE, audioTrackCount: 0, audioCodec: null }, target),
    ).toEqual([])
  })

  it('rejects WebM and QuickTime containers', () => {
    expect(getSourceCopyProbeBlockers({ ...MP4_PROBE, isMp4: false }, target)).toEqual([
      'source container is not MP4',
    ])
  })

  it('rejects codecs a plain .mp4 cannot carry', () => {
    expect(getSourceCopyProbeBlockers({ ...MP4_PROBE, videoCodec: 'vp8' }, target)[0]).toMatch(
      /video codec vp8/,
    )
    expect(getSourceCopyProbeBlockers({ ...MP4_PROBE, videoCodec: null }, target)[0]).toMatch(
      /video codec unknown/,
    )
    expect(getSourceCopyProbeBlockers({ ...MP4_PROBE, audioCodec: 'pcm-s16' }, target)[0]).toMatch(
      /audio codec pcm-s16/,
    )
  })

  it('rejects multi-track sources that must be mixed', () => {
    expect(getSourceCopyProbeBlockers({ ...MP4_PROBE, audioTrackCount: 2 }, target)).toEqual([
      'source has 2 audio tracks (must be mixed)',
    ])
    expect(getSourceCopyProbeBlockers({ ...MP4_PROBE, videoTrackCount: 2 }, target)).toEqual([
      'source has 2 video tracks',
    ])
  })

  it('rejects an output size that differs from the source (odd source rounded to even)', () => {
    expect(
      getSourceCopyProbeBlockers(
        { ...MP4_PROBE, width: 1447, height: 901 },
        { width: 1446, height: 900 },
      ),
    ).toEqual(['output size 1446x900 differs from source 1447x901'])
  })
})

describe('probeSourceCopyCandidate', () => {
  function fakeInput(overrides: Partial<ProbeableInput> = {}): ProbeableInput {
    return {
      getFormat: async () => ({ name: 'MP4' }),
      getVideoTracks: async () => [{ codec: 'avc', displayWidth: 1280, displayHeight: 720 }],
      getAudioTracks: async () => [{ codec: 'aac' }],
      ...overrides,
    }
  }

  it('reads container, codecs, track counts and display size', async () => {
    await expect(probeSourceCopyCandidate(fakeInput())).resolves.toEqual({
      isMp4: true,
      videoTrackCount: 1,
      audioTrackCount: 1,
      videoCodec: 'avc',
      audioCodec: 'aac',
      width: 1280,
      height: 720,
    })
  })

  it('treats QuickTime and WebM as non-MP4 and copes with no tracks', async () => {
    await expect(
      probeSourceCopyCandidate(
        fakeInput({
          getFormat: async () => ({ name: 'WebM' }),
          getVideoTracks: async () => [],
          getAudioTracks: async () => [],
        }),
      ),
    ).resolves.toEqual({
      isMp4: false,
      videoTrackCount: 0,
      audioTrackCount: 0,
      videoCodec: null,
      audioCodec: null,
      width: 0,
      height: 0,
    })
    const qt = await probeSourceCopyCandidate(
      fakeInput({ getFormat: async () => ({ name: 'QuickTime File Format' }) }),
    )
    expect(qt.isMp4).toBe(false)
  })
})

describe('source-copy blockers for frame rate and codec', () => {
  it('allows a copy when the output rate equals the source rate', () => {
    expect(isSourceCopyFastPathEligible({ ...CLEAN, frameRate: 30, sourceFrameRate: 30 })).toBe(
      true,
    )
    // Probed rates are rarely exactly integral; the comparison rounds.
    expect(isSourceCopyFastPathEligible({ ...CLEAN, frameRate: 30, sourceFrameRate: 29.97 })).toBe(
      true,
    )
  })

  it('blocks a copy when the output rate differs, because frames must be resampled', () => {
    expect(
      getSourceCopyFastPathBlockers({ ...CLEAN, frameRate: 24, sourceFrameRate: 30 }),
    ).toContain('output frame rate 24 differs from source 30')
  })

  it('does not treat an unknown source rate as a mismatch', () => {
    expect(isSourceCopyFastPathEligible({ ...CLEAN, frameRate: 30 })).toBe(true)
    expect(isSourceCopyFastPathEligible({ ...CLEAN, sourceFrameRate: 30 })).toBe(true)
  })

  it('blocks a copy when a codec other than the H.264 default was asked for', () => {
    // Handing over the source file cannot honour "encode this as HEVC".
    expect(getSourceCopyFastPathBlockers({ ...CLEAN, codec: 'hvc1.1.6.L123.B0' })).toContain(
      'codec hvc1.1.6.L123.B0 was requested explicitly',
    )
    expect(isSourceCopyFastPathEligible({ ...CLEAN, codec: 'avc1.640033' })).toBe(true)
  })
})
