// @vitest-environment jsdom
//
// Record-button flow of the launch HUD (ported from upstream v1.7.0
// LaunchWindow.test.tsx, adapted to Capturia's recorder hook shape, countdown
// and permission preflight). The recorder hook is mocked; `window.electronAPI`
// is stubbed with an all-granted permission snapshot so the preflight passes.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapturePermissionSnapshot } from "@/lib/permissions/capturePermissions";
import type { RecordingPhase } from "../../hooks/recordingPhase";
import { LaunchWindow } from "./LaunchWindow";

type SelectedSourceChangedListener = Parameters<Window["electronAPI"]["onSelectedSourceChanged"]>[0];

class StubResizeObserver {
  observe() {
    return undefined;
  }
  unobserve() {
    return undefined;
  }
  disconnect() {
    return undefined;
  }
}

const recorderState = vi.hoisted(() => ({
  value: {
    recording: false,
    recordingState: "idle" as RecordingPhase,
    canPause: false,
    toggleRecording: vi.fn(),
    pauseRecording: vi.fn(),
    resumeRecording: vi.fn(),
    discardRecording: vi.fn(),
    restartRecording: vi.fn(),
    startTimeRef: { current: 0 },
    cumulativePauseMsRef: { current: 0 },
    pauseStartTimeRef: { current: 0 },
  },
}));

vi.mock("../../hooks/useScreenRecorder", () => ({
  useScreenRecorder: () => recorderState.value,
}));

// Real English messages through the real loader, so assertions use the shipped
// strings instead of a parallel translation table.
vi.mock("@/i18n", async () => {
  const loader = await vi.importActual<typeof import("@/i18n/loader")>("@/i18n/loader");
  // Stable `t`: components key effects on it (e.g. SourceSelector's fetch).
  const t = (qualifiedKey: string, vars?: Record<string, string | number>) => {
    const [namespace, ...rest] = qualifiedKey.split(".");
    return loader.translate("en", namespace as never, rest.join("."), vars);
  };
  const setLocale = vi.fn();
  return {
    getAvailableLocales: () => ["en"],
    getLocaleName: () => "English",
    useI18n: () => ({ locale: "en", setLocale, t }),
  };
});

const allGrantedSnapshot: CapturePermissionSnapshot = {
  platform: "darwin",
  checkedAtMs: 0,
  canOpenSystemSettings: true,
  items: [
    { key: "screen", status: "granted", requiredForRecording: true, canOpenSettings: true },
    { key: "microphone", status: "granted", requiredForRecording: false, canOpenSettings: true },
    { key: "camera", status: "granted", requiredForRecording: false, canOpenSettings: true },
  ],
};

const displayOneSource: ProcessedDesktopSource = {
  id: "screen:1:0",
  name: "Display 1",
  display_id: "1",
  thumbnail: null,
  appIcon: null,
};

let selectedSourceChangedListeners: SelectedSourceChangedListener[] = [];
let sourceSelectorClosedListeners: Array<() => void> = [];
// Mirrors main's `selectedSource`: the 500 ms poll must agree with the event.
let mainSelectedSource: ProcessedDesktopSource | null = null;

function stubElectronAPI() {
  window.electronAPI = {
    ...window.electronAPI,
    getPlatform: vi.fn(async () => "darwin"),
    getSelectedSource: vi.fn(async () => mainSelectedSource),
    getCapturePermissionSnapshot: vi.fn(async () => allGrantedSnapshot),
    openPermissionChecker: vi.fn(async () => ({ success: true })),
    openSourceSelector: vi.fn(async () => undefined),
    setStopRecordingShortcut: vi.fn(async (accelerator: string) => ({ success: true, accelerator })),
    hudOverlayHide: vi.fn(),
    hudOverlayClose: vi.fn(),
    hudOverlayResize: vi.fn(),
    hudOverlayRestore: vi.fn(),
    onSelectedSourceChanged: vi.fn((callback: SelectedSourceChangedListener) => {
      selectedSourceChangedListeners.push(callback);
      return () => {
        selectedSourceChangedListeners = selectedSourceChangedListeners.filter((listener) => listener !== callback);
      };
    }),
    onSourceSelectorClosed: vi.fn((callback: () => void) => {
      sourceSelectorClosedListeners.push(callback);
      return () => {
        sourceSelectorClosedListeners = sourceSelectorClosedListeners.filter((listener) => listener !== callback);
      };
    }),
  } as typeof window.electronAPI;
}

async function waitForSourceSelectionSubscription() {
  await waitFor(() => {
    expect(selectedSourceChangedListeners.length).toBeGreaterThan(0);
  });
}

function emitSelectedSourceChanged(source: ProcessedDesktopSource) {
  mainSelectedSource = source;
  act(() => {
    for (const listener of selectedSourceChangedListeners) listener(source);
  });
}

function emitSourceSelectorClosed() {
  act(() => {
    for (const listener of sourceSelectorClosedListeners) listener();
  });
}

describe("LaunchWindow record button", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    window.localStorage.clear();
    recorderState.value.toggleRecording.mockClear();
    selectedSourceChangedListeners = [];
    sourceSelectorClosedListeners = [];
    mainSelectedSource = null;
    stubElectronAPI();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens the source selector instead of disabling the primary action when no source is selected", async () => {
    render(<LaunchWindow />);

    const recordButton = await screen.findByTestId("launch-record-button");

    expect(recordButton).toBeEnabled();
    expect(recordButton).toHaveAttribute("title", "Please select a source before recording.");

    fireEvent.click(recordButton);

    await waitFor(() => {
      expect(window.electronAPI.openSourceSelector).toHaveBeenCalledTimes(1);
    });
    // The permission preflight runs before the picker opens.
    expect(window.electronAPI.getCapturePermissionSnapshot).toHaveBeenCalled();
    expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
  });

  it("records immediately after source selection when the record button opened the picker", async () => {
    render(<LaunchWindow />);
    await waitForSourceSelectionSubscription();

    fireEvent.click(await screen.findByTestId("launch-record-button"));
    await waitFor(() => {
      expect(window.electronAPI.openSourceSelector).toHaveBeenCalledTimes(1);
    });
    emitSelectedSourceChanged(displayOneSource);

    await waitFor(() => {
      expect(recorderState.value.toggleRecording).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId("launch-record-button")).toHaveAttribute("title", "Display 1");
  });

  it("does not record after manual source selection", async () => {
    render(<LaunchWindow />);
    await waitForSourceSelectionSubscription();

    emitSelectedSourceChanged(displayOneSource);

    await waitFor(() => {
      expect(screen.getByTestId("launch-record-button")).toHaveAttribute("title", "Display 1");
    });
    expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
  });

  it("clears record-after-selection intent when the source picker closes without a selection", async () => {
    render(<LaunchWindow />);
    await waitForSourceSelectionSubscription();

    fireEvent.click(await screen.findByTestId("launch-record-button"));
    await waitFor(() => {
      expect(window.electronAPI.openSourceSelector).toHaveBeenCalledTimes(1);
    });
    emitSourceSelectorClosed();
    emitSelectedSourceChanged(displayOneSource);

    await waitFor(() => {
      expect(screen.getByTestId("launch-record-button")).toHaveAttribute("title", "Display 1");
    });
    expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
  });

  it("clears record-after-selection intent when opening the source picker fails", async () => {
    // The failure is reported through reportUserActionError; keep the log quiet.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.electronAPI.openSourceSelector = vi.fn(async () => {
      throw new Error("source selector failed");
    });

    render(<LaunchWindow />);
    await waitForSourceSelectionSubscription();

    fireEvent.click(await screen.findByTestId("launch-record-button"));

    await waitFor(() => {
      expect(window.electronAPI.openSourceSelector).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await Promise.resolve();
    });

    emitSelectedSourceChanged(displayOneSource);

    await waitFor(() => {
      expect(screen.getByTestId("launch-record-button")).toHaveAttribute("title", "Display 1");
    });
    expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
  });

  it("offers restart in the compact recording bar", async () => {
    const original = recorderState.value;
    const recordingHook = { ...original, recording: true, recordingState: "recording" as RecordingPhase };
    recorderState.value = recordingHook;
    try {
      render(<LaunchWindow />);

      const restartButton = await screen.findByTestId("launch-restart-button");
      expect(restartButton).toHaveAttribute("title", "Restart recording");
      expect(restartButton).toBeEnabled();

      fireEvent.click(restartButton);
      expect(recordingHook.restartRecording).toHaveBeenCalledTimes(1);
      expect(recordingHook.toggleRecording).not.toHaveBeenCalled();
    } finally {
      recorderState.value = original;
    }
  });

  it("clears record-after-selection intent when required permissions are missing", async () => {
    const screenDeniedSnapshot: CapturePermissionSnapshot = {
      ...allGrantedSnapshot,
      items: [{ key: "screen", status: "denied", requiredForRecording: true, canOpenSettings: true }],
    };
    window.electronAPI.getCapturePermissionSnapshot = vi.fn(async () => screenDeniedSnapshot);

    render(<LaunchWindow />);
    await waitForSourceSelectionSubscription();

    fireEvent.click(await screen.findByTestId("launch-record-button"));

    await waitFor(() => {
      expect(window.electronAPI.openPermissionChecker).toHaveBeenCalledTimes(1);
    });
    expect(window.electronAPI.openSourceSelector).not.toHaveBeenCalled();

    emitSelectedSourceChanged(displayOneSource);

    await waitFor(() => {
      expect(screen.getByTestId("launch-record-button")).toHaveAttribute("title", "Display 1");
    });
    expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
  });
});
