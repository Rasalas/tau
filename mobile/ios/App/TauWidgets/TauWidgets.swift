import ActivityKit
import SwiftUI
import WidgetKit

// Identical Codable contract to the native plugin. It is compiled into each target.
struct TauActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable { var title: String?; var state: String?; var expiresAt: Double?; var sealed: String? = nil }
    var hostId: String
    var threadId: String
}
func threadURL(_ attributes: TauActivityAttributes) -> URL? {
    var url = URLComponents(); url.scheme = "tau"; url.host = "thread"
    url.queryItems = [URLQueryItem(name: "host", value: attributes.hostId), URLQueryItem(name: "thread", value: attributes.threadId)]
    return url.url
}
func activityDisplay(_ state: TauActivityAttributes.ContentState, attributes: TauActivityAttributes) -> (title: String, state: String) {
    if let sealed = state.sealed {
        guard let content = ActivityCipher.open(sealed), content["hostId"] as? String == attributes.hostId,
              content["threadId"] as? String == attributes.threadId,
              let title = content["title"] as? String, let status = content["state"] as? String else { return ("Tau", "unavailable") }
        return (String(title.prefix(100)), status)
    }
    return (state.title ?? "Tau", state.state ?? "unavailable")
}
func status(_ state: String) -> String { state == "running" ? "Agent working" : state == "needs-input" ? "Your input needed" : state == "completed" ? "Completed" : "Open Tau to refresh" }
struct TauLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TauActivityAttributes.self) { context in
            let shown = activityDisplay(context.state, attributes: context.attributes)
            VStack(alignment: .leading) { Text(shown.title).font(.headline).lineLimit(2); Text(context.isStale ? "Open Tau to refresh" : status(activityDisplay(context.state, attributes: context.attributes).state)) }
                .padding().widgetURL(threadURL(context.attributes))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Image(systemName: "terminal") }
                DynamicIslandExpandedRegion(.bottom) { VStack { Text(activityDisplay(context.state, attributes: context.attributes).title).lineLimit(1); Text(context.isStale ? "Open Tau to refresh" : status(activityDisplay(context.state, attributes: context.attributes).state)) } }
            } compactLeading: { Image(systemName: "terminal") } compactTrailing: { Image(systemName: activityDisplay(context.state, attributes: context.attributes).state == "needs-input" ? "questionmark" : activityDisplay(context.state, attributes: context.attributes).state == "completed" ? "checkmark" : "ellipsis") } minimal: { Image(systemName: "terminal") }
            .widgetURL(threadURL(context.attributes))
        }
    }
}
struct UsageEntry: TimelineEntry { let date: Date; let rows: [String] }
struct UsageProvider: TimelineProvider {
    func placeholder(in context: Context) -> UsageEntry { UsageEntry(date: .now, rows: ["Subscription usage"]) }
    func getSnapshot(in context: Context, completion: @escaping (UsageEntry) -> Void) { completion(read()) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<UsageEntry>) -> Void) {
        let entry = read(); completion(Timeline(entries: [entry, UsageEntry(date: .now.addingTimeInterval(900), rows: ["Open Tau to refresh usage"])], policy: .after(.now.addingTimeInterval(900))))
    }
    func read() -> UsageEntry {
        let defaults = UserDefaults(suiteName: "group.de.tbuck.tau")
        var rows: [String] = []
        var pooled: [String: [String: Any]] = [:]
        for (key, value) in defaults?.dictionaryRepresentation() ?? [:] where key.hasPrefix("usage.") {
            guard let data = value as? Data, let snapshot = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let expires = snapshot["expiresAt"] as? Double, expires > Date().timeIntervalSince1970 * 1000,
                  let accounts = snapshot["accounts"] as? [[String: Any]] else { continue }
            for (index, account) in accounts.enumerated() {
                let identity = account["poolKey"] as? String ?? "\(key):\(index)"
                if (account["checkedAt"] as? Double ?? 0) >= (pooled[identity]?["checkedAt"] as? Double ?? 0) { pooled[identity] = account }
            }
        }
        for account in pooled.values {
                for window in account["windows"] as? [[String: Any]] ?? [] {
                    rows.append("\(account["label"] as? String ?? "Account") · \(window["label"] as? String ?? "Usage"): \(Int(window["usedPercent"] as? Double ?? 0))%")
                }
        }
        return UsageEntry(date: .now, rows: rows.isEmpty ? ["Open Tau to refresh usage"] : Array(rows.prefix(6)))
    }
}
struct TauUsageWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TauUsage", provider: UsageProvider()) { entry in
            VStack(alignment: .leading, spacing: 6) { Text("Tau usage").font(.headline); ForEach(Array(entry.rows.enumerated()), id: \.offset) { _, row in Text(row).font(.caption).lineLimit(2) } }
                .containerBackground(.fill.tertiary, for: .widget).widgetURL(URL(string: "tau://hosts"))
        }.configurationDisplayName("Subscription usage").description("The last account quota readings from your paired hosts.").supportedFamilies([.systemSmall, .systemMedium])
    }
}
@main struct TauWidgets: WidgetBundle { var body: some Widget { TauUsageWidget(); TauLiveActivity() } }
