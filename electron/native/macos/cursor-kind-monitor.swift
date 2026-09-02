import AppKit
import CryptoKit
import Foundation

// Kind names are the wire format read by `electron/native/cursorKindMonitor.ts`
// (`parseCursorKindLine`) and must stay in sync with `src/lib/cursor/cursorKinds.ts`.
private enum CursorKind: String {
    case arrow
    case text
    case pointer
    case crosshair
    case openHand = "open-hand"
    case closedHand = "closed-hand"
    case resizeEW = "resize-ew"
    case resizeNS = "resize-ns"
    case resizeNESW = "resize-nesw"
    case resizeNWSE = "resize-nwse"
    case move
    case notAllowed = "not-allowed"
    case wait
    case appStarting = "app-starting"
    case help
    case upArrow = "up-arrow"
}

/// Bitmaps of the system I-beam observed on real machines (kept from the
/// arrow/ibeam-only helper): checked before the runtime table because the
/// cursor Chromium installs for text fields is not always `NSCursor.iBeam`.
private let knownTextHashes: Set<String> = [
    // macOS I-beam
    "492dca0bb6751a30607ac728803af992ba69365052b7df2dff1c0dfe463e653c",
    // macOS I-beam vertical
    "024e1d486a7f16368669d419e69c9a326e464ec1b8ed39645e5c89cb183e03c5",
    "c715df2b1e5956f746fea3cdbe259136f3349773e9dbf26cc65b122905c4eb1c",
    // macOS Tahoe I-beam
    "3de4a52b22f76f28db5206dc4c2219dff28a6ee5abfb9c5656a469f2140f7eaa",
]

private func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func imageHash(_ image: NSImage) -> String? {
    guard let tiff = image.tiffRepresentation else { return nil }
    return sha256Hex(tiff)
}

/// Hash -> kind for the standard AppKit cursors, built once at launch on this
/// machine so it follows the OS version. `NSCursor.currentSystem` returns the
/// same bitmap as the corresponding `NSCursor.<standard>` when an app uses the
/// standard cursor, which covers AppKit apps, Safari and most Chromium kinds
/// (hand, I-beam, ew/ns resize, not-allowed, grab). Chromium's diagonal resize
/// cursors are custom bitmaps and fall back to `arrow`.
private func buildStandardCursorTable() -> [String: CursorKind] {
    var table: [String: CursorKind] = [:]
    let entries: [(NSCursor, CursorKind)] = [
        (NSCursor.arrow, .arrow),
        (NSCursor.iBeam, .text),
        (NSCursor.iBeamCursorForVerticalLayout, .text),
        (NSCursor.pointingHand, .pointer),
        (NSCursor.crosshair, .crosshair),
        (NSCursor.openHand, .openHand),
        (NSCursor.closedHand, .closedHand),
        (NSCursor.resizeLeftRight, .resizeEW),
        (NSCursor.resizeLeft, .resizeEW),
        (NSCursor.resizeRight, .resizeEW),
        (NSCursor.resizeUpDown, .resizeNS),
        (NSCursor.resizeUp, .resizeNS),
        (NSCursor.resizeDown, .resizeNS),
        (NSCursor.operationNotAllowed, .notAllowed),
        (NSCursor.dragLink, .pointer),
        (NSCursor.dragCopy, .arrow),
        (NSCursor.contextualMenu, .arrow),
        (NSCursor.disappearingItem, .arrow),
    ]
    for (cursor, kind) in entries {
        if let hash = imageHash(cursor.image), table[hash] == nil {
            table[hash] = kind
        }
    }
    return table
}

private let standardCursorTable = buildStandardCursorTable()

private func currentSystemCursor() -> NSCursor {
    if #available(macOS 14.0, *), let current = NSCursor.currentSystem {
        return current
    }
    return NSCursor.current
}

/// Last resort: AppKit names its cursor images (`ibeamCursor`, `pointingHandCursor`,
/// `resizeLeftRightCursor`, ...). Custom bitmaps (Chromium's diagonal resizes)
/// usually have no name.
private func kindFromImageName(_ name: String) -> CursorKind? {
    let lowered = name.lowercased()
    if lowered.contains("beam") || lowered.contains("text") { return .text }
    if lowered.contains("pointinghand") || lowered.contains("link") { return .pointer }
    if lowered.contains("crosshair") { return .crosshair }
    if lowered.contains("openhand") { return .openHand }
    if lowered.contains("closedhand") { return .closedHand }
    if lowered.contains("leftright") || lowered.contains("resizeleft") || lowered.contains("resizeright") { return .resizeEW }
    if lowered.contains("updown") || lowered.contains("resizeup") || lowered.contains("resizedown") { return .resizeNS }
    if lowered.contains("notallowed") { return .notAllowed }
    if lowered.contains("busy") || lowered.contains("wait") { return .wait }
    if lowered.contains("help") { return .help }
    return nil
}

private func resolveCursorKind() -> CursorKind {
    let cursor = currentSystemCursor()
    if let hash = imageHash(cursor.image) {
        if knownTextHashes.contains(hash) {
            return .text
        }
        if let kind = standardCursorTable[hash] {
            return kind
        }
    }

    if let name = cursor.image.name(), let kind = kindFromImageName(name) {
        return kind
    }

    return .arrow
}

@main
struct CursorKindMonitorMain {
    static func main() {
        var lastKind: CursorKind?

        while true {
            autoreleasepool {
                let currentKind = resolveCursorKind()
                if currentKind != lastKind {
                    print("CURSOR_KIND \(currentKind.rawValue)")
                    fflush(stdout)
                    lastKind = currentKind
                }
            }
            usleep(16_000)
        }
    }
}
