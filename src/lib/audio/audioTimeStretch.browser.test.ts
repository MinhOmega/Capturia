import { describe, expect, it } from 'vitest'
import { WsolaTimeStretcher } from './audioTimeStretch'

/**
 * WSOLA on real Web Audio buffers: a 440 Hz tone rendered by
 * `OfflineAudioContext` is stretched to 2x. The output must be half as long,
 * keep its pitch (zero-crossing rate unchanged) and keep its level (RMS), and
 * an `AudioContext` must be able to hold the result as a playable buffer.
 */

const SAMPLE_RATE = 48_000
const TONE_HZ = 440
const DURATION_SEC = 1

async function renderTone(channels: number): Promise<AudioBuffer> {
  const offline = new OfflineAudioContext(channels, SAMPLE_RATE * DURATION_SEC, SAMPLE_RATE)
  const osc = offline.createOscillator()
  osc.type = 'sine'
  osc.frequency.value = TONE_HZ
  const gain = offline.createGain()
  gain.gain.value = 0.5
  osc.connect(gain)
  gain.connect(offline.destination)
  osc.start(0)
  osc.stop(DURATION_SEC)
  return offline.startRendering()
}

function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length))
}

/** Estimated tone frequency from zero crossings over the middle of the signal. */
function estimateFrequencyHz(samples: Float32Array, sampleRate: number): number {
  const start = Math.floor(samples.length * 0.1)
  const end = Math.floor(samples.length * 0.9)
  let crossings = 0
  for (let i = start + 1; i < end; i++) {
    if ((samples[i - 1] < 0 && samples[i] >= 0) || (samples[i - 1] >= 0 && samples[i] < 0)) {
      crossings++
    }
  }
  const seconds = (end - start) / sampleRate
  return crossings / 2 / seconds
}

/** `AudioBuffer.copyToChannel` only accepts a view over a plain ArrayBuffer. */
function concat(chunks: Float32Array[]): Float32Array<ArrayBuffer> {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

describe('WsolaTimeStretcher on Web Audio buffers (real browser)', () => {
  it('halves a 440 Hz OfflineAudioContext tone at 2x while keeping pitch and level', async () => {
    const source = await renderTone(2)
    const planar = [source.getChannelData(0), source.getChannelData(1)]
    const inputLength = planar[0].length
    expect(inputLength).toBe(SAMPLE_RATE * DURATION_SEC)

    const stretcher = new WsolaTimeStretcher({
      sampleRate: SAMPLE_RATE,
      channels: 2,
      speed: 2,
      expectedOutputSamples: Math.round(inputLength / 2),
    })

    // Feed in 100 ms slices like the exporter does, then drain.
    const outChunks: Float32Array[][] = []
    const sliceLength = SAMPLE_RATE / 10
    for (let offset = 0; offset < inputLength; offset += sliceLength) {
      const slice = planar.map((channel) => channel.subarray(offset, offset + sliceLength))
      outChunks.push(stretcher.push(slice))
    }
    outChunks.push(stretcher.flush())

    const left = concat(outChunks.map((chunk) => chunk[0]))
    const right = concat(outChunks.map((chunk) => chunk[1]))
    expect(left.length).toBe(right.length)

    // 2x -> half the samples, within a couple of grains.
    const expectedLength = inputLength / 2
    expect(Math.abs(left.length - expectedLength)).toBeLessThan(SAMPLE_RATE * 0.05)

    // Pitch preserved (a plain resample would read ~880 Hz here).
    const frequency = estimateFrequencyHz(left, SAMPLE_RATE)
    expect(frequency).toBeGreaterThan(TONE_HZ * 0.97)
    expect(frequency).toBeLessThan(TONE_HZ * 1.03)

    // Level preserved by the overlap-add normalisation.
    const inputRms = rms(planar[0])
    expect(rms(left) / inputRms).toBeGreaterThan(0.85)
    expect(rms(left) / inputRms).toBeLessThan(1.15)

    // The result is a valid Web Audio buffer a real AudioContext accepts.
    const context = new AudioContext({ sampleRate: SAMPLE_RATE })
    try {
      const buffer = context.createBuffer(2, left.length, SAMPLE_RATE)
      buffer.copyToChannel(left, 0)
      buffer.copyToChannel(right, 1)
      expect(buffer.duration).toBeCloseTo(DURATION_SEC / 2, 1)
      const node = context.createBufferSource()
      node.buffer = buffer
      expect(node.buffer?.length).toBe(left.length)
    } finally {
      await context.close()
    }
  })

  it('passes a 1x tone through untouched', async () => {
    const source = await renderTone(1)
    const input = source.getChannelData(0)
    const stretcher = new WsolaTimeStretcher({ sampleRate: SAMPLE_RATE, channels: 1, speed: 1 })
    const out = concat([stretcher.push([input])[0], stretcher.flush()[0]])
    expect(out.length).toBe(input.length)
    expect(out[1000]).toBeCloseTo(input[1000], 6)
  })
})
