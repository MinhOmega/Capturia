/**
 * Recording audio graph: microphone and system audio mixed into one track for the
 * MediaRecorder path.
 *
 * The graph is built by a pure function over a minimal AudioContext surface so it
 * can be unit-tested with a fake context; `mixAudioTracks` is the thin runtime
 * wrapper that creates the real context.
 *
 * Routing (every input goes through its own gain node, then a shared soft limiter):
 *
 *   mic    -> micGain (0 -> user gain over the fade-in)   \
 *                                                          -> limiter -> destination
 *   system -> systemGain (0 -> unity over the fade-in)    /
 *
 * - Mic only: same graph without the system branch (the ramp masks the click the
 *   first mic packet otherwise produces; the user gain and limiter are preserved).
 * - System only: the track is returned verbatim, no context is created. A single
 *   loopback source needs neither the ramp nor the user gain, and skipping the
 *   context avoids its warm-up on the first packet.
 * - Neither: `{ context: null, track: null, stream: null }`.
 */

/** Length of the gain ramp at the start of a recording so the first packet does not click. */
export const AUDIO_MIX_FADE_IN_SECONDS = 0.02

/** User microphone gain is clamped to this range (the HUD slider range). */
export const MICROPHONE_GAIN_MIN = 0.5
export const MICROPHONE_GAIN_MAX = 2

/** Soft limiter in front of the destination: catches mic + system peaks adding up. */
export const AUDIO_MIX_LIMITER = {
  thresholdDb: -1,
  kneeDb: 0,
  ratio: 20,
  attackSeconds: 0.003,
  releaseSeconds: 0.1,
} as const

/** The AudioContext surface the graph builder needs; a fake satisfies it in tests. */
export type AudioMixContext = Pick<
  AudioContext,
  | 'currentTime'
  | 'createMediaStreamSource'
  | 'createGain'
  | 'createDynamicsCompressor'
  | 'createMediaStreamDestination'
>

export type AudioMixInput = {
  systemAudioTrack?: MediaStreamTrack | null
  micAudioTrack?: MediaStreamTrack | null
  /** User microphone gain (0.5..2); anything else becomes 1. */
  microphoneGain?: number
  /** Ramp length in seconds; defaults to {@link AUDIO_MIX_FADE_IN_SECONDS}. */
  fadeInSeconds?: number
}

export type AudioMixGraph = {
  /** The mixed track to hand to the recorder. */
  track: MediaStreamTrack
  destination: MediaStreamAudioDestinationNode
  micGain: GainNode | null
  systemGain: GainNode | null
  limiter: DynamicsCompressorNode
}

export type AudioMixResult = {
  /** AudioContext created for the graph; `null` when no mixing was needed. Caller closes it. */
  context: AudioContext | null
  /** Track to record, or `null` when no audio input was given. */
  track: MediaStreamTrack | null
  /** Stream wrapping `track` (the destination stream, or a fresh stream around a verbatim track). */
  stream: MediaStream | null
}

export function normalizeMicrophoneGain(input?: number): number {
  if (!Number.isFinite(input)) return 1
  return Math.max(MICROPHONE_GAIN_MIN, Math.min(MICROPHONE_GAIN_MAX, Number(input)))
}

/** True when the graph (and therefore an AudioContext) is needed for these inputs. */
export function needsAudioMixGraph(input: AudioMixInput): boolean {
  return Boolean(input.micAudioTrack)
}

function rampGain(
  context: AudioMixContext,
  gainNode: GainNode,
  target: number,
  fadeInSeconds: number,
): void {
  const startAt = context.currentTime
  gainNode.gain.setValueAtTime(0, startAt)
  gainNode.gain.linearRampToValueAtTime(target, startAt + fadeInSeconds)
}

/**
 * Build the mix graph on `context`. Returns `null` when no graph is needed (see the
 * module comment): the caller then uses the system track verbatim or records no audio.
 */
export function buildAudioMixGraph(
  context: AudioMixContext,
  input: AudioMixInput,
): AudioMixGraph | null {
  if (!needsAudioMixGraph(input)) return null
  const micAudioTrack = input.micAudioTrack as MediaStreamTrack
  const fadeInSeconds =
    Number.isFinite(input.fadeInSeconds) && Number(input.fadeInSeconds) >= 0
      ? Number(input.fadeInSeconds)
      : AUDIO_MIX_FADE_IN_SECONDS

  const limiter = context.createDynamicsCompressor()
  limiter.threshold.value = AUDIO_MIX_LIMITER.thresholdDb
  limiter.knee.value = AUDIO_MIX_LIMITER.kneeDb
  limiter.ratio.value = AUDIO_MIX_LIMITER.ratio
  limiter.attack.value = AUDIO_MIX_LIMITER.attackSeconds
  limiter.release.value = AUDIO_MIX_LIMITER.releaseSeconds

  const destination = context.createMediaStreamDestination()

  const micSource = context.createMediaStreamSource(new MediaStream([micAudioTrack]))
  const micGain = context.createGain()
  rampGain(context, micGain, normalizeMicrophoneGain(input.microphoneGain), fadeInSeconds)
  micSource.connect(micGain)
  micGain.connect(limiter)

  let systemGain: GainNode | null = null
  if (input.systemAudioTrack) {
    const systemSource = context.createMediaStreamSource(new MediaStream([input.systemAudioTrack]))
    systemGain = context.createGain()
    rampGain(context, systemGain, 1, fadeInSeconds)
    systemSource.connect(systemGain)
    systemGain.connect(limiter)
  }

  limiter.connect(destination)

  const track = destination.stream.getAudioTracks()[0]
  if (!track) {
    throw new Error('Audio mix destination produced no audio track.')
  }
  return { track, destination, micGain, systemGain, limiter }
}

function resolveAudioContextConstructor(): (new () => AudioContext) | undefined {
  if (typeof window === 'undefined') return undefined
  return (
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  )
}

/**
 * Runtime entry point: combine the given tracks into one recordable track.
 * The caller owns `result.context` and must `close()` it on teardown.
 */
export function mixAudioTracks(
  input: AudioMixInput,
  createContext: () => AudioContext | undefined = () => {
    const AudioContextConstructor = resolveAudioContextConstructor()
    return AudioContextConstructor ? new AudioContextConstructor() : undefined
  },
): AudioMixResult {
  const micAudioTrack = input.micAudioTrack ?? null
  const systemAudioTrack = input.systemAudioTrack ?? null

  if (!needsAudioMixGraph(input)) {
    if (!systemAudioTrack) return { context: null, track: null, stream: null }
    return { context: null, track: systemAudioTrack, stream: new MediaStream([systemAudioTrack]) }
  }

  const context = createContext()
  if (!context) {
    // No Web Audio: record the raw inputs without gain/limiter rather than nothing.
    console.warn('AudioContext is unavailable; recording audio without gain processing.')
    const tracks = [micAudioTrack, systemAudioTrack].filter(
      (track): track is MediaStreamTrack => track !== null,
    )
    return { context: null, track: tracks[0] ?? null, stream: new MediaStream(tracks) }
  }

  const graph = buildAudioMixGraph(context, input)
  if (!graph) {
    return { context: null, track: null, stream: null }
  }
  void context.resume?.().catch((error: unknown) => {
    console.warn('Failed to resume the recording AudioContext.', error)
  })
  return { context, track: graph.track, stream: graph.destination.stream }
}
