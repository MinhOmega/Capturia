import { describe, expect, it } from "vitest";
import {
  IDLE_RECORDING_STATE,
  beginStopTransition,
  canPauseRecording,
  canRequestDiscard,
  canRequestStop,
  completeStopTransition,
  planNativeStopSideEffects,
  resolveStopRoute,
  type RecordingTransitionState,
} from "./recordingPhase";

const recordingState: RecordingTransitionState = {
  phase: "recording",
  recording: true,
  transitionInFlight: false,
  discardRequested: false,
};

describe("recordingPhase", () => {
  it("discard on the MediaRecorder path: stopping -> idle with the discard flag cleared", () => {
    expect(canRequestDiscard(recordingState)).toBe(true);

    const stopping = beginStopTransition(recordingState, { discard: true });
    expect(stopping).toEqual({
      phase: "stopping",
      recording: false,
      transitionInFlight: true,
      discardRequested: true,
    });
    expect(resolveStopRoute({ nativeRecordingActive: false, recorderState: "recording" })).toBe("media-recorder");
    // A second click while the recorder drains is ignored.
    expect(canRequestDiscard(stopping)).toBe(false);
    expect(canRequestStop(stopping)).toBe(false);

    const idle = completeStopTransition(stopping);
    expect(idle).toEqual(IDLE_RECORDING_STATE);
    expect(idle.discardRequested).toBe(false);
  });

  it("discard on the native path: routes through the native stop, deletes the output and skips the editor", () => {
    const stopping = beginStopTransition(recordingState, { discard: true });
    expect(resolveStopRoute({ nativeRecordingActive: true, recorderState: null })).toBe("native");

    expect(planNativeStopSideEffects({ discard: true, stopSucceeded: true })).toEqual({
      deleteOutput: true,
      openEditor: false,
      reportFailure: false,
    });
    // A helper that failed to produce a file is still a clean discard, not an error.
    expect(planNativeStopSideEffects({ discard: true, stopSucceeded: false })).toEqual({
      deleteOutput: true,
      openEditor: false,
      reportFailure: false,
    });

    // The native stop always ends in idle so the HUD never sticks on "Processing...".
    const idle = completeStopTransition(stopping);
    expect(idle.transitionInFlight).toBe(false);
    expect(idle.phase).toBe("idle");
  });

  it("a normal native stop opens the editor, a failed one reports instead", () => {
    expect(planNativeStopSideEffects({ discard: false, stopSucceeded: true })).toEqual({
      deleteOutput: false,
      openEditor: true,
      reportFailure: false,
    });
    expect(planNativeStopSideEffects({ discard: false, stopSucceeded: false })).toEqual({
      deleteOutput: false,
      openEditor: false,
      reportFailure: true,
    });
  });

  it("stop after discard: a new session can be stopped once the discard has settled", () => {
    const afterDiscard = completeStopTransition(beginStopTransition(recordingState, { discard: true }));
    // Nothing to stop while idle.
    expect(canRequestStop(afterDiscard)).toBe(false);

    const nextSession: RecordingTransitionState = { ...afterDiscard, phase: "recording", recording: true };
    expect(canRequestStop(nextSession)).toBe(true);
    const stopping = beginStopTransition(nextSession);
    expect(stopping.discardRequested).toBe(false);
    expect(stopping.transitionInFlight).toBe(true);
    expect(completeStopTransition(stopping)).toEqual(IDLE_RECORDING_STATE);
  });

  it("refuses stop and discard while idle or starting", () => {
    expect(canRequestDiscard(IDLE_RECORDING_STATE)).toBe(false);
    expect(canRequestStop({ ...IDLE_RECORDING_STATE, phase: "starting", transitionInFlight: true })).toBe(false);
    expect(resolveStopRoute({ nativeRecordingActive: false, recorderState: "inactive" })).toBe("none");
  });

  it("allows stopping a paused MediaRecorder session", () => {
    const paused: RecordingTransitionState = { ...recordingState, phase: "paused", recording: false };
    expect(canRequestStop(paused)).toBe(true);
    expect(resolveStopRoute({ nativeRecordingActive: false, recorderState: "paused" })).toBe("media-recorder");
  });

  it("offers pause only on the MediaRecorder path", () => {
    expect(canPauseRecording({ phase: "recording", nativeRecordingActive: false })).toBe(true);
    expect(canPauseRecording({ phase: "paused", nativeRecordingActive: false })).toBe(true);
    expect(canPauseRecording({ phase: "recording", nativeRecordingActive: true })).toBe(false);
    expect(canPauseRecording({ phase: "idle", nativeRecordingActive: false })).toBe(false);
  });
});
