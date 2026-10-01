import ActivityKit
import SwiftUI
import WidgetKit

// Debug harness: writes the App Group through the real MobileActivityStore, the way the
// Capacitor plugin does, and draws every widget view at its real size (`-gallery <page>`).
@main struct HarnessApp: App {
    @State private var log = "starting"
    let page = argument("-gallery")
    var body: some Scene {
        WindowGroup {
            if let page {
                Gallery(page: page).statusBarHidden().preferredColorScheme(argument("-scheme") == "dark" ? .dark : .light)
            } else {
                Text(log).accessibilityIdentifier("log").padding()
                    .task { log = await run(ProcessInfo.processInfo.arguments) }
            }
        }
    }
}

func argument(_ name: String) -> String? {
    let args = ProcessInfo.processInfo.arguments
    return args.firstIndex(of: name).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
}

// MARK: Sample data, as in the mocks

let now = Date()
let ms = { (offset: TimeInterval) in (now.timeIntervalSince1970 + offset) * 1000 }
let minute: TimeInterval = 60, hour: TimeInterval = 3600, day: TimeInterval = 86400

func window(_ label: String, _ short: String, used: Double, resets: TimeInterval, level: String? = nil, pace: String? = "on", paceAt: TimeInterval? = nil) -> UsageWindow {
    UsageWindow(label: label, short: short, usedPercent: used, resetsAt: ms(resets), level: level, pace: pace, paceAt: paceAt.map(ms))
}

enum Sample {
    static func usage(_ state: String) -> [UsageSnapshot] {
        if state == "empty" { return [] }
        let age: TimeInterval = state == "stale" ? -2 * hour : -3 * minute
        let codex = UsageAccount(poolKey: "openai:k1", label: "Codex", plan: "ChatGPT Plus", tone: "openai", mark: "codex", checkedAt: ms(age), windows: [
            window("5-hour", "5h", used: 34, resets: 2 * hour), window("Weekly", "wk", used: 91, resets: 2 * day + hour, level: "warn", pace: "runs-out", paceAt: day + 3 * hour)])
        var claude = UsageAccount(poolKey: "anthropic:k2", label: "Claude Code", plan: "Max", tone: "anthropic", mark: "claude-code", checkedAt: ms(age + 60), windows: [
            window("5-hour", "5h", used: 12, resets: hour), window("Weekly", "wk", used: 47, resets: 5 * day)])
        if state == "spent" { claude.windows[0] = window("5-hour", "5h", used: 100, resets: hour, level: "fail", pace: "spent") }
        let opencode = UsageAccount(label: "OpenCode Go", tone: "other", mark: "opencode", checkedAt: ms(age), windows: [window("Monthly", "mo", used: 22, resets: 31 * day)])
        var older = claude; older.checkedAt = ms(age - 10 * minute)
        return [UsageSnapshot(hostId: "mac-mini", machine: "Mac mini", updatedAt: ms(age), accounts: [codex, claude, opencode]),
                UsageSnapshot(hostId: "macbook", machine: "MacBook", updatedAt: ms(age), accounts: [older])]
    }

    static let pagination = WidgetThread(id: "t-pagination", title: "Add pagination to all list endpoints", project: "shop-api", state: "waiting", startedAt: ms(-10 * minute), askedAt: ms(-4 * minute), reason: "Wants to edit src/routes/orders.ts")
    static let flaky = WidgetThread(id: "t-flaky", title: "Fix flaky pairing test", project: "tau", state: "running", startedAt: ms(-(12 * minute + 4)))
    static let rate = WidgetThread(id: "t-rate", title: "Rate limiting for checkout endpoint", project: "shop-api", state: "running", startedAt: ms(-(3 * minute + 41)))
    static let audit = WidgetThread(id: "t-audit", title: "Nightly dependency audit", project: "tau", state: "done", startedAt: ms(-40 * minute), endedAt: ms(-6 * minute))
    static let migrate = WidgetThread(id: "t-migrate", title: "Migrate CI cache to R2", project: "infra", state: "failed", startedAt: ms(-35 * minute), endedAt: ms(-20 * minute), reason: "Rate limited · Codex 5-hour, resets 16:40")

    static func threads(_ state: String) -> [ThreadsSnapshot] {
        switch state {
        case "empty": return []
        case "quiet":
            var flakyDone = flaky; flakyDone.state = "done"; flakyDone.endedAt = ms(-hour)
            return [ThreadsSnapshot(hostId: "hetzner-1", machine: "hetzner-1", updatedAt: ms(0), threads: [audit]),
                    ThreadsSnapshot(hostId: "mac-mini", machine: "Mac mini", updatedAt: ms(0), threads: [flakyDone])]
        default:
            let at = state == "stale" ? ms(-40 * minute) : ms(0)
            return [ThreadsSnapshot(hostId: "macbook", machine: "MacBook", updatedAt: at, threads: [pagination]),
                    ThreadsSnapshot(hostId: "mac-mini", machine: "Mac mini", updatedAt: at, threads: [flaky, rate, migrate]),
                    ThreadsSnapshot(hostId: "hetzner-1", machine: "hetzner-1", updatedAt: at, threads: [audit])]
        }
    }

    /// The two samples as the app writes them: one snapshot per host.
    static func snapshots(_ state: String) -> [WidgetSnapshot] {
        var hosts: [String: WidgetSnapshot] = [:]
        for usage in self.usage(state) { hosts[usage.hostId] = WidgetSnapshot(hostId: usage.hostId, machine: usage.machine, updatedAt: usage.updatedAt ?? ms(0), accounts: usage.accounts) }
        for threads in self.threads(state) {
            var snapshot = hosts[threads.hostId] ?? WidgetSnapshot(hostId: threads.hostId, machine: threads.machine, updatedAt: threads.updatedAt)
            snapshot.threads = threads.threads
            hosts[threads.hostId] = snapshot
        }
        return hosts.values.sorted { $0.hostId < $1.hostId }
    }

    /// One host's Live Activity rows for a named state.
    static func activity(_ name: String) -> (machine: String, rows: [WidgetThread]) {
        switch name {
        case "waiting": return ("MacBook", [pagination])
        case "done":
            var done = flaky; done.state = "done"; done.startedAt = ms(-(14 * minute + 32) - minute); done.endedAt = ms(-minute)
            return ("Mac mini", [done])
        case "failed":
            var failed = migrate; failed.endedAt = ms(-minute)
            return ("Mac mini", [failed])
        case "bundle": return ("Mac mini", [pagination, flaky, rate])
        case "bundle-done":
            var done = flaky; done.state = "done"; done.endedAt = ms(-minute)
            var failed = migrate; failed.endedAt = ms(-minute)
            return ("Mac mini", [failed, done])
        default: return ("Mac mini", [flaky])
        }
    }
}

// MARK: Scenarios for the real SpringBoard

func run(_ args: [String]) async -> String {
    var done: [String] = []
    let defaults = UserDefaults(suiteName: MobileActivityStore.group)
    if let scenario = argument("-scenario") {
        for key in defaults?.dictionaryRepresentation().keys.map({ $0 }) ?? [] where key.hasPrefix("widget.") { defaults?.removeObject(forKey: key) }
        for snapshot in Sample.snapshots(scenario) { defaults?.set(try? JSONEncoder().encode(snapshot), forKey: "widget." + snapshot.hostId) }
        WidgetCenter.shared.reloadAllTimelines()
        done.append("scenario=\(scenario)")
    }
    if args.contains("-end") {
        for activity in Activity<TauActivityAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
        done.append("ended")
    }
    // -activity <state>: the Mac mini's Live Activity, through MobileActivityStore.snapshot like the app.
    if let state = argument("-activity") {
        let sample = Sample.activity(state)
        if state == "done" || state == "failed" || state == "bundle-done" {
            // An activity ends from a running one, as in the app.
            await write(machine: sample.machine, rows: [Sample.flaky])
        }
        await write(machine: sample.machine, rows: sample.rows)
        if state == "stale", let activity = Activity<TauActivityAttributes>.activities.first {
            await activity.update(ActivityContent(state: activity.content.state, staleDate: Date().addingTimeInterval(2)))
        }
        done.append("activity=\(state)")
    }
    return "ready " + done.joined(separator: " ") + " activities=\(Activity<TauActivityAttributes>.activities.count)"
}

func write(machine: String, rows: [WidgetThread]) async {
    let snapshot = WidgetSnapshot(hostId: "mac-mini", machine: machine, updatedAt: Date().timeIntervalSince1970 * 1000, threads: rows)
    guard let data = try? JSONEncoder().encode(snapshot), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
    await MobileActivityStore.snapshot(object) { _ in }
}

// MARK: Gallery

struct WidgetFrame<Content: View>: View {
    var width: CGFloat
    var height: CGFloat
    @ViewBuilder var content: Content
    var body: some View {
        content.frame(width: width, height: height)
            .background(Tau.bg)
            .clipShape(RoundedRectangle(cornerRadius: 23, style: .continuous))
            .shadow(color: .black.opacity(0.1), radius: 5, y: 2)
    }
}

struct Wallpaper: View {
    @Environment(\.colorScheme) var scheme
    var body: some View {
        LinearGradient(colors: scheme == .dark ? [Color(hex: 0x2a3150), Color(hex: 0x1e2340), Color(hex: 0x11131f)] : [Color(hex: 0xefe3d3), Color(hex: 0xdcc2a3), Color(hex: 0xb98d68)],
                       startPoint: .topLeading, endPoint: .bottomTrailing).ignoresSafeArea()
    }
}

extension Color {
    init(hex: UInt32) { self.init(red: Double(hex >> 16 & 0xff) / 255, green: Double(hex >> 8 & 0xff) / 255, blue: Double(hex & 0xff) / 255) }
}

struct Caption: View {
    var text: String
    var body: some View { Text(text).font(.system(size: 10.5, weight: .medium)).foregroundStyle(.primary.opacity(0.7)) }
}

struct Gallery: View {
    @Environment(\.colorScheme) var scheme
    var page: String
    func plan(_ state: String) -> PlanState { PlanState(accounts: WidgetModel.merge(Sample.usage(state)), now: now) }
    func threads(_ state: String) -> ThreadsState {
        let snapshots = Sample.threads(state)
        return ThreadsState(threads: WidgetModel.threads(snapshots), updated: snapshots.map { Date(ms: $0.updatedAt) }.max(), now: now)
    }
    func display(_ name: String) -> ActivityDisplay {
        let sample = Sample.activity(name)
        var display = ActivityDisplay(TauActivityAttributes.ContentState(threads: sample.rows, updatedAt: ms(-14 * minute)), TauActivityAttributes(hostId: "mac-mini", threadId: MobileActivityStore.bundleThread))
        display.machine = sample.machine
        return display
    }
    var body: some View {
        ZStack(alignment: .top) {
            Wallpaper()
            VStack(spacing: 10) { content }.padding(.top, 14)
        }
    }
    @ViewBuilder var content: some View {
        switch page {
        case "usage":
            Caption(text: "Plan limits · small · medium · large")
            WidgetFrame(width: 170, height: 170) { PlanSmall(state: plan("normal")).padding(15) }
            WidgetFrame(width: 364, height: 170) { PlanMedium(state: plan("normal")).padding(15) }
            WidgetFrame(width: 364, height: 382) { PlanLarge(state: plan("normal")).padding(15) }
        case "states":
            Caption(text: "Plan limits · spent · stale · empty")
            HStack(spacing: 22) {
                WidgetFrame(width: 170, height: 170) { PlanSmall(state: plan("spent")).padding(15) }
                WidgetFrame(width: 170, height: 170) { PlanSmall(state: plan("stale")).padding(15) }
            }
            HStack(spacing: 22) {
                WidgetFrame(width: 170, height: 170) { EmptyWidget(title: "No plan limits yet", detail: "Open Tau once with a paired machine.") }
                WidgetFrame(width: 170, height: 170) { EmptyWidget(title: "No threads yet", detail: "Threads at work on your machines show here.") }
            }
            WidgetFrame(width: 364, height: 170) { PlanMedium(state: plan("stale")).padding(15) }
            WidgetFrame(width: 364, height: 170) { EmptyWidget(title: "No plan limits yet", detail: "Open Tau once with a paired machine.") }
        case "large-states":
            Caption(text: "Plan limits large · spent · stale")
            WidgetFrame(width: 364, height: 382) { PlanLarge(state: plan("spent")).padding(15) }
            WidgetFrame(width: 364, height: 382) { PlanLarge(state: plan("stale")).padding(15) }
        case "threads":
            Caption(text: "Threads · small · medium · quiet · stale")
            HStack(spacing: 22) {
                WidgetFrame(width: 170, height: 170) { ThreadsSmall(state: threads("normal")).padding(15) }
                WidgetFrame(width: 170, height: 170) { ThreadsSmall(state: ThreadsState(threads: [Sample.flaky, Sample.rate, Sample.audit], updated: now, now: now)).padding(15) }
            }
            WidgetFrame(width: 364, height: 170) { ThreadsMedium(state: threads("normal")).padding(.horizontal, 15).padding(.top, 13).padding(.bottom, 8) }
            WidgetFrame(width: 364, height: 170) { ThreadsMedium(state: threads("quiet")).padding(.horizontal, 15).padding(.top, 13).padding(.bottom, 8) }
            WidgetFrame(width: 364, height: 170) { ThreadsMedium(state: threads("stale")).padding(.horizontal, 15).padding(.top, 13).padding(.bottom, 8) }
        case "lock":
            LockScreen(plan: plan("normal"), threads: threads("normal"), dark: scheme == .dark)
        case "live":
            Caption(text: "Live Activity · one thread: running · question · done")
            card(display("running"), stale: false)
            card(display("waiting"), stale: false)
            card(display("done"), stale: false)
        case "live2":
            Caption(text: "Live Activity · failed · stale · all threads · all ended")
            card(display("failed"), stale: false)
            card(display("running"), stale: true)
            card(display("bundle"), stale: false)
            card(display("bundle-done"), stale: false)
        case "island":
            Caption(text: "Dynamic Island · compact · minimal")
            compact(display("bundle"))
            compact(display("running"))
            compact(display("waiting"))
            compact(display("done"))
            compact(display("failed"))
            compact(display("running"), stale: true)
            HStack(spacing: 7) { compact(display("waiting")); minimal(display("running")) }
            minimalRow
        case "island2":
            Caption(text: "Dynamic Island · expanded")
            expanded(display("running"))
            expanded(display("waiting"))
            expanded(display("done"))
            expanded(display("bundle"))
        default:
            Text("pages: usage, states, large-states, threads, lock, live, live2, island, island2")
        }
    }
    func card(_ display: ActivityDisplay, stale: Bool) -> some View {
        LockScreenActivity(display: display, stale: stale).frame(width: 364).background(Tau.bg)
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous)).shadow(color: .black.opacity(0.15), radius: 6, y: 2)
    }
    func compact(_ display: ActivityDisplay, stale: Bool = false) -> some View {
        HStack(spacing: 0) {
            IslandMark().padding(.leading, 9)
            Spacer(minLength: 126)
            CompactTrailing(display: display, stale: stale).padding(.trailing, 10)
        }
        .frame(height: 37).fixedSize().background(.black, in: Capsule()).environment(\.colorScheme, .dark)
    }
    func minimal(_ display: ActivityDisplay) -> some View {
        MinimalView(display: display, stale: false).frame(width: 37, height: 37).background(.black, in: Circle()).environment(\.colorScheme, .dark)
    }
    var minimalRow: some View {
        HStack(spacing: 12) {
            minimal(display("running")); minimal(display("waiting")); minimal(display("done")); minimal(display("failed"))
        }
    }
    func expanded(_ display: ActivityDisplay) -> some View {
        VStack(spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                TauPlate(size: 36).padding(.leading, 4).padding(.top, 4)
                ExpandedTitle(display: display).padding(.top, 4)
                ExpandedTrailing(display: display).padding(.trailing, 4).padding(.top, 4)
            }
            ExpandedBottom(display: display, stale: false).padding(.horizontal, 4)
        }
        .padding(.horizontal, 16).padding(.vertical, 14).frame(width: 380)
        .background(.black, in: RoundedRectangle(cornerRadius: 44, style: .continuous)).environment(\.colorScheme, .dark)
    }
}

/// The lock screen as iOS draws accessories there: white on the wallpaper, no colour.
struct LockScreen: View {
    var plan: PlanState
    var threads: ThreadsState
    var dark: Bool
    var body: some View {
        VStack(spacing: 4) {
            ThreadsInline(state: threads).font(.system(size: 17, weight: .semibold)).labelStyle(InlineLabel())
            Text(Date.now, format: .dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)).font(.system(size: 92, weight: .bold, design: .rounded))
            HStack(spacing: 12) {
                tile { PlanRectangular(state: plan) }
                tile { ThreadsRectangular(state: threads) }
            }
            HStack(spacing: 12) {
                PlanCircular(state: plan).frame(width: 72, height: 72)
                ThreadsCircular(state: threads).frame(width: 72, height: 72)
                PlanCircular(state: PlanState(accounts: WidgetModel.merge(Sample.usage("spent")), now: now)).frame(width: 72, height: 72)
            }
            .padding(.top, 8)
        }
        .foregroundStyle(.white)
        .padding(.top, 50).padding(.bottom, 30)
        .frame(width: 402)
        .background(LockWallpaper(dark: dark))
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .environment(\.colorScheme, .dark)
    }
    func tile<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content().padding(.horizontal, 10).padding(.vertical, 7).frame(width: 172, height: 72, alignment: .topLeading)
            .background(.white.opacity(0.18), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// The mocks' lock-screen wallpapers.
struct LockWallpaper: View {
    var dark: Bool
    var body: some View {
        LinearGradient(colors: !dark ? [Color(hex: 0xe4c7a4), Color(hex: 0xc08f67), Color(hex: 0x8d5f42)] : [Color(hex: 0x31395e), Color(hex: 0x1b1f38), Color(hex: 0x0b0d17)], startPoint: .top, endPoint: .bottom)
    }
}

struct InlineLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 5) { configuration.icon; configuration.title }
    }
}
