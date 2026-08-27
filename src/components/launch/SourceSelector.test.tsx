// @vitest-environment jsdom
//
// Source picker empty state, reload and tab default (ported from upstream
// v1.7.0 SourceSelector.test.tsx). Capturia gates enumeration behind
// `getScreenCaptureAccessStatus`, so the stub reports access as granted.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceSelector } from "./SourceSelector";

vi.mock("@/i18n", async () => {
  const loader = await vi.importActual<typeof import("@/i18n/loader")>("@/i18n/loader");
  // Stable `t`: components key effects on it (e.g. SourceSelector's fetch).
  const t = (qualifiedKey: string, vars?: Record<string, string | number>) => {
    const [namespace, ...rest] = qualifiedKey.split(".");
    return loader.translate("en", namespace as never, rest.join("."), vars);
  };
  const setLocale = vi.fn();
  return {
    useI18n: () => ({ locale: "en", setLocale, t }),
  };
});

const displayOne: ProcessedDesktopSource = {
  id: "screen:1:0",
  name: "Display 1",
  thumbnail: "data:image/png;base64,abc",
  display_id: "1",
  appIcon: null,
};

const terminalWindow: ProcessedDesktopSource = {
  id: "window:42:0",
  name: "Terminal — zsh",
  thumbnail: null,
  display_id: "",
  appIcon: null,
};

function stubElectronAPI(getSources: Window["electronAPI"]["getSources"]) {
  window.electronAPI = {
    ...window.electronAPI,
    getScreenCaptureAccessStatus: vi.fn(async () => ({ status: "granted" as const, canOpenSystemSettings: false })),
    getSources,
    selectSource: vi.fn(async () => undefined),
    openPermissionChecker: vi.fn(async () => ({ success: true })),
  } as typeof window.electronAPI;
}

describe("SourceSelector", () => {
  beforeEach(() => {
    stubElectronAPI(vi.fn(async () => []));
  });

  afterEach(() => {
    cleanup();
  });

  it("shows a retry state when no capture sources are available", async () => {
    render(<SourceSelector />);

    await screen.findByText("No screens or windows found");
    expect(screen.getByTestId("source-selector-reload-button")).toHaveTextContent("Reload");
    // The empty state is not the permission-failure state.
    expect(screen.queryByText("Failed to load shareable sources.")).not.toBeInTheDocument();
  });

  it("reloads capture sources from the empty state", async () => {
    const getSources = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([displayOne]);
    stubElectronAPI(getSources);

    render(<SourceSelector />);

    await screen.findByText("No screens or windows found");
    fireEvent.click(screen.getByTestId("source-selector-reload-button"));

    await waitFor(() => {
      expect(screen.getByText("Display 1")).toBeInTheDocument();
    });
    expect(getSources).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("source-selector-screens-tab")).toHaveTextContent("Screens (1)");
    expect(screen.getByTestId("source-selector-windows-tab")).toHaveTextContent("Windows (0)");
  });

  it("defaults to the Windows tab when only window sources are available", async () => {
    stubElectronAPI(vi.fn(async () => [terminalWindow]));

    render(<SourceSelector />);

    const windowsTab = await screen.findByTestId("source-selector-windows-tab");
    expect(windowsTab).toHaveAttribute("data-state", "active");
    expect(screen.getByTestId("source-selector-screens-tab")).toHaveAttribute("data-state", "inactive");
    expect(windowsTab).toHaveTextContent("Windows (1)");
    // Window titles are shortened to the part after the em dash.
    expect(screen.getByTestId("source-selector-card")).toHaveAttribute("data-source-kind", "window");
    expect(screen.getByText("zsh")).toBeInTheDocument();
  });

  it("keeps the permission failure state when screen capture access is blocked", async () => {
    const getSources = vi.fn(async () => [displayOne]);
    stubElectronAPI(getSources);
    window.electronAPI.getScreenCaptureAccessStatus = vi.fn(async () => ({
      status: "denied" as const,
      canOpenSystemSettings: true,
    }));

    render(<SourceSelector />);

    await screen.findByText("Failed to load shareable sources.");
    expect(screen.queryByText("No screens or windows found")).not.toBeInTheDocument();
    expect(getSources).not.toHaveBeenCalled();
  });
});
