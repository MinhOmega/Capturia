import { Check, X } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import {
	CAPTURE_FRAME_RATES,
	CAPTURE_RESOLUTION_PRESETS,
	type CaptureFrameRate,
	type CaptureResolutionPreset,
	COUNTDOWN_OPTIONS,
	type CountdownSeconds,
	MICROPHONE_GAINS,
	type MicrophoneGain,
} from "@/lib/captureSettings";
import { useAudioLevelMeter } from "../../hooks/useAudioLevelMeter";
import type { CameraDevice } from "../../hooks/useCameraDevices";
import { useCameraPreviewStream } from "../../hooks/useCameraPreviewStream";
import type { MicrophoneDevice } from "../../hooks/useMicrophoneDevices";
import { HudPermissions } from "./HudPermissions";
import styles from "./LaunchWindow.module.css";

const LEVEL_SEGMENTS = 12;
const LEVEL_SEGMENT_KEYS = Array.from({ length: LEVEL_SEGMENTS }, (_, i) => `segment-${i}`);

export interface HudDeviceSettingsLabels {
	title: string;
	done: string;
	microphone: string;
	camera: string;
	micLevel: string;
	micHint: string;
	micGain: string;
	countdown: string;
	countdownOff: string;
	frameRate: string;
	resolution: string;
	resolutionAuto: string;
	captureHint: string;
	noMicrophones: string;
	searching: string;
	noCameras: string;
	cameraUnavailable: string;
	preview: string;
	previewUnavailable: string;
	about: string;
	checkForUpdates: string;
	checkingForUpdates: string;
	saveTo: string;
	changeFolder: string;
	resetFolder: string;
	folderUnavailable: string;
	folderHint: string;
}

/** What main reports for Settings → "Save recordings to" (`get-recordings-folder`). */
export interface RecordingsFolderState {
	folder: string;
	isDefault: boolean;
	available: boolean;
}

/** Segmented input-level bar, driven by the live analyser. */
const LevelMeter = memo(function LevelMeter({ level }: { level: number }) {
	const lit = Math.round((Math.min(100, Math.max(0, level)) / 100) * LEVEL_SEGMENTS);
	return (
		<div className={styles.levelMeter} role="meter" aria-valuenow={Math.round(level)}>
			{LEVEL_SEGMENT_KEYS.map((key, index) => (
				<span
					key={key}
					className={`${styles.levelSegment} ${index < lit ? styles.levelSegmentOn : ""}`}
				/>
			))}
		</div>
	);
});

/** One value in a capture-settings row. Four of these fit where four full-width rows would not. */
function SegmentButton({
	label,
	active,
	onSelect,
}: {
	label: string;
	active: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			role="menuitemradio"
			aria-checked={active}
			onClick={onSelect}
			className={`${styles.languageMenuItem} ${styles.hudSegment} ${active ? styles.languageMenuItemActive : ""}`}
		>
			{label}
		</button>
	);
}

function CameraPreview({
	stream,
	error,
	unavailableLabel,
}: {
	stream: MediaStream | null;
	error: string | null;
	unavailableLabel: string;
}) {
	const videoRef = useRef<HTMLVideoElement | null>(null);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		video.srcObject = stream;
		return () => {
			video.srcObject = null;
		};
	}, [stream]);

	if (error || !stream) {
		return (
			<div className={styles.cameraPreview}>
				<span className={styles.cameraPreviewFallback}>{error ? unavailableLabel : ""}</span>
			</div>
		);
	}

	// No <track>: this is a live self-view with no audio and nothing to caption.
	return <video ref={videoRef} className={styles.cameraPreview} autoPlay muted playsInline />;
}

/**
 * Device selection *and* verification in one place.
 *
 * Picking a device here never turns anything on: the HUD's mic and camera
 * buttons are plain on/off toggles that use whatever is selected here, which is
 * what separates "choose my hardware" from "start capturing it". While this
 * panel is open it holds its own preview stream and analyser so the user can
 * confirm the device actually works before recording — those are torn down with
 * the panel and are entirely separate from the recorder's capture streams.
 */
export const HudDeviceSettings = memo(function HudDeviceSettings({
	micDevices,
	cameraDevices,
	activeMicId,
	activeCameraId,
	captureFrameRate,
	captureResolution,
	countdownSeconds,
	microphoneGain,
	cameraLoading,
	cameraError,
	labels,
	versionLabel,
	canCheckForUpdates,
	checkingForUpdates,
	recordingsFolder,
	recordingsFolderLocked,
	onSelectMic,
	onSelectCamera,
	onSelectFrameRate,
	onSelectResolution,
	onSelectCountdown,
	onSelectMicGain,
	onCheckForUpdates,
	onChooseRecordingsFolder,
	onResetRecordingsFolder,
	onClose,
	panelRef,
}: {
	micDevices: MicrophoneDevice[];
	cameraDevices: CameraDevice[];
	activeMicId: string | undefined;
	activeCameraId: string | undefined;
	captureFrameRate: CaptureFrameRate;
	captureResolution: CaptureResolutionPreset;
	countdownSeconds: CountdownSeconds;
	microphoneGain: MicrophoneGain;
	cameraLoading: boolean;
	cameraError: string | null;
	labels: HudDeviceSettingsLabels;
	/** Already interpolated ("Version 1.9.6"), or null while the main process has not
	 *  answered — the About block stays out rather than reading "Version undefined". */
	versionLabel: string | null;
	canCheckForUpdates: boolean;
	checkingForUpdates: boolean;
	/** Null until main answers; the row stays out rather than showing a blank path. */
	recordingsFolder: RecordingsFolderState | null;
	/** Mid-take: the take already has its folder, and its stop paths expect it unchanged. */
	recordingsFolderLocked: boolean;
	onSelectMic: (device: MicrophoneDevice) => void;
	onSelectCamera: (device: CameraDevice) => void;
	onSelectFrameRate: (fps: CaptureFrameRate) => void;
	onSelectResolution: (preset: CaptureResolutionPreset) => void;
	onSelectCountdown: (seconds: CountdownSeconds) => void;
	onSelectMicGain: (gain: MicrophoneGain) => void;
	onCheckForUpdates: () => void;
	onChooseRecordingsFolder: () => void;
	onResetRecordingsFolder: () => void;
	onClose: () => void;
	panelRef: (el: HTMLDivElement | null) => void;
}) {
	// Only reach for hardware that is actually there — otherwise opening the panel
	// on a machine with no webcam fires a getUserMedia that can only fail.
	const hasCamera = cameraDevices.length > 0 && !cameraError && !cameraLoading;
	const { level } = useAudioLevelMeter({
		enabled: micDevices.length > 0,
		deviceId: activeMicId,
	});
	const { stream, error: previewError } = useCameraPreviewStream({
		enabled: hasCamera,
		deviceId: activeCameraId,
	});

	return (
		<div
			ref={panelRef}
			data-hud-interactive="true"
			data-testid="hud-device-settings"
			role="dialog"
			aria-label={labels.title}
			className={`${styles.hudModal} ${styles.hudScrollbar} animate-mic-panel-in ${styles.electronNoDrag}`}
		>
			<div className={styles.hudModalHeader}>
				<span className={styles.hudModalTitle}>{labels.title}</span>
				<button
					type="button"
					aria-label={labels.done}
					title={labels.done}
					onClick={onClose}
					className={styles.hudModalClose}
				>
					<X size={14} />
				</button>
			</div>

			<div className={styles.hudMenuSectionLabel}>{labels.microphone}</div>
			{micDevices.length === 0 ? (
				<div className={styles.hudModalEmpty}>{labels.noMicrophones}</div>
			) : (
				micDevices.map((device) => {
					const isActive = device.deviceId === activeMicId;
					return (
						<button
							key={device.deviceId}
							type="button"
							role="menuitemradio"
							aria-checked={isActive}
							onClick={() => onSelectMic(device)}
							className={`${styles.languageMenuItem} ${isActive ? styles.languageMenuItemActive : ""}`}
						>
							<span className="truncate">{device.label}</span>
							{isActive ? <Check size={11} className="text-white/85" /> : null}
						</button>
					);
				})
			)}
			<div className={styles.hudModalMeterRow}>
				<span className={styles.hudModalMeterLabel}>{labels.micLevel}</span>
				<LevelMeter level={level} />
			</div>
			<div className={styles.hudModalHint}>{labels.micHint}</div>

			{/* Under the mic, because it is about the mic — and a multiplier rather than an
			    absolute level, so 100% is whatever the app was already doing (unity alone,
			    1.4x over system audio). The level meter above reads the raw device and does
			    NOT reflect this. */}
			<div className={styles.hudMenuSectionLabel}>{labels.micGain}</div>
			<div className={styles.hudSegmentRow}>
				{MICROPHONE_GAINS.map((gain) => (
					<SegmentButton
						key={gain}
						label={`${Math.round(gain * 100)}%`}
						active={gain === microphoneGain}
						onSelect={() => onSelectMicGain(gain)}
					/>
				))}
			</div>

			<div className={styles.hudMenuSectionLabel}>{labels.camera}</div>
			{cameraLoading ? (
				<div className={styles.hudModalEmpty}>{labels.searching}</div>
			) : cameraError ? (
				<div className={styles.hudModalEmpty}>{labels.cameraUnavailable}</div>
			) : cameraDevices.length === 0 ? (
				<div className={styles.hudModalEmpty}>{labels.noCameras}</div>
			) : (
				cameraDevices.map((device) => {
					const isActive = device.deviceId === activeCameraId;
					return (
						<button
							key={device.deviceId}
							type="button"
							role="menuitemradio"
							aria-checked={isActive}
							onClick={() => onSelectCamera(device)}
							className={`${styles.languageMenuItem} ${isActive ? styles.languageMenuItemActive : ""}`}
						>
							<span className="truncate">{device.label}</span>
							{isActive ? <Check size={11} className="text-white/85" /> : null}
						</button>
					);
				})
			)}
			{hasCamera ? (
				<>
					<div className={styles.hudModalMeterRow}>
						<span className={styles.hudModalMeterLabel}>{labels.preview}</span>
					</div>
					<CameraPreview
						stream={stream}
						error={previewError}
						unavailableLabel={labels.previewUnavailable}
					/>
				</>
			) : null}

			{/* Frame rate and size, the two knobs that decide whether the encoder can keep
			    up. They live here because this panel is the app's only settings surface,
			    and next to the devices because they are the same kind of choice: what the
			    next recording is made of. Values are unlocalised numbers by design. */}
			<div className={styles.hudMenuSectionLabel}>{labels.countdown}</div>
			<div className={styles.hudSegmentRow}>
				{COUNTDOWN_OPTIONS.map((seconds) => (
					<SegmentButton
						key={seconds}
						// 0 reads as "Off", not as "0": the number would look like a broken
						// default rather than the deliberate "start the moment I click".
						label={seconds === 0 ? labels.countdownOff : String(seconds)}
						active={seconds === countdownSeconds}
						onSelect={() => onSelectCountdown(seconds)}
					/>
				))}
			</div>

			<div className={styles.hudMenuSectionLabel}>{labels.frameRate}</div>
			<div className={styles.hudSegmentRow}>
				{CAPTURE_FRAME_RATES.map((fps) => (
					<SegmentButton
						key={fps}
						label={String(fps)}
						active={fps === captureFrameRate}
						onSelect={() => onSelectFrameRate(fps)}
					/>
				))}
			</div>

			<div className={styles.hudMenuSectionLabel}>{labels.resolution}</div>
			<div className={styles.hudSegmentRow}>
				{CAPTURE_RESOLUTION_PRESETS.map((preset) => (
					<SegmentButton
						key={preset}
						label={preset === "auto" ? labels.resolutionAuto : preset}
						active={preset === captureResolution}
						onSelect={() => onSelectResolution(preset)}
					/>
				))}
			</div>
			<div className={styles.hudModalHint}>{labels.captureHint}</div>

			{/* Where the next take is written — the same kind of choice as the rows above. Main
			    owns the path: Change opens the OS picker there, and nothing here types one in. */}
			{recordingsFolder ? (
				<>
					<div className={styles.hudMenuSectionLabel}>{labels.saveTo}</div>
					<div className={styles.hudModalAboutRow}>
						<span
							className={`${styles.hudModalVersion} min-w-0 truncate`}
							title={recordingsFolder.folder}
						>
							{recordingsFolder.folder}
						</span>
						<span className="flex shrink-0">
							<button
								type="button"
								onClick={onChooseRecordingsFolder}
								disabled={recordingsFolderLocked}
								className={styles.hudModalAboutAction}
							>
								{labels.changeFolder}
							</button>
							{recordingsFolder.isDefault ? null : (
								<button
									type="button"
									onClick={onResetRecordingsFolder}
									disabled={recordingsFolderLocked}
									className={styles.hudModalAboutAction}
								>
									{labels.resetFolder}
								</button>
							)}
						</span>
					</div>
					<div className={styles.hudModalHint}>
						{recordingsFolder.available ? labels.folderHint : labels.folderUnavailable}
					</div>
				</>
			) : null}

			{/* This panel is the app's only settings surface, so the permission list
			    lives here rather than behind a window of its own: it is the same
			    question as the device rows above — will the next recording actually
			    get what it asks for — and it renders nothing at all on a platform
			    that gates none of it. */}
			<HudPermissions />

			{/* The HUD has no other settings surface, and an app the user cannot ask "which
			    version am I running?" is an app whose bug reports arrive without one. The
			    update button is absent — not disabled — where a package manager owns the
			    update; see electron/install-channel.ts. */}
			{versionLabel ? (
				<>
					<div className={styles.hudMenuSectionLabel}>{labels.about}</div>
					<div className={styles.hudModalAboutRow}>
						<span className={styles.hudModalVersion}>{versionLabel}</span>
						{canCheckForUpdates ? (
							<button
								type="button"
								data-testid="hud-check-for-updates"
								onClick={onCheckForUpdates}
								disabled={checkingForUpdates}
								className={styles.hudModalAboutAction}
							>
								{checkingForUpdates ? labels.checkingForUpdates : labels.checkForUpdates}
							</button>
						) : null}
					</div>
				</>
			) : null}
		</div>
	);
});
