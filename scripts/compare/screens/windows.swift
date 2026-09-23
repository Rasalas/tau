// Prints the on-screen windows one process owns as JSON lines, so a screen
// script can capture a native menu with `screencapture -l <id>` and never the
// rest of the desktop. Usage: swift windows.swift <pid>
import CoreGraphics
import Foundation

let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for window in list where (window[kCGWindowOwnerPID as String] as? Int32) == pid {
  let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let entry: [String: Any] = [
    "id": window[kCGWindowNumber as String] ?? 0,
    "layer": window[kCGWindowLayer as String] ?? 0,
    "width": bounds["Width"] ?? 0,
    "height": bounds["Height"] ?? 0,
  ]
  if let data = try? JSONSerialization.data(withJSONObject: entry), let line = String(data: data, encoding: .utf8) {
    print(line)
  }
}
