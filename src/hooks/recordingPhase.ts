/**
 * Pure state transitions for the record -> stop / discard -> idle cycle of
 * `useScreenRecorder`. The hook keeps its state in refs and React state; this module
 * only decides what the next state is and which side effects a stop should run, so the
 * rules can be unit-tested without a MediaRecorder or the native recorder.
 */

export type RecordingPhase = "idle" | "starting" | "recording" | "stopping" | "paused";

export interface RecordingTransitionState {
  phase: RecordingPhase;
  recording: boolean;
  /** A start/stop is in progress; every other request is ignored until it settles. */
  transitionInFlight: boolean;
  /** The in-progress stop must throw the recording away instead of saving it. */
  discardRequested: boolean;
}

export const IDLE_RECORDING_STATE: RecordingTransitionState = {
  phase: "idle",
  recording: false,
  transitionInFlight: false,
  discardRequested: false,
};

/** Which recorder owns the active session, hence which stop path to run. */
export type StopRoute = "native" | "media-recorder" | "none";

export function isRecordingActive(state: Pick<RecordingTransitionState, "phase" | "recording">): boolean {
  return state.recording || state.phase === "recording" || state.phase === "paused";
}

/** Stop is allowed for an active session that is not already transitioning. */
export function canRequestStop(state: RecordingTransitionState): boolean {
  return !state.transitionInFlight && isRecordingActive(state);
}

/** Discard shares the stop guard: nothing to throw away unless a session is active. */
export function canRequestDiscard(state: RecordingTransitionState): boolean {
  return canRequestStop(state);
}

/**
 * Restart = discard the active session, then start again once the hook is idle.
 * Only one restart may be pending at a time; otherwise it shares the discard guard.
 */
export function canRequestRestart(
  state: RecordingTransitionState,
  options: { restartPending: boolean },
): boolean {
  return !options.restartPending && canRequestDiscard(state);
}

/**
 * A pending restart fires exactly once the discard has fully settled: the phase is
 * back to `idle` and no transition is in flight. Both recorder paths end there.
 */
export function shouldStartAfterRestart(input: {
  phase: RecordingPhase;
  transitionInFlight: boolean;
  restartPending: boolean;
}): boolean {
  return input.restartPending && input.phase === "idle" && !input.transitionInFlight;
}

/** Enter the `stopping` phase. Must only be applied when `canRequestStop` holds. */
export function beginStopTransition(
  state: RecordingTransitionState,
  options: { discard?: boolean } = {},
): RecordingTransitionState {
  return {
    ...state,
    phase: "stopping",
    recording: false,
    transitionInFlight: true,
    discardRequested: options.discard === true,
  };
}

/**
 * Leave the `stopping` phase. Applies identically to a saved, discarded or failed
 * stop: the recorder is gone, so the hook must accept new requests again.
 */
export function completeStopTransition(_state: RecordingTransitionState): RecordingTransitionState {
  return { ...IDLE_RECORDING_STATE };
}

export function resolveStopRoute(input: {
  nativeRecordingActive: boolean;
  recorderState?: RecordingState | null;
}): StopRoute {
  if (input.nativeRecordingActive) return "native";
  if (input.recorderState === "recording" || input.recorderState === "paused") return "media-recorder";
  return "none";
}

export interface NativeStopSideEffects {
  /** Ask main to delete the output file (and its cursor sidecar) after stopping. */
  deleteOutput: boolean;
  /** Publish the file as the current video and switch to the editor. */
  openEditor: boolean;
  /** Surface a "stop failed" error to the user. */
  reportFailure: boolean;
}

/** Decide what happens once the native helper has stopped. */
export function planNativeStopSideEffects(input: {
  discard: boolean;
  stopSucceeded: boolean;
}): NativeStopSideEffects {
  if (input.discard) {
    return { deleteOutput: true, openEditor: false, reportFailure: false };
  }
  return {
    deleteOutput: false,
    openEditor: input.stopSucceeded,
    reportFailure: !input.stopSucceeded,
  };
}

/** Pause is only offered on the MediaRecorder path while recording or paused. */
export function canPauseRecording(input: {
  phase: RecordingPhase;
  nativeRecordingActive: boolean;
}): boolean {
  if (input.nativeRecordingActive) return false;
  return input.phase === "recording" || input.phase === "paused";
}
