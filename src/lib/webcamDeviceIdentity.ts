export interface WebcamDeviceIdentity {
  deviceId: string | undefined;
  deviceName: string | undefined;
}

/**
 * The camera to report for a recording, read off the track the browser actually
 * opened rather than off two separate pieces of React state (ported from
 * upstream main `webcamDeviceIdentity.ts`).
 *
 * The id restored from preferences and the label from the HUD's own
 * `enumerateDevices()` settle independently, so a request could carry one
 * camera's id next to another camera's name. Chromium selects by id while the
 * native macOS helper matches by name (Chromium's `deviceId` is a per-origin
 * hash, not the AVCaptureDevice `uniqueID`), so a mismatched pair would preview
 * one camera and record another.
 *
 * `track.label` and `track.getSettings().deviceId` describe the same device by
 * construction. The fallbacks cover the cases where the track cannot answer: no
 * stream yet, or a label withheld until camera permission has been granted.
 */
export function webcamDeviceIdentityFrom(
  stream: MediaStream | null | undefined,
  fallbackDeviceId: string | undefined,
  fallbackDeviceName: string | undefined,
): WebcamDeviceIdentity {
  const track = stream?.getVideoTracks()[0];
  if (!track) {
    return { deviceId: fallbackDeviceId, deviceName: fallbackDeviceName };
  }

  return {
    deviceId: track.getSettings?.().deviceId || fallbackDeviceId,
    deviceName: track.label || fallbackDeviceName,
  };
}
