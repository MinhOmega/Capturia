import Foundation
import CoreGraphics

/// Prints the global bounds (points, top-left origin) of one window as JSON:
/// `{"x":..,"y":..,"width":..,"height":..}`. Used by the cursor tracker to map
/// cursor samples into a captured window's space. Exit codes: 64 missing/invalid
/// window id, 66 window not on screen, 65 no bounds, 70 JSON failure.
@main
struct WindowBoundsHelperMain {
    private static func printError(_ message: String) {
        FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    }

    static func main() {
        guard CommandLine.arguments.count >= 2, let windowId = UInt32(CommandLine.arguments[1]) else {
            printError("missing_window_id")
            exit(64)
        }

        let infoList = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowId) as? [[String: Any]]
        guard let first = infoList?.first else {
            printError("window_not_found")
            exit(66)
        }

        guard let bounds = first[kCGWindowBounds as String] as? [String: Any] else {
            printError("bounds_missing")
            exit(65)
        }

        let x = (bounds["X"] as? NSNumber)?.doubleValue ?? 0
        let y = (bounds["Y"] as? NSNumber)?.doubleValue ?? 0
        let width = (bounds["Width"] as? NSNumber)?.doubleValue ?? 0
        let height = (bounds["Height"] as? NSNumber)?.doubleValue ?? 0

        let payload: [String: Double] = [
            "x": x,
            "y": y,
            "width": width,
            "height": height,
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []) else {
            printError("json_encode_failed")
            exit(70)
        }
        FileHandle.standardOutput.write(data)
        exit(0)
    }
}
