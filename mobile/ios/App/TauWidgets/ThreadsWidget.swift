import SwiftUI
import WidgetKit

struct ThreadsEntry: TimelineEntry {
    let date: Date
    let threads: [WidgetThread]
    /// When the app last wrote; older than a quarter hour reads as stale.
    let updated: Date?
}

struct ThreadsProvider: TimelineProvider {
    func read(_ date: Date) -> ThreadsEntry {
        let snapshots = SharedSnapshots.threads
        return ThreadsEntry(date: date, threads: WidgetModel.threads(snapshots), updated: snapshots.map { Date(ms: $0.updatedAt) }.max())
    }
    func placeholder(in context: Context) -> ThreadsEntry { ThreadsEntry(date: .now, threads: [], updated: nil) }
    func getSnapshot(in context: Context, completion: @escaping (ThreadsEntry) -> Void) { completion(read(.now)) }
    /// "Done · 6 min" is coarse text: entries a minute apart, then five, keep it right without reloads.
    func getTimeline(in context: Context, completion: @escaping (Timeline<ThreadsEntry>) -> Void) {
        let now = Date()
        let base = read(now)
        let steps = (0...15).map { Double($0) * 60 } + stride(from: 20.0, through: 60, by: 5).map { $0 * 60 }
        completion(Timeline(entries: steps.map { ThreadsEntry(date: now.addingTimeInterval($0), threads: base.threads, updated: base.updated) }, policy: .after(now.addingTimeInterval(3600))))
    }
}

struct ThreadsState {
    let threads: [WidgetThread]
    let updated: Date?
    let now: Date
    var top: WidgetThread? { threads.first }
    var stale: Bool { threads.contains(where: \.active) && (updated.map { now.timeIntervalSince($0) > WidgetModel.staleAfter } ?? false) }
    func count(_ state: String) -> Int { WidgetModel.count(threads, state) }
    /// "1 question · 2 running", the inline and the summary lines.
    var summary: String {
        let parts = [(count("waiting"), count("waiting") == 1 ? "question" : "questions"), (count("running"), "running")].filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }
        if !parts.isEmpty { return parts.joined(separator: " · ") }
        return threads.isEmpty ? "No threads" : "nothing running"
    }
    var ended: String { [(count("done"), "done"), (count("failed"), "failed")].filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }.joined(separator: " · ") }
    func status(_ thread: WidgetThread) -> String {
        switch thread.state {
        case "waiting": "Question"
        case "done": "Done · " + (thread.endedAt.map { coarseAgo(Date(ms: $0), now: now) } ?? "")
        case "failed": "Failed · " + (thread.endedAt.map { coarseAgo(Date(ms: $0), now: now) } ?? "")
        default: ""
        }
    }
}

struct ThreadsView: View {
    @Environment(\.widgetFamily) var family
    var entry: ThreadsEntry
    var body: some View {
        let state = ThreadsState(threads: entry.threads, updated: entry.updated, now: entry.date)
        Group {
            switch family {
            case .accessoryInline: ThreadsInline(state: state)
            case .accessoryRectangular: ThreadsRectangular(state: state)
            case .accessoryCircular: ThreadsCircular(state: state)
            default:
                if entry.threads.isEmpty { EmptyWidget(title: "No threads yet", detail: "Threads at work on your machines show here.") }
                else if family == .systemMedium { ThreadsMedium(state: state).padding(.horizontal, 15).padding(.top, 13).padding(.bottom, 8) }
                else { ThreadsSmall(state: state).padding(15) }
            }
        }
        .widgetURL(family == .systemMedium ? nil : threadURL(host: state.top?.hostId, thread: state.top?.id))
    }
}

/// The thread's project and machine: "shop-api · 🖥 MacBook".
struct ThreadPlace: View {
    var thread: WidgetThread
    var body: some View {
        HStack(spacing: 4) {
            if let project = thread.project { Text(project) }
            if thread.project != nil && thread.machine != nil { Text("·") }
            if let machine = thread.machine { Machine(name: machine) }
        }
        .lineLimit(1)
    }
}

struct ThreadStatus: View {
    var state: ThreadsState
    var thread: WidgetThread
    var body: some View {
        if thread.state == "running", let started = thread.startedAt {
            Elapsed(since: Date(ms: started)).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Tau.infoInk).multilineTextAlignment(.trailing).frame(width: 56, alignment: .trailing)
        } else {
            Text(state.status(thread)).font(.system(size: 11.5, weight: thread.state == "done" ? .regular : .semibold)).foregroundStyle(stateColor(thread.state)).monospacedDigit()
        }
    }
}

struct ThreadRow: View {
    var state: ThreadsState
    var thread: WidgetThread
    var body: some View {
        HStack(spacing: 9) {
            StateIcon(state: thread.state)
            VStack(alignment: .leading, spacing: 0) {
                Text(thread.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Tau.ink).lineLimit(1)
                ThreadPlace(thread: thread).font(.system(size: 11)).foregroundStyle(Tau.muted)
            }
            Spacer(minLength: 4)
            ThreadStatus(state: state, thread: thread)
        }
        .padding(.vertical, 5)
        .opacity(state.stale && thread.active ? 0.55 : 1)
    }
}

struct ThreadsSmall: View {
    var state: ThreadsState
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            WidgetHeader(title: "Threads") { if state.stale, let updated = state.updated { StaleAge(date: updated, now: state.now) } }
            if let top = state.top {
                HStack(spacing: 5) {
                    StateIcon(state: top.state)
                    switch top.state {
                    case "running": Text("Running · ") + Text(timerInterval: Date(ms: top.startedAt ?? 0)...Date.distantFuture, countsDown: false)
                    case "waiting": Text("Question · " + coarseAgo(Date(ms: top.askedAt ?? top.startedAt ?? 0), now: state.now))
                    default: Text(state.status(top))
                    }
                }
                .font(.system(size: 12, weight: .semibold)).foregroundStyle(stateColor(top.state)).lineLimit(1).monospacedDigit()
                .padding(.top, 12)
                Text(top.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Tau.ink).lineLimit(2).lineSpacing(0).padding(.top, 5)
                ThreadPlace(thread: top).font(.system(size: 11.5)).foregroundStyle(Tau.muted).padding(.top, 3)
                Spacer(minLength: 0)
                more(top)
            }
        }
        .opacity(state.stale ? 0.7 : 1)
    }
    @ViewBuilder func more(_ top: WidgetThread) -> some View {
        let running = state.count("running") - (top.state == "running" ? 1 : 0)
        let waiting = state.count("waiting") - (top.state == "waiting" ? 1 : 0)
        if waiting > 0 {
            HStack(spacing: 4) { StateIcon(state: "waiting", size: 14); Text("\(waiting) more \(waiting == 1 ? "question" : "questions")") }
                .font(.system(size: 12, weight: .semibold)).foregroundStyle(Tau.warn)
        } else if running > 0 {
            HStack(spacing: 4) { Spinner(size: 10); Text("\(running) more running") }.font(.system(size: 12, weight: .semibold)).foregroundStyle(Tau.infoInk)
        } else if !state.ended.isEmpty && top.active {
            Text(state.ended).font(.system(size: 12, weight: .semibold)).foregroundStyle(Tau.muted)
        }
    }
}

struct StaleAge: View {
    var date: Date
    var now: Date
    var body: some View {
        HStack(spacing: 3) { Image(systemName: "clock").font(.system(size: 11, weight: .semibold)); Ago(date: date, now: now) }
            .font(.system(size: 12, weight: .semibold)).foregroundStyle(Tau.warn)
    }
}

struct ThreadsMedium: View {
    var state: ThreadsState
    var body: some View {
        let quiet = !state.threads.contains(where: \.active)
        VStack(alignment: .leading, spacing: 0) {
            WidgetHeader(title: "Threads") {
                if state.stale, let updated = state.updated { StaleAge(date: updated, now: state.now) }
                else if quiet { Text("nothing running").font(.system(size: 12)).foregroundStyle(Tau.faint) }
                else { endedCounts }
            }
            if quiet {
                Spacer(minLength: 0)
                rows(Array(state.threads.prefix(2)))
                Spacer(minLength: 0)
                if let last = state.threads.compactMap(\.endedAt).max() {
                    Text("Last run ended \(hhmm(Date(ms: last)))").font(.system(size: 10.5)).foregroundStyle(Tau.faint)
                }
            } else {
                rows(Array(state.threads.prefix(3))).padding(.top, 3)
                Spacer(minLength: 0)
            }
        }
    }
    var endedCounts: some View {
        let done = state.count("done"), failed = state.count("failed")
        return HStack(spacing: 0) {
            if done > 0 { Text("\(done) done").foregroundStyle(Tau.ready) }
            if done > 0 && failed > 0 { Text(" · ").foregroundStyle(Tau.faint) }
            if failed > 0 { Text("\(failed) failed").fontWeight(.semibold).foregroundStyle(Tau.failInk) }
        }
        .font(.system(size: 12))
    }
    func rows(_ threads: [WidgetThread]) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(threads.enumerated()), id: \.element.id) { index, thread in
                if index > 0 { Rectangle().fill(Tau.lineSoft).frame(height: 1) }
                Link(destination: threadURL(host: thread.hostId, thread: thread.id) ?? URL(string: "tau://hosts")!) { ThreadRow(state: state, thread: thread) }
            }
        }
    }
}

// Lock screen, drawn monochrome by iOS.
struct ThreadsInline: View {
    var state: ThreadsState
    var body: some View {
        Label { Text(state.summary) } icon: { Image("tau-glyph").renderingMode(.template) }
    }
}

struct ThreadsRectangular: View {
    var state: ThreadsState
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) { TauGlyph(size: 12); Text("Threads").font(.system(size: 12.5, weight: .bold)) }
            if let top = state.top {
                HStack(spacing: 4) {
                    Image(systemName: top.state == "waiting" ? "questionmark.circle" : top.state == "running" ? "circle.dotted" : top.state == "done" ? "checkmark.circle" : "exclamationmark.triangle")
                        .font(.system(size: 12, weight: .semibold))
                    Text(top.title)
                }
                .font(.system(size: 12, weight: .medium)).lineLimit(1)
                Text(rest(top)).font(.system(size: 12)).opacity(0.75).lineLimit(1)
            } else {
                Text("No threads").font(.system(size: 12, weight: .medium))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    func rest(_ top: WidgetThread) -> String {
        let running = state.count("running") - (top.state == "running" ? 1 : 0)
        let waiting = state.count("waiting") - (top.state == "waiting" ? 1 : 0)
        let parts = [(waiting, "waiting"), (running, "running"), (state.count("done") - (top.state == "done" ? 1 : 0), "done"), (state.count("failed") - (top.state == "failed" ? 1 : 0), "failed")]
            .filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }
        return parts.isEmpty ? (top.project ?? "") : parts.prefix(2).joined(separator: " · ")
    }
}

struct ThreadsCircular: View {
    var state: ThreadsState
    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 2) {
                if state.count("waiting") > 0 {
                    Image(systemName: "questionmark.circle").font(.system(size: 22, weight: .semibold))
                    Text("\(state.count("waiting")) waits").font(.system(size: 11, weight: .semibold))
                } else if state.count("running") > 0 {
                    TauGlyph(size: 18)
                    Text("\(state.count("running")) running").font(.system(size: 10, weight: .semibold)).minimumScaleFactor(0.7)
                } else {
                    TauGlyph(size: 18)
                    Text(state.threads.isEmpty ? "idle" : "done").font(.system(size: 11, weight: .semibold))
                }
            }
            .padding(.horizontal, 6)
        }
    }
}

struct ThreadsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetKind.threads, provider: ThreadsProvider()) { entry in
            ThreadsView(entry: entry).containerBackground(for: .widget) { Tau.bg }
        }
        .configurationDisplayName("Threads")
        .description("Questions waiting for you, threads at work and what just finished.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryInline, .accessoryRectangular, .accessoryCircular])
        .contentMarginsDisabled()
    }
}
