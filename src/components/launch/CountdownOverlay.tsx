import { useEffect, useRef, useState } from "react";

/**
 * Full-window countdown digit rendered in the transparent overlay window. The
 * HUD's own countdown timer pushes values over IPC; each run carries a token so
 * a late tick from a cancelled run cannot overwrite a newer one.
 */
export function CountdownOverlay() {
  const [value, setValue] = useState<number | null>(null);
  const latestRunIdRef = useRef<number>(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    const subscribe = window.electronAPI?.onCountdownOverlayValue;
    if (!subscribe) return;
    return subscribe((nextValue, runId) => {
      if (runId < latestRunIdRef.current) return;
      latestRunIdRef.current = runId;
      setValue(nextValue);
    });
  }, []);

  if (value === null) {
    return null;
  }

  return (
    <div
      className="w-screen h-screen bg-transparent flex items-center justify-center pointer-events-none select-none"
      data-testid="countdown-overlay"
    >
      <div className="flex items-center justify-center w-40 h-40 rounded-full bg-black/50">
        <div
          className="text-white/90 text-[80px] font-bold leading-none tabular-nums"
          style={{ textShadow: "0 4px 24px rgba(0, 0, 0, 0.65)" }}
        >
          {value}
        </div>
      </div>
    </div>
  );
}
