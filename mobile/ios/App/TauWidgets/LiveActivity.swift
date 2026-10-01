import ActivityKit
import SwiftUI
import WidgetKit

/// What a host's Live Activity shows: its threads at work and those that just ended.
struct ActivityDisplay {
    var rows: [WidgetThread] = []
    var host: String?
    var machine: String?
    var updated: Date?
    var unavailable = false
    var single: WidgetThread? { rows.count == 1 ? rows[0] : nil }
    var waiting: Int { WidgetModel.count(rows, "waiting") }
    var running: Int { WidgetModel.count(rows, "running") }
    var active: Bool { rows.contains(where: \.active) }
    /// The thread a tap opens: a question first.
    var target: WidgetThread? { rows.first }
    var url: URL? { threadURL(host: host, thread: target?.id) }

    init(_ state: TauActivityAttributes.ContentState, _ attributes: TauActivityAttributes) {
        updated = state.updatedAt.map { Date(ms: $0) }
        // A remote start names its host only inside the sealed bootstrap.
        let initial = attributes.activityId.flatMap { id in attributes.bootstrap.flatMap { ActivityCipher.openActivity($0, activityId: id, purpose: "start") } }
        host = attributes.hostId ?? initial?["hostId"] as? String
        defer { machine = SharedSnapshots.machine(host) }
        if let threads = state.threads {
            rows = Self.clean(threads)
        } else if let id = attributes.activityId, let bootstrap = attributes.bootstrap {
            guard let initial else { unavailable = true; return }
            let opened = state.sealed.flatMap { ActivityCipher.openActivity($0, activityId: id, purpose: "update") }
            guard let content = opened ?? (state.sealed == bootstrap ? initial : nil),
                  content["hostId"] as? String == host, content["threadId"] as? String == initial["threadId"] as? String else { unavailable = true; return }
            rows = Self.rows(content)
        } else if let sealed = state.sealed {
            guard let content = ActivityCipher.open(sealed), content["hostId"] as? String == attributes.hostId,
                  content["threadId"] as? String == attributes.threadId else { unavailable = true; return }
            rows = Self.rows(content)
        } else if let title = state.title, let status = state.state {
            rows = Self.rows(["title": title, "state": status, "threadId": attributes.threadId ?? "", "threads": state.threads as Any])
        } else { unavailable = true }
    }

    static func clean(_ rows: [WidgetThread]) -> [WidgetThread] {
        Array(rows.prefix(4)).map { row in var row = row; row.title = String(row.title.prefix(100)); return row }
    }

    /// A pushed bundle carries its rows; a single-thread update its title and state.
    static func rows(_ content: [String: Any]) -> [WidgetThread] {
        if let list = content["threads"] as? [[String: Any]], let data = try? JSONSerialization.data(withJSONObject: list),
           let decoded = try? JSONDecoder().decode([WidgetThread].self, from: data) { return clean(decoded) }
        guard let title = content["title"] as? String, let status = content["state"] as? String else { return [] }
        let state = status == "needs-input" ? "waiting" : status == "completed" ? "done" : "running"
        return [WidgetThread(id: content["threadId"] as? String ?? "", title: String(title.prefix(100)), state: state, endedAt: state == "done" ? content["updatedAt"] as? Double : nil)]
    }
}

// MARK: Lock screen

struct ActivityHeader: View {
    var display: ActivityDisplay
    var stale: Bool
    var body: some View {
        HStack(spacing: 7) {
            TauPlate(size: 18)
            Text("Tau").fontWeight(.semibold)
            if let single = display.single {
                if let machine = display.machine { HStack(spacing: 4) { Text("·"); Machine(name: machine) } }
                Spacer(minLength: 4)
                SingleState(thread: single, stale: stale)
            } else {
                Text("· \(display.rows.count) threads")
                Spacer(minLength: 4)
                BundleState(display: display)
            }
        }
        .font(.system(size: 12)).foregroundStyle(Tau.muted).lineLimit(1)
    }
}

/// The right end of the head line for one thread: its clock while it runs, its state otherwise.
struct SingleState: View {
    var thread: WidgetThread
    var stale: Bool
    var body: some View {
        switch thread.state {
        case "running":
            HStack(spacing: 5) {
                Spinner(size: 12, line: 2)
                Elapsed(since: Date(ms: thread.startedAt ?? 0)).font(.system(size: 15, weight: .semibold, design: .monospaced)).foregroundStyle(Tau.infoInk)
                    .multilineTextAlignment(.trailing).frame(width: 64, alignment: .trailing)
            }
        case "waiting": label("questionmark.circle", "Question", Tau.warn)
        case "done": label("checkmark", "Done", Tau.ready)
        default: label("exclamationmark.triangle", "Failed", Tau.failInk)
        }
    }
    func label(_ symbol: String, _ text: String, _ color: Color) -> some View {
        HStack(spacing: 5) { Image(systemName: symbol).font(.system(size: 13, weight: .semibold)); Text(text) }
            .font(.system(size: 13, weight: .semibold)).foregroundStyle(color)
    }
}

/// The right end for several threads: who waits, else how many run, else how they ended.
struct BundleState: View {
    var display: ActivityDisplay
    var body: some View {
        Group {
            if display.waiting > 0 {
                HStack(spacing: 5) { Image(systemName: "questionmark.circle"); Text("\(display.waiting) \(display.waiting == 1 ? "waits" : "wait") for you") }.foregroundStyle(Tau.warn)
            } else if display.running > 0 {
                HStack(spacing: 5) { Spinner(size: 12, line: 2); Text("\(display.running) running") }.foregroundStyle(Tau.infoInk)
            } else if WidgetModel.count(display.rows, "failed") > 0 {
                HStack(spacing: 5) { Image(systemName: "exclamationmark.triangle"); Text("\(WidgetModel.count(display.rows, "failed")) failed") }.foregroundStyle(Tau.failInk)
            } else {
                HStack(spacing: 5) { Image(systemName: "checkmark"); Text("Done") }.foregroundStyle(Tau.ready)
            }
        }
        .font(.system(size: 13, weight: .semibold))
    }
}

struct Callout: View {
    var text: Text
    var background: Color
    var color: Color
    var body: some View {
        text.font(.system(size: 12.5)).foregroundStyle(color).lineLimit(2)
            .padding(.horizontal, 10).padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(background, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    }
}

struct LockScreenActivity: View {
    var display: ActivityDisplay
    var stale: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ActivityHeader(display: display, stale: stale)
            if display.unavailable {
                Text("Open Tau to see your threads").font(.system(size: 15, weight: .semibold)).foregroundStyle(Tau.ink).padding(.top, 8)
            } else if let single = display.single {
                Text(single.title).font(.system(size: 17, weight: .semibold)).foregroundStyle(Tau.ink).lineLimit(2).padding(.top, 8)
                Text(meta(single)).font(.system(size: 12.5)).foregroundStyle(Tau.muted).lineLimit(1).padding(.top, 1)
                callout(single).padding(.top, 9)
            } else {
                VStack(spacing: 6) {
                    ForEach(display.rows) { row in
                        HStack(spacing: 9) {
                            StateIcon(state: row.state)
                            Text(row.title).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Tau.ink).lineLimit(1)
                            Spacer(minLength: 4)
                            RowStatus(thread: row)
                        }
                        .opacity(stale && row.active ? 0.55 : 1)
                    }
                }
                .padding(.top, 8)
                if stale, let updated = display.updated {
                    Callout(text: Text("No update since \(hhmm(updated)) · open Tau to refresh"), background: Tau.track, color: Tau.muted).padding(.top, 9)
                }
            }
        }
        .padding(.horizontal, 15).padding(.top, 14).padding(.bottom, 13)
    }
    /// The reason's first part in bold, as a question's title before its detail.
    func lead(_ text: String, _ separator: String) -> Text {
        guard let range = text.range(of: separator) else { return Text(text).fontWeight(.semibold) }
        return Text(text[..<range.lowerBound]).fontWeight(.semibold) + Text(separator == " — " ? " " : " · ") + Text(text[range.upperBound...])
    }
    func meta(_ thread: WidgetThread) -> String {
        let place = thread.project.map { [$0] } ?? []
        switch thread.state {
        case "done", "failed": return (place + (thread.endedAt.map { ["ended \(hhmm(Date(ms: $0)))"] } ?? [])).joined(separator: " · ")
        default: return (place + (thread.startedAt.map { ["started \(hhmm(Date(ms: $0)))"] } ?? [])).joined(separator: " · ")
        }
    }
    @ViewBuilder func callout(_ thread: WidgetThread) -> some View {
        switch thread.state {
        case "waiting":
            Callout(text: lead(thread.reason ?? "Wants your answer", " — ") + Text(thread.askedAt.map { " · waiting " + coarseAgo(Date(ms: $0), now: .now) } ?? ""), background: Tau.warnChip, color: Tau.warn)
        case "done":
            Callout(text: Text(thread.startedAt.flatMap { start in thread.endedAt.map { "Done in " + duration(($0 - start) / 1000) } } ?? "Done").fontWeight(.semibold) + Text(" · tap to read the reply"), background: Tau.done.opacity(0.14), color: Tau.ready)
        case "failed":
            Callout(text: lead(thread.reason ?? "Failed", " · "), background: Tau.fail.opacity(0.14), color: Tau.failInk)
        default:
            if stale, let updated = display.updated {
                Callout(text: Text("No update since \(hhmm(updated)) · open Tau to refresh"), background: Tau.track, color: Tau.muted)
            }
        }
    }
}

struct RowStatus: View {
    var thread: WidgetThread
    var body: some View {
        switch thread.state {
        case "running":
            Elapsed(since: Date(ms: thread.startedAt ?? 0)).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Tau.infoInk).multilineTextAlignment(.trailing).frame(width: 56, alignment: .trailing)
        case "waiting": Text("Question").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Tau.warn)
        case "done": Text("Done").font(.system(size: 11.5)).foregroundStyle(Tau.ready)
        default: Text("Failed").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Tau.failInk)
        }
    }
}

// MARK: Dynamic Island

/// The leading mark, inset so the island's curve never cuts it.
struct IslandMark: View {
    var size: CGFloat = 21
    var body: some View { TauPlate(size: size).padding(.leading, 2) }
}

struct CompactTrailing: View {
    var display: ActivityDisplay
    var stale: Bool
    var body: some View {
        Group {
            if stale {
                Image(systemName: "clock").font(.system(size: 16, weight: .semibold)).foregroundStyle(.white.opacity(0.5))
            } else if let single = display.single {
                switch single.state {
                case "running":
                    HStack(spacing: 5) {
                        Spinner(size: 13, line: 2, track: Tau.Island.working.opacity(0.3), arc: Tau.Island.working)
                        Elapsed(since: Date(ms: single.startedAt ?? 0)).font(.system(size: 15, weight: .semibold, design: .monospaced)).foregroundStyle(Tau.Island.working)
                            .multilineTextAlignment(.trailing).frame(maxWidth: 52, alignment: .trailing)
                    }
                case "waiting": Image(systemName: "questionmark.circle").font(.system(size: 17, weight: .semibold)).foregroundStyle(Tau.Island.waiting)
                case "done": Image(systemName: "checkmark").font(.system(size: 16, weight: .bold)).foregroundStyle(Tau.Island.done)
                default: Image(systemName: "exclamationmark.triangle").font(.system(size: 15, weight: .semibold)).foregroundStyle(Tau.Island.failed)
                }
            } else {
                HStack(spacing: 6) {
                    if display.waiting > 0 {
                        HStack(spacing: 2) { Image(systemName: "questionmark").font(.system(size: 13, weight: .heavy)); Text("\(display.waiting)") }.foregroundStyle(Tau.Island.waiting)
                    }
                    if display.running > 0 {
                        HStack(spacing: 4) { Spinner(size: 13, line: 2, track: Tau.Island.working.opacity(0.3), arc: Tau.Island.working); Text("\(display.running)") }.foregroundStyle(.white)
                    }
                    if !display.active {
                        let failed = WidgetModel.count(display.rows, "failed")
                        Image(systemName: failed > 0 ? "exclamationmark.triangle" : "checkmark").font(.system(size: 15, weight: .bold)).foregroundStyle(failed > 0 ? Tau.Island.failed : Tau.Island.done)
                    }
                }
                .font(.system(size: 15, weight: .semibold)).monospacedDigit()
            }
        }
        .padding(.trailing, 2)
    }
}

/// Minimal, beside another app's activity: the question in amber, else τ in its ring.
struct MinimalView: View {
    var display: ActivityDisplay
    var stale: Bool
    var body: some View {
        if display.waiting > 0 && !stale {
            Image(systemName: "questionmark.circle").font(.system(size: 17, weight: .semibold)).foregroundStyle(Tau.Island.waiting)
        } else if !display.active {
            Image(systemName: WidgetModel.count(display.rows, "failed") > 0 ? "exclamationmark.triangle" : "checkmark").font(.system(size: 14, weight: .bold))
                .foregroundStyle(WidgetModel.count(display.rows, "failed") > 0 ? Tau.Island.failed : Tau.Island.done)
        } else {
            ZStack {
                Circle().stroke(Tau.Island.working.opacity(0.25), lineWidth: 2.4)
                Circle().trim(from: 0, to: 0.7).stroke(stale ? .white.opacity(0.5) : Tau.Island.working, style: StrokeStyle(lineWidth: 2.4, lineCap: .round)).rotationEffect(.degrees(-90))
                TauGlyph(size: 12).foregroundStyle(stale ? .white.opacity(0.6) : Tau.Island.working)
            }
            .padding(2)
        }
    }
}

struct ExpandedTitle: View {
    var display: ActivityDisplay
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let single = display.single {
                Text(single.title).font(.system(size: 16, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
                HStack(spacing: 4) {
                    if let project = single.project { Text(project); Text("·") }
                    if let machine = display.machine { Machine(name: machine, size: 12) }
                }
                .font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.63)).lineLimit(1)
            } else {
                Text(display.unavailable ? "Tau" : "Tau · \(display.rows.count) threads").font(.system(size: 16, weight: .semibold)).foregroundStyle(.white)
                if let machine = display.machine { Machine(name: machine, size: 12).font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.63)) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ExpandedTrailing: View {
    var display: ActivityDisplay
    var body: some View {
        if let single = display.single {
            switch single.state {
            case "running":
                Elapsed(since: Date(ms: single.startedAt ?? 0)).font(.system(size: 20, weight: .semibold, design: .monospaced)).foregroundStyle(Tau.Island.working)
                    .multilineTextAlignment(.trailing).frame(width: 66, alignment: .trailing)
            case "waiting": Image(systemName: "questionmark.circle").font(.system(size: 26, weight: .semibold)).foregroundStyle(Tau.Island.waiting)
            case "done":
                Text(single.startedAt.flatMap { start in single.endedAt.map { duration(($0 - start) / 1000) } } ?? "")
                    .font(.system(size: 22, weight: .semibold, design: .monospaced)).foregroundStyle(Tau.Island.done)
            default: Image(systemName: "exclamationmark.triangle").font(.system(size: 22, weight: .semibold)).foregroundStyle(Tau.Island.failed)
            }
        }
        // Several threads: the rows below say it all; the expanded island has no height to spare.
    }
}

struct ExpandedBottom: View {
    var display: ActivityDisplay
    var stale: Bool
    var body: some View {
        if let single = display.single {
            VStack(alignment: .leading, spacing: 10) {
                if single.state == "waiting", let reason = single.reason {
                    Text(reason).font(.system(size: 13)).foregroundStyle(Tau.Island.waiting).lineLimit(2)
                }
                HStack {
                    chip(single)
                    Spacer(minLength: 6)
                    Link(destination: display.url ?? URL(string: "tau://hosts")!) {
                        Text(single.state == "waiting" ? "Answer" : single.state == "done" ? "Read reply" : "Open")
                            .font(.system(size: 13.5, weight: .semibold))
                            .foregroundStyle(single.state == "waiting" ? Color(red: 0x2a / 255, green: 0x1f / 255, blue: 0x05 / 255) : .white)
                            .padding(.horizontal, 14).padding(.vertical, 7)
                            .background(single.state == "waiting" ? Tau.Island.waiting : .white.opacity(0.14), in: Capsule())
                    }
                }
            }
            .padding(.top, 4)
        } else {
            VStack(spacing: 5) {
                ForEach(display.rows.prefix(3)) { row in
                    Link(destination: threadURL(host: display.host, thread: row.id) ?? URL(string: "tau://hosts")!) {
                        HStack(spacing: 8) {
                            islandIcon(row.state)
                            Text(row.title).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
                            Spacer(minLength: 4)
                            islandStatus(row)
                        }
                        .opacity(stale && row.active ? 0.55 : 1)
                    }
                }
            }
            .padding(.top, 4)
        }
    }
    @ViewBuilder func chip(_ thread: WidgetThread) -> some View {
        HStack(spacing: 6) {
            islandIcon(thread.state)
            switch thread.state {
            case "running": Text(stale ? "No update · open Tau" : thread.startedAt.map { "Working · started \(hhmm(Date(ms: $0)))" } ?? "Working")
            case "waiting": Text("Question · " + coarseAgo(Date(ms: thread.askedAt ?? thread.startedAt ?? 0), now: .now))
            case "done": Text("Done")
            default: Text("Failed")
            }
        }
        .font(.system(size: 14, weight: .semibold)).foregroundStyle(islandColor(thread.state)).lineLimit(1)
    }
    @ViewBuilder func islandIcon(_ state: String) -> some View {
        switch state {
        case "running": Spinner(size: 13, line: 2, track: Tau.Island.working.opacity(0.3), arc: Tau.Island.working)
        case "waiting": Image(systemName: "questionmark.circle").font(.system(size: 15, weight: .semibold)).foregroundStyle(Tau.Island.waiting)
        case "done": Image(systemName: "checkmark").font(.system(size: 14, weight: .bold)).foregroundStyle(Tau.Island.done)
        default: Image(systemName: "exclamationmark.triangle").font(.system(size: 14, weight: .semibold)).foregroundStyle(Tau.Island.failed)
        }
    }
    @ViewBuilder func islandStatus(_ thread: WidgetThread) -> some View {
        if thread.state == "running" {
            Elapsed(since: Date(ms: thread.startedAt ?? 0)).font(.system(size: 13, design: .monospaced)).foregroundStyle(Tau.Island.working).multilineTextAlignment(.trailing).frame(width: 60, alignment: .trailing)
        } else {
            Text(thread.state == "waiting" ? "Question" : thread.state == "done" ? "Done" : "Failed").font(.system(size: 13, weight: .semibold)).foregroundStyle(islandColor(thread.state))
        }
    }
    func islandColor(_ state: String) -> Color {
        switch state { case "running": Tau.Island.working; case "waiting": Tau.Island.waiting; case "done": Tau.Island.done; default: Tau.Island.failed }
    }
}

struct TauLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TauActivityAttributes.self) { context in
            let display = ActivityDisplay(context.state, context.attributes)
            LockScreenActivity(display: display, stale: context.isStale)
                .activityBackgroundTint(Tau.bg)
                .activitySystemActionForegroundColor(Tau.ink)
                .widgetURL(display.url)
        } dynamicIsland: { context in
            let display = ActivityDisplay(context.state, context.attributes)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { TauPlate(size: 36).padding(.leading, 4).padding(.top, 4) }
                DynamicIslandExpandedRegion(.center) { ExpandedTitle(display: display).padding(.top, 4) }
                DynamicIslandExpandedRegion(.trailing) { ExpandedTrailing(display: display).padding(.trailing, 4).padding(.top, 4) }
                DynamicIslandExpandedRegion(.bottom) { ExpandedBottom(display: display, stale: context.isStale).padding(.horizontal, 4) }
            } compactLeading: {
                IslandMark()
            } compactTrailing: {
                CompactTrailing(display: display, stale: context.isStale)
            } minimal: {
                MinimalView(display: display, stale: context.isStale)
            }
            .widgetURL(display.url)
            .keylineTint(Tau.Island.working)
        }
    }
}
