import { describe, expect, it } from 'vitest'
import {
  IDLE_RECORDING_STATE,
  beginStopTransition,
  canPauseRecording,
  canRequestDiscard,
  canRequestRestart,
  canRequestStop,
  completeStopTransition,
  planNativeStopSideEffects,
  planRecorderExitInterruption,
  resolveStopRoute,
  shouldStartAfterRestart,
  type RecordingTransitionState,
} from './recordingPhase'

const recordingState: RecordingTransitionState = {
  phase: 'recording',
  recording: true,
  transitionInFlight: false,
  discardRequested: false,
}

describe('recordingPhase', () => {
  it('discard on the MediaRecorder path: stopping -> idle with the discard flag cleared', () => {
    expect(canRequestDiscard(recordingState)).toBe(true)

    const stopping = beginStopTransition(recordingState, { discard: true })
    expect(stopping).toEqual({
      phase: 'stopping',
      recording: false,
      transitionInFlight: true,
      discardRequested: true,
    })
    expect(resolveStopRoute({ nativeRecordingActive: false, recorderState: 'recording' })).toBe(
      'media-recorder',
    )
    // A second click while the recorder drains is ignored.
    expect(canRequestDiscard(stopping)).toBe(false)
    expect(canRequestStop(stopping)).toBe(false)

    const idle = completeStopTransition(stopping)
    expect(idle).toEqual(IDLE_RECORDING_STATE)
    expect(idle.discardRequested).toBe(false)
  })

  it('discard on the native path: routes through the native stop, deletes the output and skips the editor', () => {
    const stopping = beginStopTransition(recordingState, { discard: true })
    expect(resolveStopRoute({ nativeRecordingActive: true, recorderState: null })).toBe('native')

    expect(planNativeStopSideEffects({ discard: true, stopSucceeded: true })).toEqual({
      deleteOutput: true,
      openEditor: false,
      reportFailure: false,
    })
    // A helper that failed to produce a file is still a clean discard, not an error.
    expect(planNativeStopSideEffects({ discard: true, stopSucceeded: false })).toEqual({
      deleteOutput: true,
      openEditor: false,
      reportFailure: false,
    })

    // The native stop always ends in idle so the HUD never sticks on "Processing...".
    const idle = completeStopTransition(stopping)
    expect(idle.transitionInFlight).toBe(false)
    expect(idle.phase).toBe('idle')
  })

  it('a normal native stop opens the editor, a failed one reports instead', () => {
    expect(planNativeStopSideEffects({ discard: false, stopSucceeded: true })).toEqual({
      deleteOutput: false,
      openEditor: true,
      reportFailure: false,
    })
    expect(planNativeStopSideEffects({ discard: false, stopSucceeded: false })).toEqual({
      deleteOutput: false,
      openEditor: false,
      reportFailure: true,
    })
  })

  it('stop after discard: a new session can be stopped once the discard has settled', () => {
    const afterDiscard = completeStopTransition(
      beginStopTransition(recordingState, { discard: true }),
    )
    // Nothing to stop while idle.
    expect(canRequestStop(afterDiscard)).toBe(false)

    const nextSession: RecordingTransitionState = {
      ...afterDiscard,
      phase: 'recording',
      recording: true,
    }
    expect(canRequestStop(nextSession)).toBe(true)
    const stopping = beginStopTransition(nextSession)
    expect(stopping.discardRequested).toBe(false)
    expect(stopping.transitionInFlight).toBe(true)
    expect(completeStopTransition(stopping)).toEqual(IDLE_RECORDING_STATE)
  })

  it('refuses stop and discard while idle or starting', () => {
    expect(canRequestDiscard(IDLE_RECORDING_STATE)).toBe(false)
    expect(
      canRequestStop({ ...IDLE_RECORDING_STATE, phase: 'starting', transitionInFlight: true }),
    ).toBe(false)
    expect(resolveStopRoute({ nativeRecordingActive: false, recorderState: 'inactive' })).toBe(
      'none',
    )
  })

  it('allows stopping a paused MediaRecorder session', () => {
    const paused: RecordingTransitionState = {
      ...recordingState,
      phase: 'paused',
      recording: false,
    }
    expect(canRequestStop(paused)).toBe(true)
    expect(resolveStopRoute({ nativeRecordingActive: false, recorderState: 'paused' })).toBe(
      'media-recorder',
    )
  })

  it('offers pause only on the MediaRecorder path', () => {
    expect(canPauseRecording({ phase: 'recording', nativeRecordingActive: false })).toBe(true)
    expect(canPauseRecording({ phase: 'paused', nativeRecordingActive: false })).toBe(true)
    expect(canPauseRecording({ phase: 'recording', nativeRecordingActive: true })).toBe(false)
    expect(canPauseRecording({ phase: 'idle', nativeRecordingActive: false })).toBe(false)
  })

  it('native pause is offered only when the helper announced support', () => {
    // Old helper (no caps line) or unknown: hidden.
    expect(
      canPauseRecording({
        phase: 'recording',
        nativeRecordingActive: true,
        nativePauseSupported: false,
      }),
    ).toBe(false)
    expect(
      canPauseRecording({
        phase: 'recording',
        nativeRecordingActive: true,
        nativePauseSupported: undefined,
      }),
    ).toBe(false)
    // Rebuilt helper: shown while recording or paused, never while idle/starting/stopping.
    expect(
      canPauseRecording({
        phase: 'recording',
        nativeRecordingActive: true,
        nativePauseSupported: true,
      }),
    ).toBe(true)
    expect(
      canPauseRecording({
        phase: 'paused',
        nativeRecordingActive: true,
        nativePauseSupported: true,
      }),
    ).toBe(true)
    expect(
      canPauseRecording({
        phase: 'starting',
        nativeRecordingActive: true,
        nativePauseSupported: true,
      }),
    ).toBe(false)
    expect(
      canPauseRecording({
        phase: 'stopping',
        nativeRecordingActive: true,
        nativePauseSupported: true,
      }),
    ).toBe(false)
    // The flag is irrelevant on the MediaRecorder path.
    expect(
      canPauseRecording({
        phase: 'recording',
        nativeRecordingActive: false,
        nativePauseSupported: false,
      }),
    ).toBe(true)
  })
})

describe('recordingPhase restart', () => {
  it('restart shares the discard guard and refuses while a restart is already pending', () => {
    expect(canRequestRestart(recordingState, { restartPending: false })).toBe(true)
    expect(
      canRequestRestart({ ...recordingState, phase: 'paused' }, { restartPending: false }),
    ).toBe(true)
    expect(canRequestRestart(recordingState, { restartPending: true })).toBe(false)
    expect(canRequestRestart(IDLE_RECORDING_STATE, { restartPending: false })).toBe(false)
    expect(
      canRequestRestart(
        { ...recordingState, phase: 'starting', recording: false },
        { restartPending: false },
      ),
    ).toBe(false)
    expect(canRequestRestart(beginStopTransition(recordingState), { restartPending: false })).toBe(
      false,
    )
  })

  it('the pending restart starts only once the discard has settled to idle', () => {
    // Discard requested: still stopping, nothing starts yet.
    const stopping = beginStopTransition(recordingState, { discard: true })
    expect(
      shouldStartAfterRestart({
        phase: stopping.phase,
        transitionInFlight: stopping.transitionInFlight,
        restartPending: true,
      }),
    ).toBe(false)
    // Phase flipped to idle but the transition flag has not been cleared yet.
    expect(
      shouldStartAfterRestart({ phase: 'idle', transitionInFlight: true, restartPending: true }),
    ).toBe(false)
    // Fully idle: fire.
    const idle = completeStopTransition(stopping)
    expect(
      shouldStartAfterRestart({
        phase: idle.phase,
        transitionInFlight: idle.transitionInFlight,
        restartPending: true,
      }),
    ).toBe(true)
    // A plain stop/discard without a restart intent never starts anything.
    expect(
      shouldStartAfterRestart({ phase: 'idle', transitionInFlight: false, restartPending: false }),
    ).toBe(false)
  })

  it('a helper that vanishes mid-recording lands on interrupted, offering the file when it is playable', () => {
    const plan = planRecorderExitInterruption({
      state: recordingState,
      stopRequested: false,
      outputPlayable: true,
    })
    expect(plan).toEqual({ state: IDLE_RECORDING_STATE, notify: true, offerOpen: true })

    // Paused when it died, and the file has no moov: still interrupted, but nothing to open.
    expect(
      planRecorderExitInterruption({
        state: { ...recordingState, phase: 'paused' },
        stopRequested: false,
        outputPlayable: false,
      }),
    ).toEqual({ state: IDLE_RECORDING_STATE, notify: true, offerOpen: false })

    // The helper died before it ever announced itself.
    expect(
      planRecorderExitInterruption({
        state: { ...IDLE_RECORDING_STATE, phase: 'starting' },
        stopRequested: false,
        outputPlayable: false,
      }),
    ).not.toBeNull()
  })

  it('a helper closing under a normal stop is not an interruption', () => {
    // Main told us the stop came from us.
    expect(
      planRecorderExitInterruption({
        state: recordingState,
        stopRequested: true,
        outputPlayable: true,
      }),
    ).toBeNull()
    // The hook is already draining its own stop.
    expect(
      planRecorderExitInterruption({
        state: beginStopTransition(recordingState),
        stopRequested: false,
        outputPlayable: true,
      }),
    ).toBeNull()
    // Nothing was recording at all.
    expect(
      planRecorderExitInterruption({
        state: IDLE_RECORDING_STATE,
        stopRequested: false,
        outputPlayable: true,
      }),
    ).toBeNull()
  })
})
