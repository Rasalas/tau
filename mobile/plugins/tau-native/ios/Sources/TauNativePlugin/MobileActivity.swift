import ActivityKit
import Foundation
import WidgetKit

@available(iOS 16.2, *)
public struct TauActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        public var title: String?
        public var state: String?
        public var expiresAt: Double?
        public var sealed: String? = nil
    }
    public var hostId: String
    public var threadId: String
}

/// App-group storage contains bounded display snapshots only. No credentials enter the extension.
public enum MobileActivityStore {
    public static let group = "group.de.tbuck.tau"
    public static func usage(_ snapshot: [String: Any]) {
        guard let host = snapshot["hostId"] as? String, let defaults = UserDefaults(suiteName: group),
              let data = try? JSONSerialization.data(withJSONObject: snapshot) else { return }
        defaults.set(data, forKey: "usage." + host)
        WidgetCenter.shared.reloadTimelines(ofKind: "TauUsage")
    }
    public static func clear(_ host: String) async {
        ActivityCipher.forget(host: host)
        UserDefaults(suiteName: group)?.removeObject(forKey: "usage." + host)
        WidgetCenter.shared.reloadTimelines(ofKind: "TauUsage")
        if #available(iOS 16.2, *) {
            for activity in Activity<TauActivityAttributes>.activities where activity.attributes.hostId == host { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }
    @available(iOS 16.2, *)
    public static func update(_ value: [String: Any], token: @escaping ([String: Any]) -> Void) async throws {
        guard let host = value["hostId"] as? String, let thread = value["threadId"] as? String,
              let state = value["state"] as? String, ["running", "completed", "needs-input"].contains(state),
              let expires = value["expiresAt"] as? Double, expires > Date().timeIntervalSince1970 * 1000 else { return }
        let content = ActivityContent(state: TauActivityAttributes.ContentState(title: String((value["title"] as? String ?? "Agent work").prefix(100)), state: state, expiresAt: expires), staleDate: Date(timeIntervalSince1970: expires / 1000))
        if let current = Activity<TauActivityAttributes>.activities.first(where: { $0.attributes.hostId == host && $0.attributes.threadId == thread }) {
            if state == "completed" { await current.end(content, dismissalPolicy: .after(Date(timeIntervalSince1970: expires / 1000))) }
            else { await current.update(content) }
        } else if state != "completed" && ActivityAuthorizationInfo().areActivitiesEnabled {
            let activity = try Activity.request(attributes: TauActivityAttributes(hostId: host, threadId: thread), content: content, pushType: .token)
            Task {
                for await bytes in activity.pushTokenUpdates {
                    token(["hostId": host, "threadId": thread, "token": bytes.map { String(format: "%02x", $0) }.joined(), "topic": Bundle.main.bundleIdentifier ?? "de.tbuck.tau"])
                }
            }
        }
    }
}
