import Foundation
import AppKit
import AVFoundation
import AudioToolbox
import CoreGraphics
import CoreMedia
import CoreVideo
import CoreImage
import ScreenCaptureKit

enum CameraOverlayShape: String {
    case rounded
    case square
    case circle
}

struct OverlayRect {
    let x: Int
    let y: Int
    let width: Int
    let height: Int
    let cornerRadius: Int
}

struct RecordingStopSummary {
    let frameCount: Int
    let observedFrameRate: Int
}

struct RecorderArguments {
    let outputPath: String
    let sourceId: String?
    let displayId: String?
    let hideCursor: Bool
    let microphoneEnabled: Bool
    let microphoneGain: Float
    let fps: Int
    let bitrateScale: Double
    let targetWidth: Int?
    let targetHeight: Int?
    let cameraEnabled: Bool
    let cameraShape: CameraOverlayShape
    let cameraSizePercent: Int
    /// Preferred camera: AVCaptureDevice `uniqueID` and/or the browser-reported label.
    let cameraDeviceId: String?
    let cameraDeviceName: String?
    /// Preferred microphone: AVCaptureDevice `uniqueID` and/or the browser-reported label.
    let microphoneDeviceId: String?
    let microphoneDeviceName: String?
    /// Capture what the system plays (ScreenCaptureKit audio output).
    let systemAudioEnabled: Bool
    /// D1: process id of an application whose windows must stay out of the
    /// capture (Capturia's own HUD, countdown overlay and source selector).
    /// `nil` when `--exclude-pid` is absent, which is the pre-D1 behaviour.
    let excludePid: pid_t?

    static func parse(from argv: [String]) throws -> RecorderArguments {
        var outputPath: String?
        var sourceId: String?
        var displayId: String?
        var hideCursor = false
        var microphoneEnabled = true
        var microphoneGain: Float = 1
        var fps = 60
        var bitrateScale = 1.0
        var targetWidth: Int?
        var targetHeight: Int?
        var cameraEnabled = false
        var cameraShape: CameraOverlayShape = .rounded
        var cameraSizePercent = 22
        var cameraDeviceId: String?
        var cameraDeviceName: String?
        var microphoneDeviceId: String?
        var microphoneDeviceName: String?
        var systemAudioEnabled = false
        var excludePid: pid_t?

        var idx = 1
        while idx < argv.count {
            let key = argv[idx]
            let next = idx + 1 < argv.count ? argv[idx + 1] : nil
            switch key {
            case "--output":
                guard let value = next else { throw RecorderError.invalidArguments("Missing --output value") }
                outputPath = value
                idx += 2
            case "--source-id":
                sourceId = next
                idx += 2
            case "--display-id":
                displayId = next
                idx += 2
            case "--hide-cursor":
                guard let value = next else { throw RecorderError.invalidArguments("Missing --hide-cursor value") }
                hideCursor = value == "1" || value.lowercased() == "true"
                idx += 2
            case "--microphone-enabled":
                guard let value = next else { throw RecorderError.invalidArguments("Missing --microphone-enabled value") }
                microphoneEnabled = value == "1" || value.lowercased() == "true"
                idx += 2
            case "--microphone-gain":
                if let value = next, let parsed = Float(value), parsed.isFinite {
                    microphoneGain = parsed
                }
                idx += 2
            case "--fps":
                guard let value = next, let parsed = Int(value), parsed > 0 else {
                    throw RecorderError.invalidArguments("Invalid --fps value")
                }
                fps = max(1, min(120, parsed))
                idx += 2
            case "--bitrate-scale":
                if let value = next, let parsed = Double(value), parsed.isFinite {
                    bitrateScale = parsed
                }
                idx += 2
            case "--width":
                if let value = next, let parsed = Int(value), parsed > 1 {
                    targetWidth = parsed
                }
                idx += 2
            case "--height":
                if let value = next, let parsed = Int(value), parsed > 1 {
                    targetHeight = parsed
                }
                idx += 2
            case "--camera-enabled":
                guard let value = next else { throw RecorderError.invalidArguments("Missing --camera-enabled value") }
                cameraEnabled = value == "1" || value.lowercased() == "true"
                idx += 2
            case "--camera-shape":
                if let value = next, let shape = CameraOverlayShape(rawValue: value.lowercased()) {
                    cameraShape = shape
                }
                idx += 2
            case "--camera-size-percent":
                if let value = next, let parsed = Int(value) {
                    cameraSizePercent = parsed
                }
                idx += 2
            case "--camera-device-id":
                if let value = next, !value.isEmpty {
                    cameraDeviceId = value
                }
                idx += 2
            case "--camera-device-name":
                if let value = next, !value.isEmpty {
                    cameraDeviceName = value
                }
                idx += 2
            case "--mic-device-id":
                if let value = next, !value.isEmpty {
                    microphoneDeviceId = value
                }
                idx += 2
            case "--mic-device-name":
                if let value = next, !value.isEmpty {
                    microphoneDeviceName = value
                }
                idx += 2
            case "--system-audio":
                guard let value = next else { throw RecorderError.invalidArguments("Missing --system-audio value") }
                systemAudioEnabled = value == "1" || value.lowercased() == "true"
                idx += 2
            case "--exclude-pid":
                // Tolerant like the other optional flags: a value that is not a
                // positive pid leaves the filter exactly as it was without the flag.
                if let value = next, let parsed = Int32(value), parsed > 0 {
                    excludePid = pid_t(parsed)
                }
                idx += 2
            default:
                idx += 1
            }
        }

        guard let outputPath else {
            throw RecorderError.invalidArguments("--output is required")
        }

        let clampedSizePercent = max(14, min(40, cameraSizePercent))
        let clampedBitrateScale = max(0.5, min(2.0, bitrateScale))
        let clampedMicrophoneGain = max(Float(0.5), min(Float(2), microphoneGain))

        return RecorderArguments(
            outputPath: outputPath,
            sourceId: sourceId,
            displayId: displayId,
            hideCursor: hideCursor,
            microphoneEnabled: microphoneEnabled,
            microphoneGain: clampedMicrophoneGain,
            fps: fps,
            bitrateScale: clampedBitrateScale,
            targetWidth: targetWidth,
            targetHeight: targetHeight,
            cameraEnabled: cameraEnabled,
            cameraShape: cameraShape,
            cameraSizePercent: clampedSizePercent,
            cameraDeviceId: cameraDeviceId,
            cameraDeviceName: cameraDeviceName,
            microphoneDeviceId: microphoneDeviceId,
            microphoneDeviceName: microphoneDeviceName,
            systemAudioEnabled: systemAudioEnabled,
            excludePid: excludePid
        )
    }
}

enum RecorderError: Error, CustomStringConvertible {
    case invalidArguments(String)
    case sourceNotFound(String)
    case permissionDenied(String)
    case microphonePermissionDenied(String)
    case microphoneUnavailable(String)
    case windowNotFound(String)
    case windowCaptureDenied(String)
    case streamStartFailed(String)
    case streamNotStarted
    case writerFailed(String)
    case cameraUnavailable(String)

    var code: String {
        switch self {
        case .invalidArguments:
            return "invalid_arguments"
        case .sourceNotFound:
            return "source_not_found"
        case .permissionDenied:
            return "permission_denied"
        case .microphonePermissionDenied:
            return "microphone_permission_denied"
        case .microphoneUnavailable:
            return "microphone_unavailable"
        case .windowNotFound:
            return "window_not_found"
        case .windowCaptureDenied:
            return "window_capture_denied"
        case .streamStartFailed:
            return "stream_start_failed"
        case .streamNotStarted:
            return "stream_not_started"
        case .writerFailed:
            return "writer_failed"
        case .cameraUnavailable:
            return "camera_unavailable"
        }
    }

    var description: String {
        switch self {
        case let .invalidArguments(message):
            return "Invalid arguments: \(message)"
        case let .sourceNotFound(message):
            return "Capture source not found: \(message)"
        case let .permissionDenied(message):
            return "Screen Recording permission denied: \(message)"
        case let .microphonePermissionDenied(message):
            return "Microphone permission denied: \(message)"
        case let .microphoneUnavailable(message):
            return "Microphone unavailable: \(message)"
        case let .windowNotFound(message):
            return "Selected window unavailable: \(message)"
        case let .windowCaptureDenied(message):
            return "Selected window cannot be captured: \(message)"
        case let .streamStartFailed(message):
            return "Failed to start capture stream: \(message)"
        case .streamNotStarted:
            return "Stream did not start"
        case let .writerFailed(message):
            return "Writer failed: \(message)"
        case let .cameraUnavailable(message):
            return "Camera unavailable: \(message)"
        }
    }
}

final class StopSignal {
    private var continuation: CheckedContinuation<Void, Never>?
    private var sources: [DispatchSourceSignal] = []

    init() {
        for sig in [SIGINT, SIGTERM] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in
                guard let self else { return }
                self.continuation?.resume()
                self.continuation = nil
            }
            source.resume()
            sources.append(source)
        }
    }

    func wait() async {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    /// Same effect as SIGINT, callable from the stdin command reader thread. The
    /// signal sources deliver on the main queue, so the continuation is only ever
    /// touched from there.
    func trigger() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.continuation?.resume()
            self.continuation = nil
        }
    }
}

final class CameraCaptureProvider: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private static let virtualKeywords = [
        "virtual",
        "obs",
        "continuity",
        "desk view",
        "presenter",
        "iphone",
        "epoccam",
        "ndi",
        "snap camera",
    ]

    private let session = AVCaptureSession()
    private let outputQueue = DispatchQueue(label: "com.capturia.sck-recorder.camera-output")
    private let storageQueue = DispatchQueue(label: "com.capturia.sck-recorder.camera-storage")
    private var latestPixelBuffer: CVPixelBuffer?
    private let preferredDeviceId: String?
    private let preferredDeviceName: String?

    init(preferredDeviceId: String? = nil, preferredDeviceName: String? = nil) {
        self.preferredDeviceId = preferredDeviceId
        self.preferredDeviceName = preferredDeviceName
        super.init()
    }

    func start() throws {
        guard let device = selectCaptureDevice() else {
            throw RecorderError.cameraUnavailable("No video input device available")
        }

        let input = try AVCaptureDeviceInput(device: device)
        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
        ]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: outputQueue)

        session.beginConfiguration()
        session.sessionPreset = .high

        guard session.canAddInput(input) else {
            session.commitConfiguration()
            throw RecorderError.cameraUnavailable("Unable to attach camera input")
        }
        session.addInput(input)

        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            throw RecorderError.cameraUnavailable("Unable to attach camera output")
        }
        session.addOutput(output)

        if let connection = output.connection(with: .video), connection.isVideoMirroringSupported {
            connection.isVideoMirrored = false
        }

        session.commitConfiguration()
        session.startRunning()
    }

    func stop() {
        session.stopRunning()
        storageQueue.sync {
            latestPixelBuffer = nil
        }
    }

    func copyLatestPixelBuffer() -> CVPixelBuffer? {
        storageQueue.sync {
            latestPixelBuffer
        }
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        storageQueue.sync {
            latestPixelBuffer = pixelBuffer
        }
    }

    private func selectCaptureDevice() -> AVCaptureDevice? {
        var deviceTypes: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera]
        if #available(macOS 14.0, *) {
            deviceTypes.append(.external)
        } else {
            deviceTypes.append(.externalUnknown)
        }
        let devices = AVCaptureDevice.DiscoverySession(
            deviceTypes: deviceTypes,
            mediaType: .video,
            position: .unspecified
        ).devices
        guard !devices.isEmpty else { return nil }

        // Explicit choice from the HUD picker: exact uniqueID first, then the label
        // Chromium reported (its deviceId is a per-origin hash, so the name is the
        // reliable half). Fall through to the automatic pick when neither matches.
        if let preferredDeviceId, let match = devices.first(where: { $0.uniqueID == preferredDeviceId }) {
            return match
        }
        if let preferredDeviceName, let match = DeviceNameMatching.pickDevice(named: preferredDeviceName, from: devices) {
            return match
        }

        let nonVirtual = devices.filter { device in
            let label = device.localizedName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return !Self.virtualKeywords.contains(where: { keyword in
                label.contains(keyword)
            })
        }

        return nonVirtual.first ?? devices.first
    }
}

/// Matching a device the renderer picked (Chromium label) against an AVCaptureDevice.
///
/// Twin of `electron/recording/deviceNameMatching.ts`; keep the two in step. Chromium
/// reports the driver name, often suffixed with the USB vendor:product pair
/// ("Logitech StreamCam (046d:0893)"), AVFoundation reports `localizedName`, so the
/// match cannot be plain equality. It is still decisive: exact, exact without the USB
/// suffix, or one name containing the other as whole words. Plain substring matching
/// is deliberately absent: "Logi Capture" is not "Logitech StreamCam" and "Micro
/// Studio" is not "Microphone (Logitech PRO X)", yet both used to match, and opening
/// the wrong device is worse than falling back to the default.
enum DeviceNameMatching {
    static let exactScore = 1000
    static let exactWithoutUsbIdsScore = 950
    static let wordsScore = 900
    static let identifierScore = 800
    static let noMatch = 0

    /// Lowercase, letters/marks/digits only, single-spaced. Unicode-aware on purpose
    /// so non-Latin names keep their letters and are compared as they are.
    static func normalize(_ value: String) -> String {
        var words: [String] = []
        var current = ""
        for scalar in value.lowercased().unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar) {
                current.unicodeScalars.append(scalar)
            } else if !current.isEmpty {
                words.append(current)
                current = ""
            }
        }
        if !current.isEmpty {
            words.append(current)
        }
        return words.joined(separator: " ")
    }

    /// Chromium's "Name (046d:0893)" without the USB pair; unchanged when absent.
    static func stripUsbIdSuffix(_ value: String) -> String {
        var stripped = value
        if let range = stripped.range(
            of: #"\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{4}\)\s*$"#,
            options: .regularExpression
        ) {
            stripped.removeSubrange(range)
        }
        return stripped
    }

    /// Does `needle` appear in `haystack` as whole words? Both are normalized, so a
    /// boundary is the start of the string, its end, or a space.
    static func containsAsWords(_ haystack: String, _ needle: String) -> Bool {
        guard !haystack.isEmpty, !needle.isEmpty else { return false }
        let haystackScalars = Array(haystack.unicodeScalars)
        let needleScalars = Array(needle.unicodeScalars)
        guard needleScalars.count <= haystackScalars.count else { return false }
        let space: Unicode.Scalar = " "
        var at = 0
        while at + needleScalars.count <= haystackScalars.count {
            if haystackScalars[at..<(at + needleScalars.count)].elementsEqual(needleScalars) {
                let startsOnBoundary = at == 0 || haystackScalars[at - 1] == space
                let after = at + needleScalars.count
                let endsOnBoundary = after == haystackScalars.count || haystackScalars[after] == space
                if startsOnBoundary && endsOnBoundary {
                    return true
                }
            }
            at += 1
        }
        return false
    }

    /// How well a candidate answers a requested name; 0 means "not this one" and
    /// callers must treat it as a real answer rather than a weak match.
    static func score(candidateName: String, candidateId: String, requestedName: String) -> Int {
        let requested = normalize(requestedName)
        guard !requested.isEmpty else { return noMatch }

        let candidate = normalize(candidateName)
        if candidate == requested {
            return exactScore
        }

        let requestedWithoutUsbIds = normalize(stripUsbIdSuffix(requestedName))
        if !requestedWithoutUsbIds.isEmpty, requestedWithoutUsbIds != requested, candidate == requestedWithoutUsbIds {
            return exactWithoutUsbIdsScore
        }

        if containsAsWords(candidate, requested) || containsAsWords(requested, candidate) {
            return wordsScore
        }

        let identifier = normalize(candidateId)
        if containsAsWords(identifier, requested) || containsAsWords(requested, identifier) {
            return identifierScore
        }

        return noMatch
    }

    /// Best-scoring device for `requestedName`, or nil when nothing scores above 0.
    /// Ties keep the earlier device (platform order).
    static func pickDevice(named requestedName: String, from devices: [AVCaptureDevice]) -> AVCaptureDevice? {
        var best: AVCaptureDevice?
        var bestScore = noMatch
        for device in devices {
            let deviceScore = score(
                candidateName: device.localizedName,
                candidateId: device.uniqueID,
                requestedName: requestedName
            )
            if deviceScore > bestScore {
                best = device
                bestScore = deviceScore
            }
        }
        return best
    }
}

final class MicrophoneCaptureProvider: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let session = AVCaptureSession()
    private let outputQueue = DispatchQueue(label: "com.capturia.sck-recorder.microphone-output")
    private var onSampleBuffer: ((CMSampleBuffer) -> Void)?
    private let preferredDeviceId: String?
    private let preferredDeviceName: String?
    /// True when a preferred device was requested but nothing matched, so the
    /// system default was opened instead. The caller reports it as a warning.
    private(set) var preferredDeviceMissing = false
    /// `localizedName` of the device actually opened (for the log line).
    private(set) var openedDeviceName: String?

    init(preferredDeviceId: String? = nil, preferredDeviceName: String? = nil) {
        self.preferredDeviceId = preferredDeviceId
        self.preferredDeviceName = preferredDeviceName
        super.init()
    }

    /// `sampleRate`: 44.1 kHz for the mic-only track, 48 kHz when the samples go
    /// through the mixer (so it never has to resample the microphone).
    func start(sampleRate: Int = 44_100, onSampleBuffer: @escaping (CMSampleBuffer) -> Void) throws {
        self.onSampleBuffer = onSampleBuffer

        guard let device = selectCaptureDevice() else {
            throw RecorderError.microphoneUnavailable("No microphone input device available")
        }
        openedDeviceName = device.localizedName

        let input = try AVCaptureDeviceInput(device: device)
        let output = AVCaptureAudioDataOutput()
        output.audioSettings = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
        ]
        output.setSampleBufferDelegate(self, queue: outputQueue)

        session.beginConfiguration()
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            throw RecorderError.microphoneUnavailable("Unable to attach microphone input")
        }
        session.addInput(input)

        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            throw RecorderError.microphoneUnavailable("Unable to attach microphone output")
        }
        session.addOutput(output)
        session.commitConfiguration()
        session.startRunning()
    }

    func stop() {
        session.stopRunning()
        onSampleBuffer = nil
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        onSampleBuffer?(sampleBuffer)
    }

    /// The HUD picker's choice: exact uniqueID first, then the label Chromium
    /// reported under the word-boundary rules. Chromium's deviceId is a per-origin
    /// hash, so the name is the realistic hit. Nothing matched -> system default,
    /// flagged in `preferredDeviceMissing`.
    private func selectCaptureDevice() -> AVCaptureDevice? {
        let hasPreference = preferredDeviceId != nil || preferredDeviceName != nil
        if hasPreference {
            var deviceTypes: [AVCaptureDevice.DeviceType] = [.builtInMicrophone]
            if #available(macOS 14.0, *) {
                deviceTypes.append(.external)
            } else {
                deviceTypes.append(.externalUnknown)
            }
            let devices = AVCaptureDevice.DiscoverySession(
                deviceTypes: deviceTypes,
                mediaType: .audio,
                position: .unspecified
            ).devices

            if let preferredDeviceId, let match = devices.first(where: { $0.uniqueID == preferredDeviceId }) {
                return match
            }
            if let preferredDeviceName, let match = DeviceNameMatching.pickDevice(named: preferredDeviceName, from: devices) {
                return match
            }
            preferredDeviceMissing = true
        }

        return AVCaptureDevice.default(for: .audio)
    }
}


/// Sums system audio and the microphone into the single AAC track the writer muxes.
///
/// One track, never one per source: the editor preview is an HTML5 `<video>`, which
/// plays audio track 0 and offers no way to reach a second one, so a recording with
/// two tracks previewed without the microphone. The two sources run off independent
/// clocks, so samples are placed on a shared timeline by presentation timestamp
/// rather than by arrival order.
///
/// The cursor advances on the clock, not on the data: 10 ms chunks go out for as
/// long as the take runs, filled from whichever source covers them and with silence
/// where none does. A take that starts in silence therefore keeps its leading
/// silence instead of pulling the first sound back to timestamp zero, and a source
/// that stops delivering (unplugged mic) stops holding the track back after a short
/// grace period.
///
/// Not thread-safe by design: every entry point runs on the writer's serial audio
/// queue, which is also where the tick timer fires.
final class MixedAudioTrack {
    enum Source: Int, CaseIterable {
        case system = 0
        case microphone = 1
    }

    /// Mixing happens in Float and quantizes to Int16 once, at the very end.
    private enum MixFormat {
        static let sampleRate = 48_000
        static let channelCount = 2
        static let bytesPerFrame = channelCount * MemoryLayout<Int16>.size
        /// 10 ms chunks.
        static let chunkFrames = sampleRate / 100
        /// How long a source may deliver nothing before chunks go out without it.
        /// Measured from its last delivery, not from how far behind it is, so a
        /// constant capture latency never trips it.
        static let emissionGraceFrames = sampleRate / 4
        /// Longest hole a source may silence-pad across; past this it restarts at
        /// the new position and the clock carries the track over the gap.
        static let maxSilencePadFrames = sampleRate * 2
        /// Writer backpressure allowance, in chunks (5 s).
        static let maxPendingChunks = 500
        /// How long the final flush waits for the input to accept the tail.
        static let finalFlushTimeout = 5.0
        /// Soft limiter knee: below this the sum passes unchanged, above it the
        /// excess is compressed so the output never exceeds full scale.
        static let limiterKnee: Float = 0.9
    }

    private let input: AVAssetWriterInput
    private let clock: () -> CMTime
    private let includesSystemAudio: Bool
    private let includesMicrophone: Bool
    private let microphoneGain: Float
    private let outputFormatDescription: CMAudioFormatDescription?

    private var sources = [SourceTimeline](repeating: SourceTimeline(), count: Source.allCases.count)
    /// Frame 0 of the mixed track, in the writer's time domain. Set once, eagerly,
    /// to the writer session start; never inferred from a buffer.
    private var anchor: CMTime?
    /// Absolute frame index of the next chunk to emit.
    private var cursor: Int64 = 0
    private var pending: [CMSampleBuffer] = []
    private var didWarnAboutBacklog = false
    private var didWarnAboutDecode: Set<Int> = []

    /// - clock: the instant the writer timeline has reached (host clock minus the
    ///   session start and everything spent paused; frozen while paused).
    init(
        input: AVAssetWriterInput,
        includesSystemAudio: Bool,
        includesMicrophone: Bool,
        microphoneGain: Float,
        clock: @escaping () -> CMTime
    ) {
        self.input = input
        self.clock = clock
        self.includesSystemAudio = includesSystemAudio
        self.includesMicrophone = includesMicrophone
        self.microphoneGain = microphoneGain.isFinite ? max(0, microphoneGain) : 1
        self.outputFormatDescription = Self.makeOutputFormatDescription()
    }

    /// Anchors frame 0 of the mixed track to the writer session start. Audio that
    /// arrives before it is trimmed at frame zero; audio that arrives later lands
    /// at the offset it belongs at with real silence in front of it.
    func beginTimeline(at sessionStart: CMTime) {
        guard anchor == nil, sessionStart.isValid, sessionStart.isNumeric else { return }
        anchor = CMTimeConvertScale(
            sessionStart,
            timescale: CMTimeScale(MixFormat.sampleRate),
            method: .roundHalfAwayFromZero
        )
    }

    /// `sampleBuffer` must already be retimed into the writer's domain.
    func ingest(_ sampleBuffer: CMSampleBuffer, from source: Source) {
        guard includes(source), let anchor else { return }
        let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard presentationTime.isValid, presentationTime.isNumeric else { return }
        guard let frames = decodeInterleavedStereo(sampleBuffer, gain: gain(for: source)), !frames.isEmpty else {
            warnAboutDecodeFailure(source, sampleBuffer)
            return
        }

        let now = clock()
        let startFrame = frameIndex(of: presentationTime, from: anchor)
        sources[source.rawValue].ingest(frames, atFrame: startFrame)
        sources[source.rawValue].lastDeliveryFrame = frameIndex(of: now, from: anchor)
        drain(upTo: now, grace: Int64(MixFormat.emissionGraceFrames))
    }

    /// Advances the cursor to wherever the clock now stands, emitting silence for
    /// anything no source covered. Called on a timer.
    func tick() {
        guard anchor != nil else { return }
        drain(upTo: clock(), grace: Int64(MixFormat.emissionGraceFrames))
    }

    /// Carries the track out to `end` and writes out everything still buffered.
    /// Call once, on the audio queue, before the input is marked as finished.
    func finish(atSourceTime end: CMTime) {
        if anchor != nil {
            drain(upTo: end, grace: 0)
        }
        flushPending(force: true)
    }

    private func warnAboutDecodeFailure(_ source: Source, _ sampleBuffer: CMSampleBuffer) {
        guard !didWarnAboutDecode.contains(source.rawValue) else { return }
        didWarnAboutDecode.insert(source.rawValue)
        var description = "unknown format"
        if let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
           let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)?.pointee {
            let interleaving = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
                ? "non-interleaved" : "interleaved"
            description = "\(asbd.mSampleRate) Hz, \(asbd.mChannelsPerFrame) ch, \(asbd.mBitsPerChannel)-bit, \(interleaving)"
        }
        print("SCK_RECORDER_WARN audio_source_undecodable source=\(source == .system ? "system" : "microphone") format=\(description)")
        fflush(stdout)
    }

    private func frameIndex(of time: CMTime, from anchor: CMTime) -> Int64 {
        CMTimeConvertScale(
            CMTimeSubtract(time, anchor),
            timescale: CMTimeScale(MixFormat.sampleRate),
            method: .roundHalfAwayFromZero
        ).value
    }

    private func includes(_ source: Source) -> Bool {
        switch source {
        case .system:
            return includesSystemAudio
        case .microphone:
            return includesMicrophone
        }
    }

    private func gain(for source: Source) -> Float {
        switch source {
        case .system:
            return 1
        case .microphone:
            return microphoneGain
        }
    }

    /// Emits every chunk the clock has passed. A chunk goes out as soon as every
    /// live source covers it, or once every source still missing from it has gone
    /// `grace` without delivering anything. `chunkEnd <= limitFrame` bounds the
    /// loop so the cursor never outruns the take.
    private func drain(upTo limit: CMTime, grace: Int64) {
        guard let anchor, limit.isValid, limit.isNumeric else { return }
        let limitFrame = frameIndex(of: limit, from: anchor)

        while true {
            let chunkEnd = cursor + Int64(MixFormat.chunkFrames)
            guard chunkEnd <= limitFrame else { break }

            let live = sources.indices.filter { sources[$0].hasDelivered && !sources[$0].isStalled }
            let laggards = live.filter { sources[$0].endFrame < chunkEnd }
            if !laggards.isEmpty {
                guard laggards.allSatisfy({ limitFrame >= sources[$0].lastDeliveryFrame + grace }) else {
                    break
                }
                // Each stays stalled until its next buffer arrives, so one quiet
                // source can never hold the track back chunk after chunk.
                for index in laggards {
                    sources[index].isStalled = true
                }
            }

            emitChunk()
        }
    }

    private func emitChunk() {
        var mix = [Float](repeating: 0, count: MixFormat.chunkFrames * MixFormat.channelCount)
        for index in sources.indices {
            sources[index].drain(into: &mix, from: cursor, frameCount: MixFormat.chunkFrames)
        }

        let presentationTime = CMTimeAdd(
            anchor ?? .zero,
            CMTime(value: cursor, timescale: CMTimeScale(MixFormat.sampleRate))
        )
        cursor += Int64(MixFormat.chunkFrames)

        guard let sampleBuffer = makeSampleBuffer(from: mix, at: presentationTime) else { return }
        pending.append(sampleBuffer)
        flushPending(force: false)
    }

    /// `append` raises when the input is not ready, so every path waits for
    /// readiness rather than pushing through it.
    private func flushPending(force: Bool) {
        while !pending.isEmpty && input.isReadyForMoreMediaData {
            input.append(pending.removeFirst())
        }
        if force {
            let deadline = Date().addingTimeInterval(MixFormat.finalFlushTimeout)
            while !pending.isEmpty {
                if input.isReadyForMoreMediaData {
                    input.append(pending.removeFirst())
                    continue
                }
                if Date() >= deadline {
                    print("SCK_RECORDER_WARN audio_mixer_tail_dropped chunks=\(pending.count)")
                    fflush(stdout)
                    pending.removeAll()
                    break
                }
                Thread.sleep(forTimeInterval: 0.002)
            }
            return
        }
        guard pending.count > MixFormat.maxPendingChunks else { return }

        pending.removeFirst(pending.count - MixFormat.maxPendingChunks)
        if !didWarnAboutBacklog {
            didWarnAboutBacklog = true
            print("SCK_RECORDER_WARN audio_mixer_backlog")
            fflush(stdout)
        }
    }

    // MARK: - Sample conversion

    /// Decodes one capture buffer into gain-applied 48 kHz interleaved-stereo Float.
    /// The system audio output arrives non-interleaved Float32 at the configured
    /// 48 kHz stereo, the microphone interleaved mono; anything else (Int16/Int32,
    /// off-rate) is handled because the format is the source's to choose.
    private func decodeInterleavedStereo(_ sampleBuffer: CMSampleBuffer, gain: Float) -> [Float]? {
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) else {
            return nil
        }

        let asbd = streamDescription.pointee
        let sourceFrames = CMSampleBufferGetNumSamples(sampleBuffer)
        let sourceChannels = Int(asbd.mChannelsPerFrame)
        let bitsPerChannel = Int(asbd.mBitsPerChannel)
        let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        guard asbd.mFormatID == kAudioFormatLinearPCM,
              sourceChannels > 0,
              asbd.mSampleRate > 0,
              sourceFrames > 0,
              isFloat ? bitsPerChannel == 32 : (bitsPerChannel == 16 || bitsPerChannel == 32) else {
            return nil
        }

        // One AudioBuffer per channel when non-interleaved, exactly one otherwise.
        // CoreMedia rejects a list whose size does not match what it is about to
        // write, so the count must be exact in both directions.
        let isNonInterleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let bufferCount = isNonInterleaved ? sourceChannels : 1
        let bufferList = AudioBufferList.allocate(maximumBuffers: bufferCount)
        defer { free(bufferList.unsafeMutablePointer) }

        var blockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: bufferList.unsafeMutablePointer,
            bufferListSize: AudioBufferList.sizeInBytes(maximumBuffers: bufferCount),
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &blockBuffer
        )
        guard status == noErr, blockBuffer != nil else {
            return nil
        }

        return withExtendedLifetime(blockBuffer) { () -> [Float]? in
            let bytesPerChannelSample = bitsPerChannel / 8
            guard bufferList.count > 0 else { return nil }

            // Stereo out: mono sources feed both sides, wider sources keep their
            // first two channels.
            var readers = [ChannelReader]()
            for channel in 0..<MixFormat.channelCount {
                let sourceChannel = min(channel, sourceChannels - 1)
                let buffer = isNonInterleaved
                    ? bufferList[min(sourceChannel, bufferList.count - 1)]
                    : bufferList[0]
                guard let data = buffer.mData else { return nil }
                readers.append(
                    ChannelReader(
                        base: UnsafeRawPointer(data),
                        sampleCount: Int(buffer.mDataByteSize) / bytesPerChannelSample,
                        stride: isNonInterleaved ? 1 : sourceChannels,
                        start: isNonInterleaved ? 0 : sourceChannel,
                        bytesPerSample: bytesPerChannelSample,
                        isFloat: isFloat
                    )
                )
            }

            let targetFrames = asbd.mSampleRate == Double(MixFormat.sampleRate)
                ? sourceFrames
                : max(1, Int((Double(sourceFrames) * Double(MixFormat.sampleRate) / asbd.mSampleRate).rounded()))
            let ratio = Double(sourceFrames) / Double(targetFrames)

            var output = [Float](repeating: 0, count: targetFrames * MixFormat.channelCount)
            for targetFrame in 0..<targetFrames {
                let sourceFrame = targetFrames == sourceFrames
                    ? targetFrame
                    : min(sourceFrames - 1, Int((Double(targetFrame) * ratio).rounded()))
                for channel in 0..<MixFormat.channelCount {
                    output[targetFrame * MixFormat.channelCount + channel] =
                        readers[channel].value(at: sourceFrame) * gain
                }
            }
            return output
        }
    }

    /// Soft limiter on the summed signal: transparent below the knee, compresses
    /// the excess above it, never exceeds full scale.
    private static func softLimit(_ sample: Float) -> Float {
        let knee = MixFormat.limiterKnee
        let magnitude = abs(sample)
        if magnitude <= knee {
            return sample
        }
        let headroom = 1 - knee
        let limited = knee + headroom * tanh((magnitude - knee) / headroom)
        return sample < 0 ? -limited : limited
    }

    private func makeSampleBuffer(from mix: [Float], at presentationTime: CMTime) -> CMSampleBuffer? {
        guard let outputFormatDescription else { return nil }
        let frameCount = mix.count / MixFormat.channelCount
        guard frameCount > 0 else { return nil }

        // The one and only quantization: sum in Float, limit once, land on Int16.
        var pcm = [Int16](repeating: 0, count: mix.count)
        for index in mix.indices {
            let limited = Self.softLimit(mix[index])
            pcm[index] = Int16((min(max(limited, -1), 1) * 32_767).rounded())
        }

        let byteCount = pcm.count * MemoryLayout<Int16>.size
        var blockBuffer: CMBlockBuffer?
        var status = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault,
            memoryBlock: nil,
            blockLength: byteCount,
            blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil,
            offsetToData: 0,
            dataLength: byteCount,
            flags: kCMBlockBufferAssureMemoryNowFlag,
            blockBufferOut: &blockBuffer
        )
        guard status == kCMBlockBufferNoErr, let blockBuffer else { return nil }

        status = pcm.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else {
                return kCMBlockBufferBadPointerParameterErr
            }
            return CMBlockBufferReplaceDataBytes(
                with: base,
                blockBuffer: blockBuffer,
                offsetIntoDestination: 0,
                dataLength: byteCount
            )
        }
        guard status == kCMBlockBufferNoErr else { return nil }

        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: CMTimeScale(MixFormat.sampleRate)),
            presentationTimeStamp: presentationTime,
            decodeTimeStamp: .invalid
        )
        var sampleSize = MixFormat.bytesPerFrame
        var sampleBuffer: CMSampleBuffer?
        guard CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault,
            dataBuffer: blockBuffer,
            formatDescription: outputFormatDescription,
            sampleCount: frameCount,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleSizeEntryCount: 1,
            sampleSizeArray: &sampleSize,
            sampleBufferOut: &sampleBuffer
        ) == noErr else {
            return nil
        }

        return sampleBuffer
    }

    private static func makeOutputFormatDescription() -> CMAudioFormatDescription? {
        var asbd = AudioStreamBasicDescription(
            mSampleRate: Float64(MixFormat.sampleRate),
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked | kAudioFormatFlagsNativeEndian,
            mBytesPerPacket: UInt32(MixFormat.bytesPerFrame),
            mFramesPerPacket: 1,
            mBytesPerFrame: UInt32(MixFormat.bytesPerFrame),
            mChannelsPerFrame: UInt32(MixFormat.channelCount),
            mBitsPerChannel: 16,
            mReserved: 0
        )

        var formatDescription: CMAudioFormatDescription?
        guard CMAudioFormatDescriptionCreate(
            allocator: kCFAllocatorDefault,
            asbd: &asbd,
            layoutSize: 0,
            layout: nil,
            magicCookieSize: 0,
            magicCookie: nil,
            extensions: nil,
            formatDescriptionOut: &formatDescription
        ) == noErr else {
            return nil
        }

        return formatDescription
    }

    // MARK: - Per-source timeline

    /// Reads one channel out of a capture buffer, whatever layout and sample type it uses.
    private struct ChannelReader {
        let base: UnsafeRawPointer
        let sampleCount: Int
        let stride: Int
        let start: Int
        let bytesPerSample: Int
        let isFloat: Bool

        func value(at frame: Int) -> Float {
            let index = start + frame * stride
            guard index >= 0, index < sampleCount else { return 0 }

            let offset = index * bytesPerSample
            if isFloat {
                return base.loadUnaligned(fromByteOffset: offset, as: Float.self)
            }
            if bytesPerSample == 2 {
                return Float(base.loadUnaligned(fromByteOffset: offset, as: Int16.self)) / 32_768
            }
            return Float(base.loadUnaligned(fromByteOffset: offset, as: Int32.self)) / 2_147_483_648
        }
    }

    /// One source's pending samples on the shared timeline: `startFrame` is the
    /// absolute frame index of the first frame in `samples`. A negative index is
    /// audio captured before the session started; it is trimmed at frame zero.
    private struct SourceTimeline {
        private(set) var samples: [Float] = []
        private(set) var startFrame: Int64 = 0
        /// A source only counts towards "is this chunk complete" once it has produced audio...
        private(set) var hasDelivered = false
        /// ...and stops counting once it has gone `emissionGraceFrames` without producing any.
        var isStalled = false
        /// Where the clock stood at this source's most recent delivery, in absolute frames.
        var lastDeliveryFrame: Int64 = 0

        var endFrame: Int64 { startFrame + Int64(samples.count / MixFormat.channelCount) }

        mutating func ingest(_ frames: [Float], atFrame frameIndex: Int64) {
            hasDelivered = true
            isStalled = false

            if samples.isEmpty {
                startFrame = frameIndex
                samples = frames
                return
            }

            if frameIndex >= endFrame {
                let gapFrames = Int(frameIndex - endFrame)
                if gapFrames > MixFormat.maxSilencePadFrames {
                    // Nothing arrived for seconds: restart here and let the mixer's
                    // clock carry the track across; stale pending samples go with it.
                    startFrame = frameIndex
                    samples = frames
                    return
                }
                samples.append(contentsOf: repeatElement(0, count: gapFrames * MixFormat.channelCount))
                samples.append(contentsOf: frames)
                return
            }

            // Overlap: the source restated a span we already hold. Keep what we
            // have and take only the tail, so a duplicated buffer can't double up.
            let overlap = Int(endFrame - frameIndex) * MixFormat.channelCount
            guard overlap < frames.count else { return }
            samples.append(contentsOf: frames[overlap...])
        }

        /// Adds this source's contribution to one chunk and consumes it. Frames it
        /// doesn't cover are left alone (`mix` already holds silence there).
        mutating func drain(into mix: inout [Float], from cursor: Int64, frameCount: Int) {
            discardFrames(before: cursor)
            guard !samples.isEmpty else { return }

            let lead = Int(startFrame - cursor)
            guard lead < frameCount else { return }
            let usableFrames = min(frameCount - lead, samples.count / MixFormat.channelCount)
            guard usableFrames > 0 else { return }

            let base = lead * MixFormat.channelCount
            for index in 0..<(usableFrames * MixFormat.channelCount) {
                mix[base + index] += samples[index]
            }
            samples.removeFirst(usableFrames * MixFormat.channelCount)
            startFrame += Int64(usableFrames)
        }

        /// Discards samples the mixer has already emitted past.
        private mutating func discardFrames(before cursor: Int64) {
            guard startFrame < cursor else { return }

            let available = Int64(samples.count / MixFormat.channelCount)
            let discarded = min(cursor - startFrame, available)
            if discarded > 0 {
                samples.removeFirst(Int(discarded) * MixFormat.channelCount)
                startFrame += discarded
            }
            if samples.isEmpty {
                startFrame = cursor
            }
        }
    }
}

final class ScreenStreamWriter: NSObject, SCStreamOutput {
    private static let microphoneLimiterCeiling: Float = 0.98

    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let audioInput: AVAssetWriterInput?
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private let ciContext = CIContext(options: [
        CIContextOption.cacheIntermediates: false,
    ])
    private let colorSpace = CGColorSpaceCreateDeviceRGB()
    private let audioQueue = DispatchQueue(label: "com.capturia.sck-recorder.audio-writer")
    private let microphoneGain: Float
    /// Present when system audio is on: both sources feed one mixed track.
    /// Mic-only recordings keep the direct (44.1 kHz mono) path below.
    /// Assigned at the end of init (its clock closure needs `self`).
    private var audioMixer: MixedAudioTrack?
    /// Drives the mixer's cursor while nothing is arriving. Owned by `audioQueue`.
    private var audioTicker: DispatchSourceTimer?

    private let videoWidth: Int
    private let videoHeight: Int
    private let cameraProvider: CameraCaptureProvider?
    private let overlayRect: OverlayRect?
    private let overlayMaskImage: CIImage?
    private let overlayBorderImage: CIImage?
    let hasMicrophoneAudio: Bool
    let hasSystemAudio: Bool

    private var firstPTS: CMTime?
    private var lastRelativePTS: CMTime?
    private(set) var frameCount = 0

    // Pause state: while paused every sample is
    // dropped; after a resume every sample is retimed by the accumulated pause
    // duration so the output timeline has no gap. Guarded by `stateQueue` because
    // the stdin reader thread, the SCK sample queue and the audio queue all touch it.
    private let stateQueue = DispatchQueue(label: "com.capturia.sck-recorder.pause-state")
    private var isPaused = false
    private var pauseStartedAt: CMTime?
    private var totalPausedDuration = CMTime.zero
    private let hostClock = CMClockGetHostTimeClock()

    init(
        outputURL: URL,
        width: Int,
        height: Int,
        fps: Int,
        bitrateScale: Double,
        microphoneEnabled: Bool,
        microphoneGain: Float,
        systemAudioEnabled: Bool,
        cameraProvider: CameraCaptureProvider?,
        cameraShape: CameraOverlayShape,
        cameraSizePercent: Int
    ) throws {
        writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
        input = AVAssetWriterInput(
            mediaType: .video,
            outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: max(Int(Double(width * height * max(1, fps)) * bitrateScale), 6_000_000),
                    AVVideoMaxKeyFrameIntervalKey: max(1, fps),
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                ],
            ]
        )
        input.expectsMediaDataInRealTime = true
        if !writer.canAdd(input) {
            throw RecorderError.writerFailed("Unable to attach AVAssetWriterInput")
        }
        writer.add(input)

        if systemAudioEnabled {
            // One mixed AAC track (48 kHz stereo) for system audio plus, when on, the mic.
            let audioInput = AVAssetWriterInput(
                mediaType: .audio,
                outputSettings: [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVEncoderBitRateKey: 192_000,
                    AVSampleRateKey: 48_000,
                    AVNumberOfChannelsKey: 2,
                ]
            )
            audioInput.expectsMediaDataInRealTime = true
            guard writer.canAdd(audioInput) else {
                throw RecorderError.writerFailed("Unable to attach AVAssetWriter mixed audio input")
            }
            writer.add(audioInput)
            self.audioInput = audioInput
        } else if microphoneEnabled {
            let audioInput = AVAssetWriterInput(
                mediaType: .audio,
                outputSettings: [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVEncoderBitRateKey: 128_000,
                    AVSampleRateKey: 44_100,
                    AVNumberOfChannelsKey: 1,
                ]
            )
            audioInput.expectsMediaDataInRealTime = true
            if writer.canAdd(audioInput) {
                writer.add(audioInput)
                self.audioInput = audioInput
            } else {
                throw RecorderError.writerFailed("Unable to attach AVAssetWriter audio input")
            }
        } else {
            audioInput = nil
        }

        adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
                kCVPixelFormatOpenGLCompatibility as String: true,
            ]
        )

        videoWidth = width
        videoHeight = height
        self.microphoneGain = max(Float(0.5), min(Float(2), microphoneGain))
        self.cameraProvider = cameraProvider
        hasMicrophoneAudio = microphoneEnabled
        hasSystemAudio = systemAudioEnabled

        if cameraProvider != nil {
            let overlay = Self.computeOverlayRect(
                canvasWidth: width,
                canvasHeight: height,
                shape: cameraShape,
                sizePercent: cameraSizePercent
            )
            overlayRect = overlay
            overlayMaskImage = Self.buildMaskImage(canvasWidth: width, canvasHeight: height, overlay: overlay, shape: cameraShape)
            overlayBorderImage = Self.buildBorderImage(canvasWidth: width, canvasHeight: height, overlay: overlay, shape: cameraShape)
        } else {
            overlayRect = nil
            overlayMaskImage = nil
            overlayBorderImage = nil
        }

        super.init()

        if systemAudioEnabled, let audioInput {
            audioMixer = MixedAudioTrack(
                input: audioInput,
                includesSystemAudio: true,
                includesMicrophone: microphoneEnabled,
                microphoneGain: self.microphoneGain,
                clock: { [weak self] in self?.timelineNow() ?? .invalid }
            )
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        if outputType == .audio {
            appendSystemAudioSampleBuffer(sampleBuffer)
            return
        }
        guard outputType == .screen else { return }
        guard let screenPixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let pauseState = currentPauseState()
        if pauseState.paused {
            return
        }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if firstPTS == nil {
            firstPTS = pts
            writer.startWriting()
            writer.startSession(atSourceTime: .zero)
            startMixedAudioTimeline()
        }

        guard let firstPTS else { return }
        guard input.isReadyForMoreMediaData else { return }

        let outputPixelBuffer: CVPixelBuffer
        if let composed = composeFrame(screenPixelBuffer: screenPixelBuffer) {
            outputPixelBuffer = composed
        } else {
            outputPixelBuffer = screenPixelBuffer
        }

        // Relative to the first frame, minus everything spent paused so far.
        let relative = CMTimeSubtract(CMTimeSubtract(pts, firstPTS), pauseState.offset)
        guard relative >= .zero else { return }
        if let lastRelativePTS, relative <= lastRelativePTS {
            // Never hand the writer a non-increasing timestamp (clock jitter right
            // after a resume); the next frame carries the timeline on.
            return
        }
        if adaptor.append(outputPixelBuffer, withPresentationTime: relative) {
            frameCount += 1
            lastRelativePTS = relative
        }
    }

    /// Returns true when the writer is paused after the call (idempotent).
    func pause() -> Bool {
        stateQueue.sync {
            if !isPaused {
                isPaused = true
                pauseStartedAt = CMClockGetTime(hostClock)
            }
            return isPaused
        }
    }

    /// Returns true when the writer is recording after the call (idempotent).
    func resume() -> Bool {
        stateQueue.sync {
            if isPaused {
                if let pauseStartedAt {
                    let now = CMClockGetTime(hostClock)
                    totalPausedDuration = CMTimeAdd(
                        totalPausedDuration,
                        CMTimeSubtract(now, pauseStartedAt)
                    )
                }
                isPaused = false
                pauseStartedAt = nil
            }
            return !isPaused
        }
    }

    private func currentPauseState() -> (paused: Bool, offset: CMTime) {
        stateQueue.sync {
            (isPaused, totalPausedDuration)
        }
    }

    /// The instant the writer's timeline has reached: the host clock minus the
    /// first video PTS and everything spent paused, i.e. the same transform every
    /// retimed sample gets, so the mixer's clock and the sample PTS are one domain.
    /// Frozen while paused (`pauseStartedAt` stops moving and the pause in progress
    /// is not yet in the offset), so a pause interrupts the audio clock without
    /// shifting anything recorded after it. `.invalid` before the first frame.
    private func timelineNow() -> CMTime {
        guard let firstPTS else { return .invalid }
        let (paused, offset, pausedAt) = stateQueue.sync {
            (isPaused, totalPausedDuration, pauseStartedAt)
        }
        let now = paused ? (pausedAt ?? CMClockGetTime(hostClock)) : CMClockGetTime(hostClock)
        return CMTimeSubtract(CMTimeSubtract(now, firstPTS), offset)
    }

    /// Called once from the video queue when the writer session opens. The mixer
    /// anchors frame 0 to source time zero (the session start) and a 10 ms timer on
    /// the audio queue keeps its cursor moving even when no source delivers.
    private func startMixedAudioTimeline() {
        guard audioMixer != nil else { return }
        audioQueue.async { [weak self] in
            guard let self, let audioMixer = self.audioMixer, self.audioTicker == nil else { return }
            audioMixer.beginTimeline(at: .zero)
            let timer = DispatchSource.makeTimerSource(queue: self.audioQueue)
            timer.schedule(
                deadline: .now() + .milliseconds(10),
                repeating: .milliseconds(10),
                leeway: .milliseconds(5)
            )
            timer.setEventHandler { [weak self] in
                self?.audioMixer?.tick()
            }
            self.audioTicker = timer
            timer.resume()
        }
    }

    /// ScreenCaptureKit `.audio` samples (48 kHz stereo Float32, non-interleaved).
    /// Same pause handling as the microphone: dropped while paused, otherwise
    /// retimed by the first video PTS plus the accumulated pause offset.
    private func appendSystemAudioSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        audioQueue.async { [weak self] in
            guard let self, let audioMixer = self.audioMixer else { return }
            guard let firstPTS = self.firstPTS else { return }

            let pauseState = self.currentPauseState()
            if pauseState.paused { return }

            let timelineOffset = CMTimeAdd(firstPTS, pauseState.offset)
            guard let retimed = self.shiftSampleBufferTiming(sampleBuffer, by: timelineOffset) else { return }
            audioMixer.ingest(retimed, from: .system)
        }
    }

    func finish() async throws -> RecordingStopSummary {
        // Capture has stopped, so nothing new reaches the audio queue; hop onto it
        // once to stop the ticker and let the mixer carry the track to the end of
        // the take and flush its tail before the input is marked finished.
        audioQueue.sync {
            audioTicker?.cancel()
            audioTicker = nil
            if let audioMixer {
                let end = timelineNow()
                audioMixer.finish(atSourceTime: end.isValid ? end : .zero)
            }
        }

        input.markAsFinished()
        audioInput?.markAsFinished()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            writer.finishWriting {
                continuation.resume()
            }
        }
        if writer.status == .failed {
            throw RecorderError.writerFailed(writer.error?.localizedDescription ?? "Unknown AVAssetWriter failure")
        }
        if writer.status != .completed {
            throw RecorderError.writerFailed("AVAssetWriter finished with status=\(writer.status.rawValue)")
        }

        let observedFrameRate = resolveObservedFrameRate()
        return RecordingStopSummary(frameCount: frameCount, observedFrameRate: observedFrameRate)
    }

    private func resolveObservedFrameRate() -> Int {
        guard frameCount > 1 else { return 0 }
        guard let lastRelativePTS else { return 0 }
        let duration = lastRelativePTS.seconds
        guard duration.isFinite, duration > 0 else {
            return 0
        }
        let intervals = max(1, frameCount - 1)
        let estimated = Double(intervals) / duration
        guard estimated.isFinite else { return 0 }
        return max(1, min(240, Int(round(estimated))))
    }

    func appendMicrophoneSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        audioQueue.async { [weak self] in
            guard let self, let audioInput else { return }
            guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
            guard let firstPTS else { return }

            let pauseState = self.currentPauseState()
            if pauseState.paused { return }

            // Shift by the first video PTS plus the accumulated pause offset so the
            // mic track stays aligned with the retimed video frames.
            let timelineOffset = CMTimeAdd(firstPTS, pauseState.offset)

            if let audioMixer = self.audioMixer {
                // Mixed track: the mixer applies the mic gain, places the samples
                // by PTS (a negative one is trimmed at frame zero) and limits the sum.
                guard let shiftedSampleBuffer = self.shiftSampleBufferTiming(sampleBuffer, by: timelineOffset) else { return }
                audioMixer.ingest(shiftedSampleBuffer, from: .microphone)
                return
            }

            guard audioInput.isReadyForMoreMediaData else { return }
            let originalPTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            let relativePTS = CMTimeSubtract(originalPTS, timelineOffset)
            guard relativePTS >= .zero else { return }

            guard let shiftedSampleBuffer = self.shiftSampleBufferTiming(sampleBuffer, by: timelineOffset) else { return }
            let processedSampleBuffer = self.applyMicrophoneGainAndLimiter(to: shiftedSampleBuffer)
            _ = audioInput.append(processedSampleBuffer)
        }
    }

    private func applyMicrophoneGainAndLimiter(to sampleBuffer: CMSampleBuffer) -> CMSampleBuffer {
        if abs(microphoneGain - 1) < 0.0001 {
            return sampleBuffer
        }

        var mutableSampleBuffer: CMSampleBuffer?
        let copyStatus = CMSampleBufferCreateCopy(
            allocator: kCFAllocatorDefault,
            sampleBuffer: sampleBuffer,
            sampleBufferOut: &mutableSampleBuffer
        )
        guard copyStatus == noErr, let mutableSampleBuffer else {
            return sampleBuffer
        }

        guard let formatDescription = CMSampleBufferGetFormatDescription(mutableSampleBuffer),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) else {
            return mutableSampleBuffer
        }
        let asbd = asbdPtr.pointee
        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let isSignedInteger = (asbd.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0
        let bitsPerChannel = Int(asbd.mBitsPerChannel)

        var blockBuffer: CMBlockBuffer?
        var audioBufferList = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(
                mNumberChannels: asbd.mChannelsPerFrame,
                mDataByteSize: 0,
                mData: nil
            )
        )

        let listStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            mutableSampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &audioBufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &blockBuffer
        )
        guard listStatus == noErr else {
            return mutableSampleBuffer
        }

        let limiterCeiling = Self.microphoneLimiterCeiling
        let audioBuffers = UnsafeMutableAudioBufferListPointer(&audioBufferList)

        for audioBuffer in audioBuffers {
            guard let data = audioBuffer.mData else { continue }

            if isFloat && bitsPerChannel == 32 {
                let sampleCount = Int(audioBuffer.mDataByteSize) / MemoryLayout<Float>.size
                let pointer = data.bindMemory(to: Float.self, capacity: sampleCount)
                for sampleIndex in 0..<sampleCount {
                    let amplified = pointer[sampleIndex] * microphoneGain
                    pointer[sampleIndex] = max(-limiterCeiling, min(limiterCeiling, amplified))
                }
                continue
            }

            if isSignedInteger && bitsPerChannel == 16 {
                let sampleCount = Int(audioBuffer.mDataByteSize) / MemoryLayout<Int16>.size
                let pointer = data.bindMemory(to: Int16.self, capacity: sampleCount)
                let maxSample = Float(Int16.max) * limiterCeiling
                for sampleIndex in 0..<sampleCount {
                    let amplified = Float(pointer[sampleIndex]) * microphoneGain
                    let limited = max(-maxSample, min(maxSample, amplified))
                    pointer[sampleIndex] = Int16(limited)
                }
            }
        }

        return mutableSampleBuffer
    }

    private func shiftSampleBufferTiming(_ sampleBuffer: CMSampleBuffer, by offset: CMTime) -> CMSampleBuffer? {
        var count = 0
        var status = CMSampleBufferGetSampleTimingInfoArray(
            sampleBuffer,
            entryCount: 0,
            arrayToFill: nil,
            entriesNeededOut: &count
        )
        guard status == noErr, count > 0 else { return nil }

        var timingInfo = Array(repeating: CMSampleTimingInfo(), count: count)
        status = CMSampleBufferGetSampleTimingInfoArray(
            sampleBuffer,
            entryCount: count,
            arrayToFill: &timingInfo,
            entriesNeededOut: &count
        )
        guard status == noErr else { return nil }

        for idx in 0..<count {
            if timingInfo[idx].presentationTimeStamp.isValid {
                timingInfo[idx].presentationTimeStamp = CMTimeSubtract(timingInfo[idx].presentationTimeStamp, offset)
            }
            if timingInfo[idx].decodeTimeStamp.isValid {
                timingInfo[idx].decodeTimeStamp = CMTimeSubtract(timingInfo[idx].decodeTimeStamp, offset)
            }
        }

        var adjustedSampleBuffer: CMSampleBuffer?
        status = CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault,
            sampleBuffer: sampleBuffer,
            sampleTimingEntryCount: count,
            sampleTimingArray: &timingInfo,
            sampleBufferOut: &adjustedSampleBuffer
        )
        guard status == noErr else { return nil }
        return adjustedSampleBuffer
    }

    private func composeFrame(screenPixelBuffer: CVPixelBuffer) -> CVPixelBuffer? {
        guard cameraProvider != nil else { return nil }
        guard let pool = adaptor.pixelBufferPool else { return nil }

        var outputBuffer: CVPixelBuffer?
        let poolResult = CVPixelBufferPoolCreatePixelBuffer(nil, pool, &outputBuffer)
        guard poolResult == kCVReturnSuccess, let outputBuffer else {
            return nil
        }

        var composed = CIImage(cvImageBuffer: screenPixelBuffer)

        if
            let cameraProvider,
            let cameraPixelBuffer = cameraProvider.copyLatestPixelBuffer(),
            let cameraImage = composeCameraImage(cameraPixelBuffer: cameraPixelBuffer)
        {
            if let overlayMaskImage {
                composed = cameraImage.applyingFilter("CIBlendWithMask", parameters: [
                    kCIInputBackgroundImageKey: composed,
                    kCIInputMaskImageKey: overlayMaskImage,
                ])
            } else {
                composed = cameraImage.composited(over: composed)
            }

            if let overlayBorderImage {
                composed = overlayBorderImage.composited(over: composed)
            }
        }

        ciContext.render(
            composed,
            to: outputBuffer,
            bounds: CGRect(x: 0, y: 0, width: videoWidth, height: videoHeight),
            colorSpace: colorSpace
        )

        return outputBuffer
    }

    private func composeCameraImage(cameraPixelBuffer: CVPixelBuffer) -> CIImage? {
        guard let overlayRect else { return nil }

        let targetRect = Self.convertToCISpace(overlayRect: overlayRect, canvasHeight: videoHeight)
        let source = CIImage(cvImageBuffer: cameraPixelBuffer)
        let sourceExtent = source.extent

        guard sourceExtent.width > 1, sourceExtent.height > 1 else {
            return nil
        }

        let sourceAspect = sourceExtent.width / sourceExtent.height
        let targetAspect = targetRect.width / targetRect.height

        var cropRect = sourceExtent
        if sourceAspect > targetAspect {
            let cropWidth = sourceExtent.height * targetAspect
            cropRect.origin.x += (sourceExtent.width - cropWidth) / 2
            cropRect.size.width = cropWidth
        } else if sourceAspect < targetAspect {
            let cropHeight = sourceExtent.width / targetAspect
            cropRect.origin.y += (sourceExtent.height - cropHeight) / 2
            cropRect.size.height = cropHeight
        }

        let cropped = source.cropped(to: cropRect)
        let normalized = cropped.transformed(by: CGAffineTransform(translationX: -cropRect.origin.x, y: -cropRect.origin.y))
        let scaled = normalized.transformed(by: CGAffineTransform(
            scaleX: targetRect.width / cropRect.width,
            y: targetRect.height / cropRect.height
        ))

        return scaled.transformed(by: CGAffineTransform(translationX: targetRect.origin.x, y: targetRect.origin.y))
    }

    private static func clamp(_ value: Int, min: Int, max: Int) -> Int {
        Swift.max(min, Swift.min(max, value))
    }

    private static func computeOverlayRect(
        canvasWidth: Int,
        canvasHeight: Int,
        shape: CameraOverlayShape,
        sizePercent: Int
    ) -> OverlayRect {
        let clampedSizePercent = clamp(sizePercent, min: 14, max: 40)
        let width = clamp(Int(round(Double(canvasWidth) * Double(clampedSizePercent) / 100.0)), min: 180, max: 560)
        let height = shape == .rounded
            ? Int(round(Double(width) * 9.0 / 16.0))
            : width
        let margin = clamp(Int(round(Double(canvasWidth) * 0.015)), min: 16, max: 36)
        let cornerRadius = shape == .rounded
            ? clamp(Int(round(Double(width) * 0.08)), min: 12, max: 26)
            : 0

        return OverlayRect(
            x: canvasWidth - width - margin,
            y: canvasHeight - height - margin,
            width: width,
            height: height,
            cornerRadius: cornerRadius
        )
    }

    private static func convertToCISpace(overlayRect: OverlayRect, canvasHeight: Int) -> CGRect {
        CGRect(
            x: CGFloat(overlayRect.x),
            y: CGFloat(canvasHeight - overlayRect.y - overlayRect.height),
            width: CGFloat(overlayRect.width),
            height: CGFloat(overlayRect.height)
        )
    }

    private static func createOverlayPath(rect: CGRect, shape: CameraOverlayShape, cornerRadius: CGFloat) -> CGPath {
        switch shape {
        case .square:
            return CGPath(rect: rect, transform: nil)
        case .circle:
            return CGPath(ellipseIn: rect, transform: nil)
        case .rounded:
            return CGPath(roundedRect: rect, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)
        }
    }

    private static func buildMaskImage(canvasWidth: Int, canvasHeight: Int, overlay: OverlayRect, shape: CameraOverlayShape) -> CIImage? {
        if shape == .square {
            return nil
        }

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(
            data: nil,
            width: canvasWidth,
            height: canvasHeight,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return nil
        }

        let rect = CGRect(x: 0, y: 0, width: canvasWidth, height: canvasHeight)
        ctx.clear(rect)
        let shapeRect = convertToCISpace(overlayRect: overlay, canvasHeight: canvasHeight)
        let path = createOverlayPath(rect: shapeRect, shape: shape, cornerRadius: CGFloat(overlay.cornerRadius))

        ctx.setShouldAntialias(true)
        ctx.addPath(path)
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fillPath()

        guard let image = ctx.makeImage() else { return nil }
        return CIImage(cgImage: image)
    }

    private static func buildBorderImage(canvasWidth: Int, canvasHeight: Int, overlay: OverlayRect, shape: CameraOverlayShape) -> CIImage? {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(
            data: nil,
            width: canvasWidth,
            height: canvasHeight,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return nil
        }

        let rect = CGRect(x: 0, y: 0, width: canvasWidth, height: canvasHeight)
        ctx.clear(rect)

        let shapeRect = convertToCISpace(overlayRect: overlay, canvasHeight: canvasHeight)
        let path = createOverlayPath(rect: shapeRect, shape: shape, cornerRadius: CGFloat(overlay.cornerRadius))

        ctx.setShouldAntialias(true)
        ctx.addPath(path)
        ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.45))
        ctx.setLineWidth(2)
        ctx.strokePath()

        guard let image = ctx.makeImage() else { return nil }
        return CIImage(cgImage: image)
    }
}

@available(macOS 13.0, *)
final class SCKRecorder {
    private let args: RecorderArguments
    private var stream: SCStream?
    private var writer: ScreenStreamWriter?
    private var cameraProvider: CameraCaptureProvider?
    private var microphoneProvider: MicrophoneCaptureProvider?
    private let permissionGuidance = "Allow Capturia in System Settings > Privacy & Security > Screen Recording, then relaunch the app."
    private let microphonePermissionGuidance = "Allow Capturia in System Settings > Privacy & Security > Microphone, then relaunch the app."

    init(args: RecorderArguments) {
        self.args = args
    }

    @MainActor
    func start() async throws -> (width: Int, height: Int, sourceKind: String, hasMicrophoneAudio: Bool, hasSystemAudio: Bool) {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            throw mapShareableContentError(error)
        }
        let resolved = try resolveSource(from: content)

        let outputURL = URL(fileURLWithPath: args.outputPath)
        try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)

        var cameraProvider: CameraCaptureProvider?
        if args.cameraEnabled {
            let provider = CameraCaptureProvider(
                preferredDeviceId: args.cameraDeviceId,
                preferredDeviceName: args.cameraDeviceName
            )
            do {
                try provider.start()
                cameraProvider = provider
            } catch {
                throw RecorderError.cameraUnavailable(String(describing: error))
            }
        }

        let writer: ScreenStreamWriter
        do {
            writer = try ScreenStreamWriter(
                outputURL: outputURL,
                width: resolved.width,
                height: resolved.height,
                fps: args.fps,
                bitrateScale: args.bitrateScale,
                microphoneEnabled: args.microphoneEnabled,
                microphoneGain: args.microphoneGain,
                systemAudioEnabled: args.systemAudioEnabled,
                cameraProvider: cameraProvider,
                cameraShape: args.cameraShape,
                cameraSizePercent: args.cameraSizePercent
            )
        } catch {
            cameraProvider?.stop()
            throw error
        }

        var microphoneProvider: MicrophoneCaptureProvider?
        if args.microphoneEnabled {
            try await ensureMicrophonePermission()
            let provider = MicrophoneCaptureProvider(
                preferredDeviceId: args.microphoneDeviceId,
                preferredDeviceName: args.microphoneDeviceName
            )
            do {
                // 48 kHz when the mic joins the mixed track so nothing is resampled.
                let microphoneSampleRate = args.systemAudioEnabled ? 48_000 : 44_100
                try provider.start(sampleRate: microphoneSampleRate) { sampleBuffer in
                    writer.appendMicrophoneSampleBuffer(sampleBuffer)
                }
                microphoneProvider = provider
            } catch {
                cameraProvider?.stop()
                throw RecorderError.microphoneUnavailable(String(describing: error))
            }
            if provider.preferredDeviceMissing {
                // Not fatal: the recording goes on with the default microphone and
                // the Electron side turns this line into a toast.
                let requested = args.microphoneDeviceName ?? args.microphoneDeviceId ?? ""
                print("SCK_RECORDER_WARN mic_device_not_found requested=\(requested) opened=\(provider.openedDeviceName ?? "")")
                fflush(stdout)
            }
        }

        let config = SCStreamConfiguration()
        config.width = resolved.width
        config.height = resolved.height
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(args.fps))
        config.queueDepth = 6
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = !args.hideCursor
        config.capturesAudio = args.systemAudioEnabled
        if args.systemAudioEnabled {
            config.sampleRate = 48_000
            config.channelCount = 2
            // Capturia's own sounds (countdown, UI) must not end up in the track.
            config.excludesCurrentProcessAudio = true
        }

        let stream = SCStream(filter: resolved.filter, configuration: config, delegate: nil)

        do {
            try stream.addStreamOutput(writer, type: .screen, sampleHandlerQueue: DispatchQueue(label: "com.capturia.sck-recorder.video"))
            if args.systemAudioEnabled {
                try stream.addStreamOutput(writer, type: .audio, sampleHandlerQueue: DispatchQueue(label: "com.capturia.sck-recorder.system-audio"))
            }
            try await stream.startCapture()
        } catch {
            cameraProvider?.stop()
            microphoneProvider?.stop()
            throw mapStreamStartError(error, sourceKind: resolved.sourceKind)
        }

        self.writer = writer
        self.stream = stream
        self.cameraProvider = cameraProvider
        self.microphoneProvider = microphoneProvider

        return (
            width: resolved.width,
            height: resolved.height,
            sourceKind: resolved.sourceKind,
            hasMicrophoneAudio: writer.hasMicrophoneAudio,
            hasSystemAudio: writer.hasSystemAudio
        )
    }

    /// Thread-safe: called from the stdin reader thread. False when no writer exists yet.
    func pause() -> Bool {
        writer?.pause() ?? false
    }

    func resume() -> Bool {
        writer?.resume() ?? false
    }

    func stop() async throws -> RecordingStopSummary {
        guard let stream, let writer else {
            throw RecorderError.streamNotStarted
        }

        defer {
            cameraProvider?.stop()
            cameraProvider = nil
            microphoneProvider?.stop()
            microphoneProvider = nil
        }

        try await stream.stopCapture()
        return try await writer.finish()
    }

    private func resolveSource(from content: SCShareableContent) throws -> (filter: SCContentFilter, width: Int, height: Int, sourceKind: String) {
        if let sourceId = args.sourceId, sourceId.hasPrefix("window:"),
           let numericPart = sourceId.split(separator: ":").dropFirst().first,
           let windowId = UInt32(numericPart) {
            guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
                throw RecorderError.windowNotFound("The selected window is no longer on-screen (it may be minimized, closed, or moved to another Space).")
            }
            let defaultSize = resolveWindowCaptureSize(window: window, displays: content.displays)
            let width = max(2, forceEven(args.targetWidth ?? defaultSize.width))
            let height = max(2, forceEven(args.targetHeight ?? defaultSize.height))
            return (
                filter: SCContentFilter(desktopIndependentWindow: window),
                width: width,
                height: height,
                sourceKind: "window"
            )
        }

        let display: SCDisplay
        if let displayIdRaw = args.displayId,
           let displayId = UInt32(displayIdRaw),
           let match = content.displays.first(where: { $0.displayID == displayId }) {
            display = match
        } else if let fallback = content.displays.first {
            display = fallback
        } else {
            throw RecorderError.sourceNotFound("No display available")
        }

        let width = max(2, forceEven(args.targetWidth ?? display.width))
        let height = max(2, forceEven(args.targetHeight ?? display.height))

        return (
            filter: displayContentFilter(display: display, content: content),
            width: width,
            height: height,
            sourceKind: "display"
        )
    }

    /// D1: a display filter that leaves the excluded application's windows out
    /// of the capture, so Capturia's own HUD, countdown overlay and source
    /// selector never appear in the recording.
    ///
    /// Without `--exclude-pid` (and whenever the pid cannot be resolved to a
    /// running application that ScreenCaptureKit is currently sharing) this is
    /// exactly the filter the helper has always built, so the default
    /// behaviour is unchanged.
    private func displayContentFilter(display: SCDisplay, content: SCShareableContent) -> SCContentFilter {
        let unfiltered = SCContentFilter(display: display, excludingWindows: [])
        guard let excludePid = args.excludePid else { return unfiltered }
        guard let runningApp = NSRunningApplication(processIdentifier: excludePid) else {
            print("SCK_RECORDER_WARN hud_exclude_unavailable pid=\(excludePid) reason=not_running")
            return unfiltered
        }
        // `content.applications` is what ScreenCaptureKit is willing to filter
        // on; an app missing from it cannot be excluded, and matching by bundle
        // identifier would exclude *every* instance rather than this one.
        let matching = content.applications.filter { $0.processID == runningApp.processIdentifier }
        guard !matching.isEmpty else {
            print("SCK_RECORDER_WARN hud_exclude_unavailable pid=\(excludePid) reason=not_shareable")
            return unfiltered
        }
        print("[sck-recorder] excluding \(matching.count) application entry/entries for pid \(excludePid) from the capture")
        return SCContentFilter(
            display: display,
            excludingApplications: matching,
            exceptingWindows: []
        )
    }

    private func mapStreamStartError(_ error: Error, sourceKind: String) -> RecorderError {
        let nsError = error as NSError
        let localized = nsError.localizedDescription

        if looksLikePermissionError(nsError) {
            return .permissionDenied(permissionGuidance)
        }

        if sourceKind == "window" {
            let normalized = localized.lowercased()
            if normalized.contains("protected")
                || normalized.contains("not shar")
                || normalized.contains("cannot be captured")
                || normalized.contains("secure")
            {
                return .windowCaptureDenied("macOS marked this window as protected content and blocked capture.")
            }
            return .windowCaptureDenied("The selected window failed to start capture. Keep the window visible and try again. (domain: \(nsError.domain), code: \(nsError.code))")
        }

        return .streamStartFailed("\(localized) (domain: \(nsError.domain), code: \(nsError.code))")
    }

    private func mapShareableContentError(_ error: Error) -> RecorderError {
        let nsError = error as NSError
        let localized = nsError.localizedDescription

        if looksLikePermissionError(nsError) {
            return .permissionDenied(permissionGuidance)
        }

        return .streamStartFailed("Failed to enumerate shareable content: \(localized) (domain: \(nsError.domain), code: \(nsError.code))")
    }

    private func looksLikePermissionError(_ error: NSError) -> Bool {
        let normalized = error.localizedDescription.lowercased()
        let tokens = [
            "permission",
            "not authorized",
            "denied",
            "not permitted",
            "unauthorized",
            "没有权限",
            "無權限",
            "无权限",
            "未授权",
            "未授權",
            "拒绝",
            "拒絕",
            "不允许",
            "不允許",
            "屏幕录制",
            "螢幕錄製",
            "screen recording",
        ]
        if tokens.contains(where: { normalized.contains($0.lowercased()) }) {
            return true
        }

        // ScreenCaptureKit and TCC failures may report localized text; preserve a
        // domain/code fallback so permission failures don't get misclassified.
        return error.domain.lowercased().contains("tcc")
    }

    private func resolveWindowCaptureSize(window: SCWindow, displays: [SCDisplay]) -> (width: Int, height: Int) {
        let windowFrame = window.frame
        var scale = 1.0

        let frameCenter = CGPoint(x: windowFrame.midX, y: windowFrame.midY)
        if let display = displays.first(where: { $0.frame.contains(frameCenter) })
            ?? displays.first(where: { $0.frame.intersects(windowFrame) }) {
            let displayFrame = display.frame
            if displayFrame.width > 0, displayFrame.height > 0 {
                let scaleX = Double(display.width) / Double(displayFrame.width)
                let scaleY = Double(display.height) / Double(displayFrame.height)
                scale = max(1.0, (scaleX + scaleY) / 2.0)
            }
        }

        let width = max(2, forceEven(Int(round(Double(windowFrame.width) * scale))))
        let height = max(2, forceEven(Int(round(Double(windowFrame.height) * scale))))
        return (width: width, height: height)
    }

    private func ensureMicrophonePermission() async throws {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        switch status {
        case .authorized:
            return
        case .notDetermined:
            let granted = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                AVCaptureDevice.requestAccess(for: .audio) { approved in
                    continuation.resume(returning: approved)
                }
            }
            if !granted {
                throw RecorderError.microphonePermissionDenied(microphonePermissionGuidance)
            }
        case .denied, .restricted:
            throw RecorderError.microphonePermissionDenied(microphonePermissionGuidance)
        @unknown default:
            throw RecorderError.microphonePermissionDenied(microphonePermissionGuidance)
        }
    }

    private func forceEven(_ value: Int) -> Int {
        value % 2 == 0 ? value : value - 1
    }
}

@main
struct NativeRecorderMain {
    /// This helper is a plain command-line process, so nothing has connected it to
    /// the window server when it starts. `SCContentFilter(desktopIndependentWindow:)`
    /// asks the window server which display a window sits on, and on recent macOS
    /// releases that call aborts the process (`CGS_REQUIRE_INIT`) when CoreGraphics
    /// was never initialised first. Display capture never resolves a rect and was
    /// unaffected, which is why only window recordings crashed. Touching any
    /// CoreGraphics display API performs the initialisation; it must run before
    /// anything else, including argument parsing errors that never reach a filter.
    private static func initializeCoreGraphicsWindowServerConnection() {
        _ = CGMainDisplayID()
    }

    @MainActor
    private static func initializeWindowCaptureRuntime() {
        // Window-targeted SCContentFilter paths depend on an initialized CGS/AppKit runtime.
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
    }

    static func main() async {
        initializeCoreGraphicsWindowServerConnection()

        do {
            let args = try RecorderArguments.parse(from: CommandLine.arguments)
            guard #available(macOS 13.0, *) else {
                throw RecorderError.invalidArguments("ScreenCaptureKit recorder requires macOS 13.0+")
            }

            await MainActor.run {
                initializeWindowCaptureRuntime()
            }

            let recorder = SCKRecorder(args: args)
            let info = try await recorder.start()

            print("SCK_RECORDER_READY width=\(info.width) height=\(info.height) fps=\(args.fps) source=\(info.sourceKind) mic=\(info.hasMicrophoneAudio ? 1 : 0) system_audio=\(info.hasSystemAudio ? 1 : 0)")
            // Capability line: lets the Electron side detect a helper built without
            // the stdin protocol (an old binary never prints it -> pause unsupported).
            print("SCK_RECORDER_CAPS pause mic-device system-audio")
            fflush(stdout)

            let stopSignal = StopSignal()

            // stdin command loop: `pause`, `resume`, `stop`.
            // Runs on a plain Thread because readLine() blocks. When stdin is closed
            // or was never a pipe, readLine() returns nil at once and the thread ends;
            // SIGINT/SIGTERM keep working as the stop path either way.
            let commandReader = Thread {
                while let line = readLine() {
                    let command = line.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                    switch command {
                    case "pause":
                        if recorder.pause() {
                            print("SCK_RECORDER_PAUSED")
                            fflush(stdout)
                        }
                    case "resume":
                        if recorder.resume() {
                            print("SCK_RECORDER_RESUMED")
                            fflush(stdout)
                        }
                    case "stop":
                        stopSignal.trigger()
                        return
                    default:
                        break
                    }
                }
            }
            commandReader.name = "com.capturia.sck-recorder.stdin"
            commandReader.start()

            await stopSignal.wait()
            // A stop while paused must not lose the pause offset bookkeeping; the
            // writer simply finishes with the samples it has.

            let summary = try await recorder.stop()
            print("SCK_RECORDER_DONE frames=\(summary.frameCount) observed_fps=\(summary.observedFrameRate)")
            fflush(stdout)
            exit(0)
        } catch {
            if let recorderError = error as? RecorderError {
                fputs("SCK_RECORDER_ERROR code=\(recorderError.code) message=\(recorderError)\n", stderr)
            } else {
                fputs("SCK_RECORDER_ERROR code=unknown message=\(error)\n", stderr)
            }
            fflush(stderr)
            exit(1)
        }
    }
}
