import { shouldDensify } from './trackPlan'
import {
  BLUR_TRACKER_TUNING,
  BlurTracker,
  type SourceRectPx,
  type TrackerCreateResult,
  type TrackerFrame,
  type TrackerSample,
} from './trackerCore'

/**
 * One tracking run over a stream of decoded frames.
 *
 * The caller pushes **every** decoded frame in time order; the session decides
 * which ones are analysed. Normally that is the fixed grid only, but when the
 * content moved far between two grid samples the frames held in between are
 * analysed too, so a flick scroll is followed at the source frame rate for
 * exactly as long as it is moving (`docs/specs/tracked-blur-regions.md` §1.8).
 *
 * The session never owns the images it is handed: `push` uses them and returns,
 * and the caller closes them. Frames it wants to keep for densification are
 * retained through a `retain`/`release` pair the caller provides, which is how
 * the worker can close every `VideoFrame` it was sent exactly once.
 */

/** How many frames may be held between two grid samples. At 60 fps a 100 ms interval holds six. */
export const MAX_DENSIFY_RING = 8

export interface HeldFrame<T> {
  image: T
  timeMs: number
}

export interface BlurTrackSessionOptions<T> {
  /** Builds the tracker's view of one image. */
  toFrame: (image: T) => TrackerFrame
  /** Called when the session is finished with a held image. */
  release: (image: T) => void
  /** Analysis instants, ascending, already clamped to the region's span. */
  gridTimes: number[]
}

export class BlurTrackSession<T> {
  private readonly ring: Array<HeldFrame<T>> = []
  private nextGridIndex = 0
  private lastGridSample: TrackerSample | null = null

  private constructor(
    private readonly tracker: BlurTracker,
    private readonly options: BlurTrackSessionOptions<T>,
  ) {}

  /**
   * Samples the anchor patch from `anchorImage` and opens a session, or
   * returns the tracker's refusal unchanged.
   */
  static create<T>(
    anchorImage: T,
    anchorRect: SourceRectPx,
    anchorMs: number,
    options: BlurTrackSessionOptions<T>,
  ):
    | { ok: true; session: BlurTrackSession<T>; anchor: TrackerSample }
    | Exclude<TrackerCreateResult, { ok: true }> {
    const created = BlurTracker.create(options.toFrame(anchorImage), anchorRect, anchorMs)
    if (!created.ok) return created
    return {
      ok: true,
      session: new BlurTrackSession(created.tracker, options),
      anchor: created.tracker.anchorSample(),
    }
  }

  /** True once every grid instant has been analysed; the caller can stop decoding. */
  isComplete(): boolean {
    return this.nextGridIndex >= this.options.gridTimes.length
  }

  /**
   * Offers one decoded frame. Returns the samples it produced, which is
   * usually none (the frame sits between two grid instants) and occasionally
   * several (a densified interval).
   */
  push(image: T, timeMs: number): TrackerSample[] {
    if (this.isComplete()) {
      this.options.release(image)
      return []
    }

    this.ring.push({ image, timeMs })
    const samples: TrackerSample[] = []

    while (this.nextGridIndex < this.options.gridTimes.length) {
      const gridTime = this.options.gridTimes[this.nextGridIndex]
      const afterIndex = this.ring.findIndex((held) => held.timeMs >= gridTime)
      // Nothing at or past this instant yet: the frame that covers it may
      // still be coming.
      if (afterIndex < 0) break

      // The frame nearest the grid instant, with the handoff at the midpoint
      // between two decoded frames - the same rule the exporter resamples by.
      const after = this.ring[afterIndex]
      const before = afterIndex > 0 ? this.ring[afterIndex - 1] : null
      const chosenIndex =
        before && gridTime - before.timeMs <= after.timeMs - gridTime ? afterIndex - 1 : afterIndex

      for (const sample of this.analyseInterval(chosenIndex)) samples.push(sample)
      for (let i = 0; i <= chosenIndex; i++) this.options.release(this.ring[i].image)
      this.ring.splice(0, chosenIndex + 1)
      this.nextGridIndex++
    }

    // The ring only exists to densify one interval; anything older than the
    // bound cannot be part of it.
    while (this.ring.length > MAX_DENSIFY_RING) {
      const dropped = this.ring.shift()
      if (dropped) this.options.release(dropped.image)
    }
    return samples
  }

  /** Analyses the grid frame at `chosenIndex`, densifying the interval before it if needed. */
  private analyseInterval(chosenIndex: number): TrackerSample[] {
    const held = this.ring[chosenIndex]
    const snapshot = this.tracker.snapshot()
    const gridSample = this.tracker.step(this.options.toFrame(held.image), held.timeMs)

    const previous = this.lastGridSample
    if (chosenIndex === 0 || !previous || !shouldDensify(previous, gridSample)) {
      this.lastGridSample = gridSample
      return [gridSample]
    }

    // The content moved far enough between the two grid instants that a lerp
    // across them would leave the blur off its content for whole frames.
    // Rewind and analyse every frame in between.
    this.tracker.restore(snapshot)
    const samples: TrackerSample[] = []
    for (let i = 0; i < chosenIndex; i++) {
      const between = this.ring[i]
      samples.push(this.tracker.step(this.options.toFrame(between.image), between.timeMs))
    }
    const redone = this.tracker.step(this.options.toFrame(held.image), held.timeMs)
    samples.push(redone)
    this.lastGridSample = redone
    return samples
  }

  /** Releases everything still held. Safe to call twice. */
  dispose(): void {
    for (const held of this.ring) this.options.release(held.image)
    this.ring.length = 0
  }

  /** Instants that were never reached, so the caller can report honest progress. */
  remainingGridTimes(): number[] {
    return this.options.gridTimes.slice(this.nextGridIndex)
  }

  static get sampleIntervalMs(): number {
    return BLUR_TRACKER_TUNING.sampleIntervalMs
  }
}
