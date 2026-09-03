/**
 * Planar channel downmix for export. The AAC/Opus encoders are configured for
 * 1 or 2 channels, so multichannel
 * captures (Windows 5.1/7.1 system audio) are folded to stereo and mono is
 * duplicated rather than dropped.
 */

export type DownmixWeights = Array<[channel: number, weight: number]>

function averageChannels(sourcePlanes: Float32Array[], frame: number) {
  let mixed = 0
  for (const plane of sourcePlanes) {
    mixed += plane[frame] ?? 0
  }
  return mixed / Math.max(1, sourcePlanes.length)
}

function weightedSample(sourcePlanes: Float32Array[], frame: number, weights: DownmixWeights) {
  let mixed = 0
  let weightSum = 0
  for (const [channel, weight] of weights) {
    const sample = sourcePlanes[channel]?.[frame]
    if (typeof sample !== 'number') {
      continue
    }
    mixed += sample * weight
    weightSum += weight
  }
  return weightSum > 0 ? mixed / weightSum : averageChannels(sourcePlanes, frame)
}

export function getStereoDownmixWeights(sourceChannels: number): {
  left: DownmixWeights
  right: DownmixWeights
} {
  const centerWeight = Math.SQRT1_2
  const surroundWeight = Math.SQRT1_2
  const lfeWeight = 0.5

  if (sourceChannels >= 8) {
    // Windows 7.1 order: FL, FR, FC, LFE, BL, BR, SL, SR.
    return {
      left: [
        [0, 1],
        [2, centerWeight],
        [3, lfeWeight],
        [4, surroundWeight],
        [6, surroundWeight],
      ],
      right: [
        [1, 1],
        [2, centerWeight],
        [3, lfeWeight],
        [5, surroundWeight],
        [7, surroundWeight],
      ],
    }
  }

  if (sourceChannels >= 6) {
    // Windows 5.1 order: FL, FR, FC, LFE, BL, BR.
    return {
      left: [
        [0, 1],
        [2, centerWeight],
        [3, lfeWeight],
        [4, surroundWeight],
      ],
      right: [
        [1, 1],
        [2, centerWeight],
        [3, lfeWeight],
        [5, surroundWeight],
      ],
    }
  }

  if (sourceChannels >= 4) {
    return {
      left: [
        [0, 1],
        [2, surroundWeight],
      ],
      right: [
        [1, 1],
        [3, surroundWeight],
      ],
    }
  }

  return {
    left: [
      [0, 1],
      [2, centerWeight],
    ],
    right: [
      [1, 1],
      [2, centerWeight],
    ],
  }
}

/**
 * Downmix planar PCM to `targetChannels` (1 or 2). Returns planar output:
 * channel 0 occupies the first `frameCount` samples, channel 1 the next.
 */
export function downmixPlanarChannelsForExport(
  sourcePlanes: Float32Array[],
  targetChannels: number,
): Float32Array {
  const frameCount = sourcePlanes[0]?.length ?? 0
  const output = new Float32Array(frameCount * targetChannels)

  if (targetChannels === 1) {
    for (let frame = 0; frame < frameCount; frame++) {
      output[frame] = averageChannels(sourcePlanes, frame)
    }
    return output
  }

  if (targetChannels !== 2) {
    throw new Error(`Unsupported target channel count: ${targetChannels}`)
  }

  if (sourcePlanes.length === 1) {
    output.set(sourcePlanes[0], 0)
    output.set(sourcePlanes[0], frameCount)
    return output
  }

  if (sourcePlanes.length === 2) {
    output.set(sourcePlanes[0], 0)
    output.set(sourcePlanes[1], frameCount)
    return output
  }

  const weights = getStereoDownmixWeights(sourcePlanes.length)
  for (let frame = 0; frame < frameCount; frame++) {
    output[frame] = weightedSample(sourcePlanes, frame, weights.left)
    output[frameCount + frame] = weightedSample(sourcePlanes, frame, weights.right)
  }
  return output
}

/**
 * Brings planar PCM to exactly `targetChannels` (1 or 2) as an array of
 * planes, for callers that sum several tracks before encoding. Returns the
 * input planes untouched when the count already matches; mono is duplicated
 * to stereo and wider layouts go through `downmixPlanarChannelsForExport`.
 */
export function conformPlanarChannels(
  sourcePlanes: Float32Array[],
  targetChannels: number,
): Float32Array[] {
  if (sourcePlanes.length === targetChannels) return sourcePlanes
  if (sourcePlanes.length === 0) {
    return Array.from({ length: targetChannels }, () => new Float32Array(0))
  }
  const frameCount = sourcePlanes[0].length
  const packed = downmixPlanarChannelsForExport(sourcePlanes, targetChannels)
  return Array.from({ length: targetChannels }, (_, channel) =>
    packed.subarray(channel * frameCount, (channel + 1) * frameCount),
  )
}
