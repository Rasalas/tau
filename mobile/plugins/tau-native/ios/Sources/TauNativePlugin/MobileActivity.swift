import ActivityKit
import Foundation
import WidgetKit

/// App-group storage contains bounded display snapshots only. No credentials enter the extension.
public enum MobileActivityStore {
    public static let group = "group.de.tbuck.tau"
    /// The thread id a host's one Live Activity carries; the host's push kit uses the same.
    public static let bundleThread = "tau.threads"
    /// A Live Activity the app no longer writes to reads as stale after this; the app writes every two minutes.
    static let staleAfter: TimeInterval = 20 * 60
    /// Release builds leave the extension and the App Group out until K163 (TAU_IOS_WIDGETS).
    public static let widgets = Bundle.main.builtInPlugInsURL.map { FileManager.default.fileExists(atPath: $0.appendingPathComponent("TauWidgets.appex").path) } ?? false
    // Without the entitlement, a suite would silently write to the app's own container.
    static var shared: UserDefaults? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) == nil ? nil : UserDefaults(suiteName: group)
    }
    /// The host's snapshot: the widgets read it from the App Group, and the host's Live Activity follows its threads.
    @available(iOS 16.2, *)
    public static func snapshot(_ value: [String: Any], token: @escaping ([String: Any]) -> Void) async {
        guard value["version"] as? Int == 3, let data = try? JSONSerialization.data(withJSONObject: value),
              var snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data) else { return }
        if let defaults = shared {
            let key = "widget." + snapshot.hostId
            snapshot = WidgetModel.keeping(snapshot, previous: defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(WidgetSnapshot.self, from: $0) })
            if let stored = try? JSONEncoder().encode(snapshot) { defaults.set(stored, forKey: key) }
            WidgetCenter.shared.reloadAllTimelines()
        }
        if widgets { await bundle(snapshot.threadsSnapshot, token: token) }
    }
    public static func clear(_ host: String) async {
        ActivityCipher.forget(host: host)
        shared?.removeObject(forKey: "widget." + host)
        WidgetCenter.shared.reloadAllTimelines()
        if #available(iOS 16.2, *) {
            for activity in Activity<TauActivityAttributes>.activities where activity.attributes.hostId == host { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }

    /// The host's activities, the app's own and those its push started.
    @available(iOS 16.2, *)
    static func activities(of host: String) -> [Activity<TauActivityAttributes>] {
        Activity<TauActivityAttributes>.activities.filter { activity in
            guard activity.activityState == .active || activity.activityState == .stale else { return false }
            if activity.attributes.hostId == host { return true }
            guard let id = activity.attributes.activityId, let bootstrap = activity.attributes.bootstrap,
                  let opened = ActivityCipher.openActivity(bootstrap, activityId: id, purpose: "start") else { return false }
            return opened["hostId"] as? String == host
        }
    }

    /// One activity per host: started with the first thread at work, ended a while after the last one finished.
    @available(iOS 16.2, *)
    static func bundle(_ snapshot: ThreadsSnapshot, token: @escaping ([String: Any]) -> Void) async {
        let now = Date()
        let rows = WidgetModel.activityRows(snapshot.threads, now: now)
        let working = rows.contains(where: \.active)
        let content = ActivityContent(state: TauActivityAttributes.ContentState(threads: rows, updatedAt: snapshot.updatedAt),
                                      staleDate: now.addingTimeInterval(staleAfter), relevanceScore: rows.contains { $0.state == "waiting" } ? 100 : 50)
        let current = activities(of: snapshot.hostId)
        // Older builds and per-thread starts leave several; the first one carries on for all.
        for extra in current.dropFirst() { await extra.end(nil, dismissalPolicy: .immediate) }
        if let activity = current.first {
            if working { await activity.update(content); return }
            if rows.isEmpty { await activity.end(nil, dismissalPolicy: .immediate); return }
            let failed = rows.contains { $0.state == "failed" }
            await activity.update(content, alertConfiguration: AlertConfiguration(title: "Tau", body: failed ? "A thread failed" : "Your threads are done", sound: .default))
            await activity.end(content, dismissalPolicy: .after(now.addingTimeInterval(WidgetModel.endedShown)))
        } else if working && ActivityAuthorizationInfo().areActivitiesEnabled {
            guard let activity = try? Activity.request(attributes: TauActivityAttributes(hostId: snapshot.hostId, threadId: bundleThread), content: content, pushType: .token) else { return }
            Task {
                for await bytes in activity.pushTokenUpdates {
                    token(["hostId": snapshot.hostId, "threadId": bundleThread, "token": bytes.map { String(format: "%02x", $0) }.joined(), "topic": Bundle.main.bundleIdentifier ?? "de.tbuck.tau"])
                }
            }
        }
    }
}
