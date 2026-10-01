import ActivityKit
import SwiftUI
import WidgetKit

// Debug harness: feeds the real MobileActivityStore the way the Capacitor plugin does.
@main struct HarnessApp: App {
    @State private var log = "starting"
    var body: some Scene {
        WindowGroup {
            Text(log).accessibilityIdentifier("log").padding()
                .task { log = await run(ProcessInfo.processInfo.arguments) }
        }
    }
}

let now = Date().timeIntervalSince1970 * 1000
func window(_ label: String, _ used: Double) -> [String: Any] { ["label": label, "usedPercent": used, "resetsAt": now + 3_600_000] }

func run(_ args: [String]) async -> String {
    var done: [String] = []
    let defaults = UserDefaults(suiteName: MobileActivityStore.group)
    if args.contains("-clear") {
        for key in defaults?.dictionaryRepresentation().keys ?? [:].keys where key.hasPrefix("usage.") { defaults?.removeObject(forKey: key) }
        WidgetCenter.shared.reloadTimelines(ofKind: "TauUsage"); done.append("cleared")
    }
    if args.contains("-usage") {
        MobileActivityStore.usage(["hostId": "mac-studio", "updatedAt": now, "expiresAt": now + 15 * 60_000, "accounts": [
            ["poolKey": "codex:acct-1", "label": "Codex · ChatGPT Plus", "checkedAt": now - 60_000, "windows": [window("5-hour", 34), window("Weekly", 61)]],
            ["poolKey": "claude-code:acct-2", "label": "Claude Code · Max", "checkedAt": now - 30_000, "windows": [window("5-hour", 12), window("Weekly", 47)]],
        ]])
        MobileActivityStore.usage(["hostId": "linux-box", "updatedAt": now, "expiresAt": now + 15 * 60_000, "accounts": [
            ["poolKey": "claude-code:acct-2", "label": "Claude Code · Max", "checkedAt": now - 600_000, "windows": [window("5-hour", 3), window("Weekly", 40)]],
            ["label": "OpenCode Go", "checkedAt": now - 90_000, "windows": [window("Monthly", 22)]],
        ]])
        done.append("usage")
    }
    if args.contains("-end") {
        for activity in Activity<TauActivityAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
        done.append("ended")
    }
    // -activity <threadId> <state> <title> [ttlSeconds]
    var index = 0
    while let at = args[index...].firstIndex(of: "-activity"), at + 3 < args.count {
        let ttl = at + 4 < args.count ? Double(args[at + 4]) ?? 0 : 0
        let expires = now + (ttl > 0 ? ttl * 1000 : 8 * 3_600_000)
        do {
            try await MobileActivityStore.update(["hostId": "mac-studio", "threadId": args[at + 1], "state": args[at + 2], "title": args[at + 3], "expiresAt": expires]) { _ in }
            done.append("\(args[at + 1])=\(args[at + 2])")
        } catch { done.append("error \(error)") }
        index = at + 1
    }
    return "ready " + done.joined(separator: " ") + " activities=\(Activity<TauActivityAttributes>.activities.count)"
}
