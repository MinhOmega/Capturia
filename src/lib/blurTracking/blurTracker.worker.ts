/// <reference lib="webworker" />
import { BlurTrackSession } from './blurTrackSession'
import { createCanvasTrackerFrame, type TrackerImage, TrackerCanvasScratch } from './frameSource'
import type { SourceRectPx, TrackerSample } from './trackerCore'

/**
 * The pixel half of a tracking run, off the main thread.
 *
 * The main thread owns the decoder and does nothing but hand frames over; every
 * gradient, correlation and cross-correlation happens here, so a five-minute
 * span cannot lock the editor up. The worker **owns every image it is sent** and
 * closes it exactly once: a leaked `VideoFrame` holds a decoder buffer and a
 * handful of them stall the decoder outright.
 */

export interface WorkerInitMessage {
  type: 'init'
  image: TrackerImage
  anchorRect: SourceRectPx
  anchorMs: number
  gridTimes: number[]
}

export interface WorkerFrameMessage {
  type: 'frame'
  image: TrackerImage
  timeMs: number
  /** Echoed back on `ack` so the main thread can bound frames in flight. */
  id: number
}

export type BlurTrackerWorkerRequest =
  | WorkerInitMessage
  | WorkerFrameMessage
  | { type: 'flush' }
  | { type: 'cancel' }

export type BlurTrackerWorkerResponse =
  | { type: 'ready' }
  | { type: 'refused'; reason: string; stdDev: number }
  | { type: 'sample'; samples: TrackerSample[]; id: number; complete: boolean }
  | { type: 'done' }
  | { type: 'error'; message: string }

const scratch = new TrackerCanvasScratch()
let session: BlurTrackSession<TrackerImage> | null = null
let cancelled = false

function closeImage(image: TrackerImage): void {
  if ('close' in image && typeof image.close === 'function') image.close()
}

function post(message: BlurTrackerWorkerResponse): void {
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(message)
}

function handleInit(message: WorkerInitMessage): void {
  const created = BlurTrackSession.create(message.image, message.anchorRect, message.anchorMs, {
    toFrame: (image) => createCanvasTrackerFrame(image, scratch),
    release: closeImage,
    gridTimes: message.gridTimes,
  })
  // The anchor image belongs to the worker either way.
  closeImage(message.image)
  if (!created.ok) {
    post({ type: 'refused', reason: created.reason, stdDev: created.stdDev })
    return
  }
  session = created.session
  post({ type: 'ready' })
}

function handleFrame(message: WorkerFrameMessage): void {
  if (cancelled || !session) {
    closeImage(message.image)
    post({ type: 'sample', samples: [], id: message.id, complete: true })
    return
  }
  const samples = session.push(message.image, message.timeMs)
  post({ type: 'sample', samples, id: message.id, complete: session.isComplete() })
}

self.onmessage = (event: MessageEvent<BlurTrackerWorkerRequest>) => {
  const message = event.data
  try {
    switch (message.type) {
      case 'init':
        handleInit(message)
        break
      case 'frame':
        handleFrame(message)
        break
      case 'flush':
        session?.dispose()
        post({ type: 'done' })
        break
      case 'cancel':
        cancelled = true
        session?.dispose()
        session = null
        post({ type: 'done' })
        break
    }
  } catch (error) {
    // A frame that arrived with this message is still the worker's to close.
    if ('image' in message) closeImage(message.image)
    session?.dispose()
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
