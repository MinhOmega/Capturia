#!/usr/bin/env node
/**
 * One-off migration: split Capturia's flat i18n dictionaries (the `messages`
 * table in the legacy `src/i18n/index.tsx`) into upstream-style namespaced
 * JSON files under `src/i18n/locales/<locale>/<namespace>.json`.
 *
 * What it does, deterministically:
 *   1. Reads the legacy en + zh-CN flat maps.
 *   2. Adds the handful of strings that only lived in the Electron main
 *      process (`NEW_KEYS`) so `electron/i18n.ts` can use the same files.
 *   3. Renames key prefixes that are not a namespace (`PREFIX_MAP`), keeping
 *      every leaf name unchanged, e.g. `annotation.size` -> `settings.annotation.size`.
 *   4. Nests keys into JSON objects. When a key is both a leaf and a branch
 *      (`launch.shape` + `launch.shape.rounded`) the descendants stay as dotted
 *      keys next to the leaf; the loader resolves both shapes.
 *   5. Writes `vi` in full: upstream's vi value where a semantic twin exists
 *      (`UPSTREAM_TWINS`, matched on the en string, not on key names) and the
 *      hand-written `VI_OVERRIDES` for Capturia-only keys.
 *   6. Writes the other upstream locales with ONLY the twin keys (missing keys
 *      fall back to en at runtime).
 *
 * Usage:
 *   node scripts/i18n-migrate-flat.mjs \
 *     --legacy src/i18n/index.tsx \
 *     --v17 /tmp/openscreen-v1.7.0/src/i18n/locales \
 *     --v110 /tmp/openscreen-upstream/src/i18n/locales
 */
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
	process.argv
		.slice(2)
		.map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null))
		.filter(Boolean),
);
const LEGACY = args.legacy ?? "src/i18n/index.tsx";
const V17 = args.v17 ?? "/tmp/openscreen-v1.7.0/src/i18n/locales";
const V110 = args.v110 ?? "/tmp/openscreen-upstream/src/i18n/locales";
const OUT = path.resolve("src/i18n/locales");

const NAMESPACES = ["common", "dialogs", "editor", "launch", "settings", "shortcuts", "timeline"];
const PARTIAL_LOCALES = ["ar", "es", "fr", "it", "ja-JP", "ko-KR", "pt-BR", "ru", "tr", "zh-TW"];

/** legacy prefix -> [namespace, sub-prefix inside the namespace file] */
const PREFIX_MAP = {
	common: ["common", null],
	launch: ["launch", null],
	editor: ["editor", null],
	settings: ["settings", null],
	timeline: ["timeline", null],
	app: ["common", "app"],
	error: ["common", "error"],
	playback: ["common", "playback"],
	electron: ["common", "electron"],
	shortcut: ["shortcuts", null],
	annotation: ["settings", "annotation"],
	font: ["settings", "font"],
	source: ["launch", "source"],
	permission: ["launch", "permission"],
	export: ["dialogs", "export"],
	tutorial: ["dialogs", "tutorial"],
	format: ["dialogs", "format"],
	gif: ["dialogs", "gif"],
};

/**
 * Strings that only existed as inline dictionaries in electron/main.ts and
 * electron/ipc/handlers.ts, plus upstream's locale self-name keys used by
 * getLocaleName(). Keys are legacy-style (pre-rename).
 */
const NEW_KEYS = {
	en: {
		"common.locale.name": "English",
		"common.locale.short": "EN",
		"electron.chooseExportFolder": "Choose Export Folder",
		"electron.exportPathRejected": "Export destination must be chosen through the save dialog",
		"electron.unsupportedVideoFile": "Selected file is not a supported video file",
		"electron.runtimeError.message":
			"Capturia hit an internal error. Please report this issue so we can fix it.",
		"electron.runtimeError.detailPrefix": "Reference",
		"electron.runtimeError.report": "Report Bug",
		"electron.runtimeError.close": "Close",
	},
	"zh-CN": {
		"common.locale.name": "简体中文",
		"common.locale.short": "简中",
		"electron.chooseExportFolder": "选择导出文件夹",
		"electron.exportPathRejected": "导出位置必须通过保存对话框选择",
		"electron.unsupportedVideoFile": "所选文件不是受支持的视频文件",
		"electron.runtimeError.message": "程序发生了内部错误，建议反馈问题以便排查。",
		"electron.runtimeError.detailPrefix": "错误编号",
		"electron.runtimeError.report": "反馈问题",
		"electron.runtimeError.close": "关闭",
	},
};

/**
 * Capturia legacy key -> upstream key whose en string means the same thing.
 * Matched by reading the en strings side by side. Entry forms:
 *   "up.key"                                 exact (normalised) en match required
 *   { up, loose: true }                      wording differs slightly; accepted by hand
 *   { up, vars: { upstreamVar: capturiaVar } } placeholder rename
 * The script refuses non-loose entries whose en strings do not match, and any
 * entry whose placeholders do not line up after renaming.
 */
const UPSTREAM_TWINS = {
	// common
	"common.cancel": "common.actions.cancel",
	"common.close": "common.actions.close",
	"common.done": "common.actions.done",
	"common.loading": "editor.rec.loading",
	"common.processing": "dialogs.export.processing",
	"common.status": "dialogs.export.status",
	"common.format": "dialogs.export.format",
	"common.frames": "dialogs.export.frames",
	"common.loop": "editor.transport.loop",
	"common.language": "launch.language",
	"common.apply": "editor.editClipDialog.apply",
	"common.locale.name": "common.locale.name",
	"common.locale.short": "common.locale.short",
	"playback.play": "common.playback.play",
	"playback.pause": "common.playback.pause",
	"playback.fullscreen": "common.playback.fullscreen",
	"playback.exitFullscreen": "common.playback.exitFullscreen",
	"electron.tray.recording": "common.actions.recordingStatus",
	"electron.tray.stopRecording": "common.actions.stopRecording",
	"electron.tray.open": "common.actions.open",
	"electron.tray.quit": "common.actions.quit",
	"electron.saveGif": "dialogs.fileDialogs.saveGif",
	"electron.saveVideo": "dialogs.fileDialogs.saveVideo",
	"electron.exportCancelled": { up: "editor.export.canceled", loose: true },
	"electron.exportSaveFailed": "editor.errors.failedToSaveExportedVideo",
	"electron.selectVideoFile": "dialogs.fileDialogs.selectVideo",
	"electron.videoFiles": "dialogs.fileDialogs.videoFiles",
	"electron.allFiles": "dialogs.fileDialogs.allFiles",
	// launch
	"launch.sourceFallback": "launch.sourceSelector.defaultSourceName",
	"launch.stopRecording": "common.actions.stopRecording",
	"launch.pauseRecording": "launch.tooltips.pauseRecording",
	"launch.resumeRecording": "launch.tooltips.resumeRecording",
	"launch.open": "common.actions.open",
	"launch.camera": "launch.webcam.camera",
	"launch.shape.rounded": "settings.layout.shapes.rounded",
	"launch.shape.square": "settings.layout.shapes.square",
	"launch.shape.circle": "settings.layout.shapes.circle",
	"launch.captureFrameRate": "editor.exportDialog.frameRate",
	"launch.stopShortcutReset": "editor.editClipDialog.reset",
	"launch.hideHud": "launch.tooltips.hideHUD",
	"launch.closeApp": "launch.tooltips.closeApp",
	"source.loading": "launch.sourceSelector.loading",
	"source.cancel": "common.actions.cancel",
	"source.share": "common.actions.share",
	"permission.rowScreenCaptureTitle": "editor.newProjectDialog.templates.screenRecordingTitle",
	"permission.rowCameraTitle": "launch.webcam.camera",
	"permission.rowMicrophoneTitle": "launch.audio.microphone",
	// editor
	"editor.loadingVideo": "editor.loadingVideo",
	"editor.videoNotReady": "editor.errors.videoNotReady",
	"editor.noVideoLoaded": "editor.errors.noVideoLoaded",
	"editor.saveGifFailed": "editor.errors.failedToSaveGif",
	"editor.saveVideoFailed": "editor.errors.failedToSaveVideo",
	"editor.gifExportFailed": "editor.errors.gifExportFailed",
	"editor.exportFailed": "editor.errors.exportFailed",
	"editor.exportCancelled": { up: "editor.export.canceled", loose: true },
	"editor.exportError": { up: "editor.errors.exportFailedWithError", vars: { error: "message" } },
	// settings
	"settings.zoomLevel": "settings.zoom.level",
	"settings.selectZoomToAdjust": "settings.zoom.selectRegion",
	"settings.deleteZoom": "settings.zoom.deleteZoom",
	"settings.deleteTrim": "settings.trim.deleteRegion",
	"settings.videoEffects": "settings.effects.title",
	"settings.motionBlur": "settings.effects.motionBlur",
	"settings.blurBg": "settings.effects.blurBg",
	"settings.cursorSmoothing": "settings.cursor.smoothing",
	"settings.cursorMovementDefault": "settings.cursor.themeDefault",
	"settings.cursorMovementCustom": "settings.background.custom",
	"settings.shadow": "settings.effects.shadow",
	"settings.roundness": "settings.effects.roundness",
	"settings.padding": "settings.effects.padding",
	"settings.cropVideo": "settings.crop.cropVideo",
	"settings.background": "settings.background.title",
	"settings.backgroundImage": "settings.background.image",
	"settings.backgroundColor": "settings.background.color",
	"settings.backgroundGradient": "settings.background.gradient",
	"settings.uploadCustom": "settings.background.uploadCustom",
	"settings.cropDialogTitle": "settings.crop.cropVideo",
	"settings.cropDialogDesc": "settings.crop.dragInstruction",
	"settings.reportBug": "settings.support.reportBug",
	"settings.starGithub": "settings.support.starOnGithub",
	"settings.fileTypeInvalid": "settings.imageUpload.invalidFileType",
	"settings.uploadOk": "settings.imageUpload.uploadSuccess",
	"settings.uploadFailed": "settings.imageUpload.failedToUpload",
	"settings.uploadReadError": "settings.imageUpload.errorReading",
	"settings.uploadJpgOnly": { up: "settings.imageUpload.jpgOnly", loose: true },
	// dialogs: export / format / gif / tutorial
	"export.title": "dialogs.export.exportingFormat",
	"export.titleCompilingGif": "dialogs.export.compilingGif",
	"export.titleFinalizingVideo": "dialogs.export.finalizingVideoTitle",
	"export.titleFailed": "dialogs.export.failed",
	"export.statusTryAgain": "dialogs.export.tryAgain",
	"export.statusMoment": "dialogs.export.takeMoment",
	"export.statusCompiling": "dialogs.export.compilingGifWait",
	"export.statusCompilingPct": "dialogs.export.compilingGifProgress",
	"export.phaseCompiling": "dialogs.export.compiling",
	"export.phaseFinalizing": { up: "dialogs.export.finalizing", loose: true },
	"export.phaseRendering": "dialogs.export.renderingFrames",
	"export.complete": "dialogs.export.complete",
	"export.ready": "dialogs.export.yourFormatReady",
	"export.cancelExport": "dialogs.export.cancelExport",
	"export.saved": "dialogs.export.savedSuccessfully",
	"export.showInFolder": "dialogs.export.showInFolder",
	"format.mp4.label": "settings.exportFormat.mp4Video",
	"format.mp4.desc": "settings.exportFormat.mp4Description",
	"format.gif.label": "settings.exportFormat.gifAnimation",
	"format.gif.desc": "settings.exportFormat.gifDescription",
	"gif.frameRate": "editor.exportDialog.frameRate",
	"tutorial.trigger": "dialogs.tutorial.triggerLabel",
	"tutorial.title": "dialogs.tutorial.title",
	"tutorial.desc": "dialogs.tutorial.description",
	"tutorial.visualExample": "dialogs.tutorial.visualExample",
	"tutorial.removed": "dialogs.tutorial.removed",
	"tutorial.kept": "dialogs.tutorial.kept",
	"tutorial.finalVideo": "dialogs.tutorial.finalVideo",
	"tutorial.step1": "dialogs.tutorial.step1Title",
	"tutorial.step2": "dialogs.tutorial.step2Title",
	"tutorial.step2desc": "dialogs.tutorial.step2Description",
	// shortcuts
	"shortcut.title": "shortcuts.title",
	"shortcut.addZoom": "shortcuts.actions.addZoom",
	"shortcut.addAnnotation": "shortcuts.actions.addAnnotation",
	"shortcut.addKeyframe": "shortcuts.actions.addKeyframe",
	"shortcut.addTrim": "shortcuts.actions.addTrim",
	"shortcut.deleteSelected": "shortcuts.actions.deleteSelected",
	"shortcut.playPause": { up: "shortcuts.actions.playPause", loose: true },
	"shortcut.panTimeline": "shortcuts.fixedActions.panTimeline",
	"shortcut.zoomTimeline": "shortcuts.fixedActions.zoomTimeline",
	"shortcut.copySelected": "shortcuts.actions.copySelected",
	"shortcut.paste": "shortcuts.actions.paste",
	"shortcut.fullscreen": "common.playback.fullscreen",
	"shortcut.undo": "shortcuts.fixedActions.undo",
	"shortcut.redo": "shortcuts.fixedActions.redo",
	"shortcut.customize": "shortcuts.customize",
	"shortcut.configTitle": "shortcuts.title",
	"shortcut.configurable": "shortcuts.configurable",
	"shortcut.fixed": "shortcuts.fixed",
	"shortcut.pressKey": "shortcuts.pressKey",
	"shortcut.resetDefaults": "shortcuts.resetToDefaults",
	"shortcut.swap": "shortcuts.swap",
	"shortcut.saved": { up: "shortcuts.savedToast", loose: true },
	"shortcut.resetHint": { up: "shortcuts.resetToast", loose: true },
	"shortcut.conflictFixed": { up: "shortcuts.reservedShortcut", loose: true },
	"shortcut.conflictWith": { up: "shortcuts.alreadyUsedBy", loose: true, vars: { action: "label" } },
	"shortcut.instructions": { up: "shortcuts.helpText", loose: true },
	// settings.annotation
	"annotation.settings": "settings.annotation.title",
	"annotation.active": "settings.annotation.active",
	"annotation.tab.text": "settings.annotation.typeText",
	"annotation.tab.image": "settings.annotation.typeImage",
	"annotation.tab.figure": "settings.annotation.typeArrow",
	"annotation.textContent": "settings.annotation.textContent",
	"annotation.enterText": "settings.annotation.textPlaceholder",
	"annotation.fontStyle": "settings.annotation.fontStyle",
	"annotation.size": "settings.annotation.size",
	"annotation.selectStyle": "settings.annotation.selectStyle",
	"annotation.background": "settings.annotation.background",
	"annotation.none": "settings.annotation.none",
	"annotation.color": "settings.annotation.color",
	"annotation.clearBackground": "settings.annotation.clearBackground",
	"annotation.uploadImage": "settings.annotation.uploadImage",
	"annotation.supportedFormats": "settings.annotation.supportedFormats",
	"annotation.arrowDirection": "settings.annotation.arrowDirection",
	"annotation.arrowColor": "settings.annotation.arrowColor",
	"annotation.textColor": "settings.annotation.textColor",
	"annotation.strokeWidth": { up: "settings.annotation.strokeWidth", vars: { width: "value" } },
	"annotation.delete": "settings.annotation.deleteAnnotation",
	"annotation.shortcutTips": "settings.annotation.shortcutsAndTips",
	"annotation.tip1": "settings.annotation.tipMovePlayhead",
	"annotation.tip2": "settings.annotation.tipTabCycle",
	"annotation.tip3": "settings.annotation.tipShiftTabCycle",
	"annotation.invalidType": "settings.annotation.invalidImageType",
	"annotation.allowedTypes": "settings.annotation.imageFormatsOnly",
	"annotation.imageUploadOk": "settings.annotation.imageUploadSuccess",
	// settings.font
	"font.addGoogle": "settings.customFont.dialogTitle",
	"font.dialogTitle": "settings.customFont.dialogTitle",
	"font.importUrl": "settings.customFont.urlLabel",
	"font.importPlaceholder": "settings.customFont.urlPlaceholder",
	"font.importHint": { up: "settings.customFont.urlHelp", loose: true },
	"font.displayName": "settings.customFont.nameLabel",
	"font.displayHint": "settings.customFont.nameHelp",
	"font.namePlaceholder": "settings.customFont.namePlaceholder",
	"font.customFonts": "settings.annotation.customFonts",
	"font.adding": "settings.customFont.addingButton",
	"font.add": "settings.customFont.addButton",
	"font.error.enterUrl": "settings.customFont.errorEmptyUrl",
	"font.error.invalidUrl": "settings.customFont.errorInvalidUrl",
	"font.error.enterName": "settings.customFont.errorEmptyName",
	"font.error.extract": "settings.customFont.errorExtractFailed",
	"font.added": { up: "settings.customFont.successMessage", vars: { fontName: "name" } },
	"font.failed": "settings.customFont.failedToAdd",
	"font.failed.timeout": "settings.customFont.errorTimeout",
	"font.failed.generic": "settings.customFont.errorLoadFailed",
	// timeline
	"timeline.noVideoLoaded": "timeline.emptyState.noVideo",
	"timeline.dragDropToStart": "timeline.emptyState.dragAndDrop",
	"timeline.cannotPlaceZoom": "timeline.errors.cannotPlaceZoom",
	"timeline.cannotPlaceZoomDesc": "timeline.errors.zoomExistsAtLocation",
	"timeline.cannotPlaceTrim": "timeline.errors.cannotPlaceTrim",
	"timeline.cannotPlaceTrimDesc": "timeline.errors.trimExistsAtLocation",
	"timeline.zoom": "timeline.labels.zoom",
	"timeline.trim": "timeline.labels.trim",
	"timeline.annotation": "timeline.labels.annotationItem",
	"timeline.audio": "settings.audio.title",
	"timeline.image": "timeline.labels.imageItem",
	"timeline.emptyText": "timeline.labels.emptyText",
	"timeline.pan": "timeline.labels.pan",
	"timeline.zoomAction": "timeline.labels.zoom",
	"timeline.addZoom": "timeline.buttons.addZoom",
	"timeline.addTrim": "timeline.buttons.addTrim",
	"timeline.addAnnotation": "timeline.buttons.addAnnotation",
};

/** Vietnamese for Capturia-only keys (legacy key names). */
const VI_OVERRIDES = {
	"app.name": "Capturia",
	"app.fallbackTitle": "Capturia",
	"common.english": "English",
	"common.chinese": "简体中文",
	"error.unexpected": "Đã xảy ra lỗi. Vui lòng thử lại.",
	"error.reference": "Mã tham chiếu: {{id}}",
	"error.reportAction": "Báo lỗi",
	"error.reportOpenFailed": "Không thể mở trang báo lỗi.",
	"launch.record": "Ghi hình",
	"launch.discardRecording": "Hủy bản ghi",
	"launch.cameraEnabled": "Đã bật lớp phủ camera",
	"launch.cameraEnable": "Bật lớp phủ camera",
	"launch.shape": "Hình dạng",
	"launch.cameraShapeLabel": "Hình dạng camera: {{shape}}",
	"launch.sizeDecrease": "Giảm kích thước camera",
	"launch.sizeIncrease": "Tăng kích thước camera",
	"launch.captureProfile.balanced": "Mượt 30",
	"launch.captureProfile.quality": "Sắc nét 60",
	"launch.captureProfile.ultra": "Ultra 120",
	"launch.captureProfileLabel": "Cấu hình ghi hình: {{profile}}",
	"launch.captureSettingsTitle": "Cài đặt ghi hình",
	"launch.captureMode.standard": "Tiêu chuẩn",
	"launch.captureMode.pro": "Pro",
	"launch.captureProfileHint": "Cấu hình sẵn gộp tốc độ khung hình và độ phân giải lại với nhau.",
	"launch.captureProHint": "Chế độ Pro cho phép điều chỉnh tốc độ khung hình và độ phân giải độc lập.",
	"launch.captureResolution": "Độ phân giải",
	"launch.captureResolution.auto": "Tự động (gốc)",
	"launch.captureResolution.1080p": "1080p",
	"launch.captureResolution.1440p": "1440p",
	"launch.captureResolution.2160p": "2160p",
	"launch.captureProLabel": "Ghi hình Pro: {{resolution}} / {{fps}}fps",
	"launch.captureProButtonLabel": "Pro {{resolution}}/{{fps}}",
	"launch.countdownNone": "Không đếm ngược",
	"launch.countdownLabel": "Đếm ngược trước khi ghi: {{seconds}}s",
	"launch.countdownStarting": "{{seconds}}s",
	"launch.countdownCancelHint": "Bắt đầu sau {{seconds}}s. Nhấn để hủy.",
	"launch.autoHideHudOnRecord": "Tự động ẩn",
	"launch.autoHideHudOnRecordOn": "Tự động ẩn thanh điều khiển sau khi bắt đầu ghi",
	"launch.autoHideHudOnRecordOff": "Giữ thanh điều khiển hiển thị sau khi bắt đầu ghi",
	"launch.stopShortcutLabel": "Phím tắt dừng ghi: {{shortcut}}",
	"launch.stopShortcutConfigTitle": "Phím tắt dừng ghi",
	"launch.stopShortcutCurrent": "Hiện tại: {{shortcut}}",
	"launch.stopShortcutSet": "Đặt phím tắt",
	"launch.stopShortcutHint":
		"Nhấn tổ hợp phím có ít nhất một phím bổ trợ (Cmd/Ctrl/Alt/Shift). Esc để hủy.",
	"launch.stopShortcutListening": "Đang chờ... nhấn phím tắt mới",
	"launch.stopShortcutUpdated": "Đã cập nhật phím tắt dừng ghi: {{shortcut}}",
	"launch.stopShortcutResetOk": "Đã đặt lại phím tắt dừng ghi: {{shortcut}}",
	"launch.stopShortcutApplyError": "Không thể áp dụng phím tắt dừng ghi",
	"launch.permissions": "Quyền truy cập",
	"launch.recordSourceRequired": "Vui lòng chọn nguồn trước khi ghi hình.",
	"launch.recordStartFailed": "Không thể bắt đầu ghi hình.",
	"launch.recordStopFailed": "Không thể dừng ghi hình một cách an toàn.",
	"launch.recordSaveFailed": "Không thể lưu bản ghi.",
	"launch.openVideoFailed": "Không thể mở tệp video.",
	"launch.openSourceSelectorFailed": "Không thể mở trình chọn nguồn.",
	"launch.sourceStatusSyncFailed": "Không thể làm mới trạng thái nguồn đã chọn.",
	"launch.systemCursor": "Con trỏ hệ thống",
	"launch.systemCursorOn": "Bật con trỏ",
	"launch.systemCursorOff": "Tắt con trỏ",
	"launch.systemCursorShown": "Con trỏ hệ thống sẽ được ghi lại",
	"launch.systemCursorHidden": "Con trỏ hệ thống bị ẩn trong bản ghi",
	"source.screens": "Màn hình",
	"source.windows": "Cửa sổ",
	"source.appIcon": "Biểu tượng ứng dụng",
	"source.loadFailed": "Không thể tải danh sách nguồn chia sẻ.",
	"source.shareFailed": "Không thể xác nhận nguồn đã chọn.",
	"source.screenPermissionHint":
		"Chưa cấp quyền Ghi màn hình. Mở Cài đặt hệ thống > Quyền riêng tư & Bảo mật > Màn hình & Âm thanh hệ thống, cho phép Capturia rồi khởi động lại ứng dụng.",
	"source.openSystemSettings": "Mở Cài đặt hệ thống",
	"source.openSystemSettingsFailed": "Không thể mở Cài đặt hệ thống.",
	"source.checkPermissions": "Kiểm tra quyền",
	"source.retry": "Thử lại",
	"permission.loading": "Đang kiểm tra trạng thái quyền...",
	"permission.title": "Kiểm tra quyền ứng dụng",
	"permission.intro":
		"Capturia cần một số quyền để ghi hình. Thiếu quyền bắt buộc sẽ chặn việc ghi hình, còn quyền tùy chọn chỉ ảnh hưởng đến các tính năng liên quan.",
	"permission.refresh": "Làm mới",
	"permission.refreshFailed": "Không thể làm mới trạng thái quyền.",
	"permission.openSettingsFailed": "Không thể mở cài đặt Quyền riêng tư.",
	"permission.permissionActionFailed": "Không thể yêu cầu cấp quyền.",
	"permission.rowScreenCaptureDescription": "Bắt buộc để ghi màn hình hoặc cửa sổ đã chọn.",
	"permission.rowCameraDescription": "Tùy chọn. Chỉ cần khi ghi lớp phủ camera.",
	"permission.rowMicrophoneDescription": "Tùy chọn. Cần để ghi giọng nói của bạn.",
	"permission.rowInputMonitoringTitle": "Giám sát đầu vào",
	"permission.rowInputMonitoringDescription":
		"Tùy chọn. Dùng cho một số luồng bắt phím toàn cục khi chạy nền.",
	"permission.rowAccessibilityTitle": "Trợ năng",
	"permission.rowAccessibilityDescription":
		"Tùy chọn, dự phòng cho các luồng phím nóng/truy cập cũ trên một số cấu hình macOS.",
	"permission.required": "Bắt buộc",
	"permission.optional": "Tùy chọn",
	"permission.actionGranted": "Đã cho phép",
	"permission.actionRequestAccess": "Yêu cầu quyền",
	"permission.actionOpenSettings": "Mở cài đặt Quyền riêng tư",
	"permission.actionManualCheck": "Kiểm tra thủ công",
	"permission.statusGranted": "Đã cấp",
	"permission.statusDenied": "Bị từ chối",
	"permission.statusRestricted": "Bị hạn chế",
	"permission.statusNotDetermined": "Chưa xác định",
	"permission.statusUnknown": "Không rõ",
	"permission.statusManualCheck": "Kiểm tra thủ công",
	"permission.readyHint": "Đã cấp đủ các quyền bắt buộc. Có thể ghi hình bình thường.",
	"permission.missingRequiredHint":
		"Thiếu quyền bắt buộc. Việc ghi hình bị chặn cho đến khi bạn cấp các quyền này.",
	"permission.relaunchHint":
		"Sau khi cấp quyền Ghi màn hình, macOS có thể yêu cầu khởi động lại Capturia để thay đổi có hiệu lực.",
	"permission.continue": "Tiếp tục",
	"playback.customSpeed": "Tốc độ tùy chỉnh...",
	"playback.previewSpeed": "Tốc độ xem trước",
	"playback.timelineZoom": "Thu phóng dòng thời gian",
	"editor.loadVideoError": "Lỗi khi tải video: {{message}}",
	"editor.noVideo": "Không có video để tải. Vui lòng ghi hình hoặc chọn một video.",
	"editor.gifExportSuccess": "Đã xuất GIF thành công tới {{path}}",
	"editor.videoExportSuccess": "Đã xuất video thành công tới {{path}}",
	"editor.batchVideoExportSuccess": "Đã xuất {{count}} video tới {{path}}",
	"editor.exportWarningAudioTrackUnavailable":
		"Không đọc được luồng âm thanh nguồn nên video được xuất không có âm thanh.",
	"editor.exportWarningAudioCodecUnsupported":
		"Hệ thống này không hỗ trợ mã hóa âm thanh AAC. Video đã được xuất không có âm thanh.",
	"editor.exportWarningSpeedAudioUnavailable":
		"Âm thanh không khả dụng khi xuất với tốc độ phát khác 1x.",
	"editor.exportResolutionLimited": "Độ phân giải nguồn giới hạn bản xuất này ở {{width}}x{{height}}.",
	"editor.exportAspectRatioRequired": "Chọn ít nhất một tỷ lệ khung hình trước khi xuất.",
	"editor.cropOverlayDragHint": "Kéo để định vị",
	"editor.autoEditApplied": "Đã áp dụng chỉnh sửa tự động: {{count}} vùng thu phóng",
	"editor.autoEditUnavailable": "Không phát hiện tương tác con trỏ để chỉnh sửa tự động",
	"editor.analyzeCursorNoVideo": "Không có video để phân tích con trỏ",
	"editor.analyzeCursorDone": "Phân tích con trỏ hoàn tất: phát hiện {{count}} mẫu",
	"editor.analyzeCursorEmpty": "Không phát hiện chuyển động con trỏ trong video",
	"editor.analyzeCursorError": "Phân tích con trỏ thất bại: {{message}}",
	"editor.analysisStartFailed": "Không thể bắt đầu phân tích tự động",
	"editor.analysisRunning": "Đang phân tích bản ghi để tạo phụ đề và gợi ý cắt thô...",
	"editor.analysisCompleted": "Phụ đề tự động và gợi ý cắt thô đã sẵn sàng",
	"editor.analysisNoSubtitles": "Không tạo được phụ đề nào",
	"editor.analysisNoSuggestions": "Không tìm thấy gợi ý cắt thô",
	"editor.analysisApplyRoughCutSuccess": "Đã áp dụng {{count}} gợi ý cắt thô vào luồng âm thanh",
	"editor.closeEditor": "Đóng trình chỉnh sửa",
	"editor.hideSettings": "Ẩn cài đặt",
	"editor.showSettings": "Hiện cài đặt",
	"editor.hideTimeline": "Ẩn dòng thời gian",
	"editor.showTimeline": "Hiện dòng thời gian",
	"settings.autoEdit": "Chỉnh sửa tự động",
	"settings.generateSubtitles": "Tạo phụ đề",
	"settings.applyRoughCut": "Áp dụng cắt thô",
	"settings.cursorComposer": "Trình dựng con trỏ",
	"settings.cursorTrackUnavailable":
		"Không có dữ liệu theo dõi con trỏ cho bản ghi này. Con trỏ có sẵn trong video sẽ được dùng thay thế.",
	"settings.analyzeCursor": "Phân tích con trỏ trong video",
	"settings.analyzingCursor": "Đang phân tích… {{progress}}%",
	"settings.cursorSize": "Kích thước con trỏ",
	"settings.cursorHighlight": "Làm nổi bật",
	"settings.cursorRipple": "Hiệu ứng gợn khi nhấp",
	"settings.cursorMovementStyle": "Kiểu chuyển động",
	"settings.cursorMovementRapid": "Rất nhanh",
	"settings.cursorMovementQuick": "Nhanh",
	"settings.cursorMovementSlow": "Chậm",
	"settings.cursorAutoHideStatic": "Tự động ẩn con trỏ đứng yên",
	"settings.cursorStaticHideDelay": "Độ trễ ẩn",
	"settings.cursorStaticHideFade": "Thời gian mờ dần",
	"settings.cursorLoopPosition": "Lặp vị trí con trỏ",
	"settings.cursorLoopBlend": "Hòa trộn khi lặp",
	"settings.cursorTimeOffset": "Độ lệch thời gian con trỏ",
	"settings.cursorOffsetX": "Độ lệch con trỏ X",
	"settings.cursorOffsetY": "Độ lệch con trỏ Y",
	"settings.cursorOffsetReset": "Đặt lại độ lệch con trỏ",
	"settings.audioTrack": "Luồng âm thanh",
	"settings.audioVolume": "Âm lượng",
	"settings.audioNormalizeLoudness": "Chuẩn hóa âm lượng",
	"settings.audioNormalizeHint":
		"Đưa âm thanh xuất ra về mức âm lượng mục tiêu và giữ đỉnh dưới ngưỡng giới hạn.",
	"settings.audioTargetLufs": "Âm lượng mục tiêu",
	"settings.audioLimiterCeiling": "Ngưỡng giới hạn",
	"settings.audioTrackMissing": "Không phát hiện luồng âm thanh nguồn",
	"settings.exportVideo": "Xuất {{format}}",
	"settings.quality.low": "Thấp (720p)",
	"settings.quality.medium": "Trung bình (1080p)",
	"settings.quality.high": "Gốc (tốt nhất)",
	"settings.exportAspectRatios": "Tỷ lệ khung hình",
	"settings.exportAspectRatioCount": "Đã chọn {{count}}",
	"settings.exportAspectRatioHint":
		"Chọn một hoặc nhiều tỷ lệ và xuất tất cả phiên bản đã chọn trong một lần.",
	"settings.gif.original": "Gốc",
	"settings.seekStep": "Bước tua",
	"export.statusFinalizingVideo": "Đang hoàn tất định dạng video...",
	"export.statusFinalizingVideoStep": "{{step}}...",
	"export.batchProgress": "Xuất {{current}}/{{total}}",
	"export.elapsed": "Đã trôi qua",
	"export.eta": "Còn lại",
	"export.activity": "Hoạt động",
	"export.activityActive": "Đang xử lý",
	"export.activityWaiting": "Vẫn đang chạy",
	"export.activityStalled": "Không có cập nhật mới",
	"export.activityStalledHint":
		"Không có cập nhật trong {{seconds}}s. Quá trình xuất có thể vẫn đang hoàn tất; hãy hủy và thử lại nếu tình trạng này kéo dài.",
	"export.finalize.flush": "Đang xả bộ mã hóa",
	"export.finalize.mux": "Đang ghi luồng video",
	"export.finalize.audio": "Đang mã hóa luồng âm thanh",
	"export.finalize.package": "Đang đóng gói MP4",
	"export.exportedTo": "Đã xuất tới {{path}}",
	"export.revealFailed": "Không thể hiển thị tệp trong thư mục",
	"gif.outputSize": "Kích thước đầu ra",
	"gif.loopAnimation": "Lặp hoạt ảnh",
	"gif.loopDesc": "GIF sẽ phát liên tục",
	"shortcut.seekForward": "Tua tới",
	"shortcut.seekBackward": "Tua lui",
	"shortcut.seekFine": "Tua tinh chỉnh (±1s)",
	"shortcut.speedUp": "Tăng tốc",
	"shortcut.speedDown": "Giảm tốc",
	"shortcut.zoomIn": "Phóng to dòng thời gian",
	"shortcut.zoomOut": "Thu nhỏ dòng thời gian",
	"shortcut.toggleScissors": "Chế độ tách",
	"tutorial.explain":
		"Công cụ Cắt hoạt động bằng cách xác định các đoạn bạn muốn loại bỏ. Mọi phần nằm trong đoạn cắt màu đỏ sẽ bị loại khỏi video khi xuất.",
	"tutorial.part": "Phần {{index}}",
	"tutorial.step1desc": "Nhấn T hoặc nhấp biểu tượng cái kéo để đánh dấu đoạn cần loại bỏ.",
	"annotation.uploadedImage": "Ảnh chú thích đã tải lên",
	"font.dialogDesc": "Thêm phông chữ tùy chỉnh từ Google Fonts để dùng trong chú thích.",
	"timeline.split": "Tách",
	"timeline.splitAtPlayhead": "Tách (S)",
	"timeline.cannotDeleteLastSegment": "Không thể xóa đoạn cuối cùng",
	"timeline.segmentSpeed": "Tốc độ đoạn",
	"timeline.restoreSegment": "Khôi phục đoạn",
	"timeline.subtitle": "Phụ đề",
	"timeline.audioMuted": "Đã tắt tiếng",
	"timeline.audioAutoEdits": "{{count}} chỉnh sửa tự động",
	"timeline.audioMutedSegment": "Đoạn tắt tiếng",
	"timeline.audioUnavailable": "Không có âm thanh",
	"timeline.resizeLeft": "Kéo cạnh trái",
	"timeline.resizeRight": "Kéo cạnh phải",
	"electron.tray.openScreen": "Capturia",
	"electron.exportSaved": "Đã xuất video thành công",
	"electron.filePickerFailed": "Không thể mở hộp thoại chọn tệp",
	"electron.chooseExportFolder": "Chọn thư mục xuất",
	"electron.exportPathRejected": "Vị trí xuất phải được chọn qua hộp thoại lưu",
	"electron.unsupportedVideoFile": "Tệp đã chọn không phải định dạng video được hỗ trợ",
	"electron.runtimeError.message":
		"Capturia gặp lỗi nội bộ. Vui lòng báo lỗi để chúng tôi khắc phục.",
	"electron.runtimeError.detailPrefix": "Mã tham chiếu",
	"electron.runtimeError.report": "Báo lỗi",
	"electron.runtimeError.close": "Đóng",
};

// ---------------------------------------------------------------------------

function readLegacy(file) {
	const src = fs.readFileSync(file, "utf8");
	const marker = "const messages: Record<Locale, Record<string, string>> = ";
	const start = src.indexOf(marker);
	if (start === -1) throw new Error(`messages table not found in ${file}`);
	const end = src.indexOf("\n};\n", start);
	const body = src.slice(start + marker.length, end + 2);
	// The table is a plain object literal with string values; evaluate it.
	return new Function(`return (${body});`)();
}

function flatten(obj, prefix = "", out = {}) {
	for (const [k, v] of Object.entries(obj)) {
		const full = prefix ? `${prefix}.${k}` : k;
		if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, full, out);
		else out[full] = v;
	}
	return out;
}

function readUpstream(root) {
	const result = {};
	if (!fs.existsSync(root)) return result;
	for (const locale of fs.readdirSync(root)) {
		const dir = path.join(root, locale);
		if (!fs.statSync(dir).isDirectory()) continue;
		result[locale] = {};
		for (const file of fs.readdirSync(dir)) {
			if (!file.endsWith(".json")) continue;
			const ns = file.replace(/\.json$/, "");
			const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
			for (const [k, v] of Object.entries(flatten(data))) result[locale][`${ns}.${k}`] = v;
		}
	}
	return result;
}

function renameKey(legacyKey) {
	const dot = legacyKey.indexOf(".");
	const prefix = legacyKey.slice(0, dot);
	const rest = legacyKey.slice(dot + 1);
	const entry = PREFIX_MAP[prefix];
	if (!entry) throw new Error(`no namespace mapping for prefix "${prefix}" (${legacyKey})`);
	const [ns, sub] = entry;
	return { ns, key: sub ? `${sub}.${rest}` : rest };
}

/**
 * Build a nested object from dotted keys. A key that is both a leaf and a
 * branch keeps its leaf value; the branch's descendants are stored as dotted
 * keys on the same parent (see loader `getMessageValue`).
 */
function nest(flat) {
	const keys = Object.keys(flat);
	const isLeaf = new Set(keys);
	const root = {};
	for (const key of keys) {
		const parts = key.split(".");
		let node = root;
		let consumed = "";
		for (let i = 0; i < parts.length - 1; i++) {
			const step = consumed ? `${consumed}.${parts[i]}` : parts[i];
			if (isLeaf.has(step)) {
				// conflict: `step` is a string; store the remainder as a dotted key here
				node[parts.slice(i).join(".")] = flat[key];
				node = null;
				break;
			}
			consumed = step;
			if (!(parts[i] in node)) node[parts[i]] = {};
			node = node[parts[i]];
		}
		if (node) node[parts[parts.length - 1]] = flat[key];
	}
	return root;
}

const placeholders = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
const norm = (s) =>
	String(s)
		.toLowerCase()
		.replace(/[.…:!]+$/, "")
		.replace(/\s+/g, " ")
		.trim();

function renameVars(value, vars) {
	if (!vars) return value;
	return value.replace(/\{\{(\w+)\}\}/g, (m, name) => (name in vars ? `{{${vars[name]}}}` : m));
}

// ---------------------------------------------------------------------------

const legacy = readLegacy(LEGACY);
const v17 = readUpstream(V17);
const v110 = readUpstream(V110);

const enFlat = { ...legacy.en, ...NEW_KEYS.en };
const zhFlat = { ...legacy["zh-CN"], ...NEW_KEYS["zh-CN"] };

const problems = [];
const twinsUsed = {};

/** Resolve the upstream value for `legacyKey` in `locale`, or undefined. */
function twinValue(legacyKey, locale) {
	const spec = UPSTREAM_TWINS[legacyKey];
	if (!spec) return undefined;
	const { up, loose = false, vars } = typeof spec === "string" ? { up: spec } : spec;
	const enValue = enFlat[legacyKey];
	for (const source of [v110, v17]) {
		const upEn = source.en?.[up];
		if (upEn == null) continue;
		if (!loose && norm(renameVars(upEn, vars)) !== norm(enValue)) continue;
		const value = source[locale]?.[up];
		if (typeof value !== "string") continue;
		const renamed = renameVars(value, vars);
		if (placeholders(renamed).join() !== placeholders(enValue).join()) {
			problems.push(`placeholder mismatch ${legacyKey} <- ${up} (${locale}): ${renamed}`);
			return undefined;
		}
		twinsUsed[legacyKey] = up;
		return renamed;
	}
	return undefined;
}

for (const legacyKey of Object.keys(UPSTREAM_TWINS)) {
	if (!(legacyKey in enFlat)) problems.push(`twin for unknown key ${legacyKey}`);
}

const viFlat = {};
const viOwn = [];
for (const legacyKey of Object.keys(enFlat)) {
	const twin = twinValue(legacyKey, "vi");
	if (twin != null) viFlat[legacyKey] = twin;
	else if (legacyKey in VI_OVERRIDES) {
		viFlat[legacyKey] = VI_OVERRIDES[legacyKey];
		viOwn.push(legacyKey);
	} else problems.push(`no vi value for ${legacyKey}`);
}
for (const key of Object.keys(VI_OVERRIDES)) {
	if (!(key in enFlat)) problems.push(`VI_OVERRIDES has unknown key ${key}`);
	else if (!viOwn.includes(key)) problems.push(`VI_OVERRIDES[${key}] unused (twin found)`);
}

const partialFlat = {};
for (const locale of PARTIAL_LOCALES) {
	partialFlat[locale] = {};
	for (const legacyKey of Object.keys(enFlat)) {
		const value = twinValue(legacyKey, locale);
		if (value != null) partialFlat[locale][legacyKey] = value;
	}
}

for (const key of Object.keys(UPSTREAM_TWINS)) {
	if (!(key in twinsUsed)) problems.push(`twin never matched: ${key} -> ${JSON.stringify(UPSTREAM_TWINS[key])}`);
}

if (problems.length > 0) {
	console.error("Migration problems:");
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}

function writeLocale(locale, flat) {
	const byNs = Object.fromEntries(NAMESPACES.map((ns) => [ns, {}]));
	for (const [legacyKey, value] of Object.entries(flat)) {
		const { ns, key } = renameKey(legacyKey);
		byNs[ns][key] = value;
	}
	const dir = path.join(OUT, locale);
	fs.mkdirSync(dir, { recursive: true });
	const counts = {};
	for (const ns of NAMESPACES) {
		const nested = nest(byNs[ns]);
		fs.writeFileSync(path.join(dir, `${ns}.json`), `${JSON.stringify(nested, null, "\t")}\n`);
		counts[ns] = Object.keys(byNs[ns]).length;
	}
	return counts;
}

const counts = {
	en: writeLocale("en", enFlat),
	"zh-CN": writeLocale("zh-CN", zhFlat),
	vi: writeLocale("vi", viFlat),
};
for (const locale of PARTIAL_LOCALES) counts[locale] = writeLocale(locale, partialFlat[locale]);

console.log(`legacy keys: ${Object.keys(legacy.en).length}, en total: ${Object.keys(enFlat).length}`);
console.log(`twins matched: ${Object.keys(twinsUsed).length}, vi hand-written: ${viOwn.length}`);
for (const [locale, c] of Object.entries(counts)) {
	const total = Object.values(c).reduce((a, b) => a + b, 0);
	console.log(`${locale.padEnd(6)} ${String(total).padStart(4)}  ${JSON.stringify(c)}`);
}
