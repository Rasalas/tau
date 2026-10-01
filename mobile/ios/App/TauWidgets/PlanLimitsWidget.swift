import SwiftUI
import WidgetKit

struct PlanEntry: TimelineEntry {
    let date: Date
    let accounts: [PlanAccount]
}

struct PlanProvider: TimelineProvider {
    func placeholder(in context: Context) -> PlanEntry { PlanEntry(date: .now, accounts: []) }
    func getSnapshot(in context: Context, completion: @escaping (PlanEntry) -> Void) { completion(PlanEntry(date: .now, accounts: WidgetModel.merge(SharedSnapshots.usage))) }
    /// Entries for the reading's age as it grows, and at each moment the drawing changes on its own:
    /// a reading turns old, a window resets. Entries cost no reloads.
    func getTimeline(in context: Context, completion: @escaping (Timeline<PlanEntry>) -> Void) {
        let accounts = WidgetModel.merge(SharedSnapshots.usage)
        let now = Date()
        let steps = (1...15).map { Double($0) * 60 } + stride(from: 20.0, through: 60, by: 5).map { $0 * 60 } + stride(from: 75.0, through: 180, by: 15).map { $0 * 60 }
        let base = WidgetModel.newest(accounts) ?? now
        let ages = steps.map { base.addingTimeInterval($0) }.filter { $0 > now }
        let dates = Set([now] + ages + WidgetModel.changes(accounts, now: now)).sorted()
        completion(Timeline(entries: dates.map { PlanEntry(date: $0, accounts: accounts) }, policy: .after(now.addingTimeInterval(3 * 3600))))
    }
}

/// What every size needs: the accounts, the lowest window, and how old the readings are.
struct PlanState {
    let accounts: [PlanAccount]
    let now: Date
    var lowest: (account: PlanAccount, window: UsageWindow)? { WidgetModel.lowest(accounts, now: now) }
    var newest: Date? { WidgetModel.newest(accounts) }
    /// Old once the freshest reading is.
    var stale: Bool { newest.map { now.timeIntervalSince($0) > WidgetModel.staleAfter } ?? false }
    var host: String? { accounts.max { $0.account.checkedAt < $1.account.checkedAt }?.hostId }
    func stale(_ account: PlanAccount) -> Bool { WidgetModel.stale(account, now: now) }
    func level(_ account: PlanAccount, _ window: UsageWindow) -> Level { windowLevel(window, stale: stale(account), now: now) }
    /// "Codex weekly", "Claude 5-hour".
    func name(_ account: PlanAccount, _ window: UsageWindow) -> String { "\(account.account.label.split(separator: " ").first.map(String.init) ?? account.account.label) \(window.label.lowercased())" }
}

struct PlanLimitsView: View {
    @Environment(\.widgetFamily) var family
    var entry: PlanEntry
    var body: some View {
        let state = PlanState(accounts: entry.accounts, now: entry.date)
        Group {
            if entry.accounts.isEmpty {
                switch family {
                case .accessoryRectangular, .accessoryCircular, .accessoryInline: PlanAccessoryEmpty()
                default: EmptyWidget(title: "No plan limits yet", detail: "Open Tau once with a paired machine.")
                }
            } else {
                switch family {
                case .systemMedium: PlanMedium(state: state).padding(15)
                case .systemLarge: PlanLarge(state: state).padding(15)
                case .accessoryRectangular: PlanRectangular(state: state)
                case .accessoryCircular: PlanCircular(state: state)
                default: PlanSmall(state: state).padding(15)
                }
            }
        }
        .widgetURL(usageURL(host: state.host))
    }
}

/// How old the readings are: quiet while fresh, the warn colour with a clock once old.
struct PlanAge: View {
    var state: PlanState
    var long: Bool
    var body: some View {
        if let newest = state.newest {
            if state.stale {
                // The small widget has room for the age alone.
                HStack(spacing: 3) { Image(systemName: "clock").font(.system(size: 11, weight: .semibold)); Ago(date: newest, now: state.now, suffix: long) }
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(Tau.warn)
            } else if long {
                HStack(spacing: 0) { Text("as of \(hhmm(newest)) · "); Ago(date: newest, now: state.now) }.font(.system(size: 12)).foregroundStyle(Tau.faint).lineLimit(1)
            } else {
                Ago(date: newest, now: state.now, suffix: false).font(.system(size: 12)).foregroundStyle(Tau.faint).monospacedDigit()
            }
        }
    }
}

/// The accounts' juicebars, grouped per account, the mark beneath.
struct BarGroups: View {
    var state: PlanState
    var accounts: [PlanAccount]
    var width: CGFloat, height: CGFloat, groupGap: CGFloat, barGap: CGFloat
    var marks = true
    var mono = false
    var body: some View {
        HStack(alignment: .bottom, spacing: groupGap) {
            ForEach(accounts, id: \.self) { account in
                VStack(spacing: 6) {
                    HStack(alignment: .bottom, spacing: barGap) {
                        ForEach(account.account.windows, id: \.self) { window in
                            Juicebar(left: WidgetModel.expired(window, now: state.now) ? 0 : window.left, tone: mono ? .primary : Tau.tone(account.account.tone),
                                     level: mono ? .normal : state.level(account, window), width: width, height: height, radius: mono ? 2 : 2.5, track: mono ? .primary.opacity(0.3) : Tau.track)
                        }
                    }
                    if marks { ProviderMark(mark: account.account.mark, tone: account.account.tone) }
                }
            }
        }
    }
}

struct PlanSmall: View {
    var state: PlanState
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            WidgetHeader(title: "Plan limits") { PlanAge(state: state, long: false) }
            BarGroups(state: state, accounts: Array(state.accounts.prefix(4)), width: 9, height: 48, groupGap: 13, barGap: 3)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if let low = state.lowest {
                let level = state.level(low.account, low.window)
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text("\(low.window.left)%").font(.system(size: 26, weight: .bold)).kerning(-0.5).foregroundStyle(level.text).monospacedDigit()
                    Text("left").font(.system(size: 13, weight: .semibold)).foregroundStyle(Tau.muted)
                }
                (Text(state.name(low.account, low.window)).fontWeight(.semibold).foregroundColor(Tau.ink2)
                    + Text(low.window.resetDate.map { " · " + until($0, now: state.now) } ?? ""))
                    .font(.system(size: 11.5)).foregroundStyle(Tau.muted).lineLimit(1).padding(.top, 3)
            }
        }
    }
}

struct PlanMedium: View {
    var state: PlanState
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            WidgetHeader(title: "Plan limits") {
                if state.stale { PlanAge(state: state, long: true) }
                else if let newest = state.newest { Text("as of \(hhmm(newest))").font(.system(size: 12)).foregroundStyle(Tau.faint) }
            }
            VStack(spacing: 0) {
                ForEach(Array(state.accounts.prefix(3)), id: \.self) { account in
                    Spacer(minLength: 0)
                    HStack(spacing: 9) {
                        ProviderMark(mark: account.account.mark, tone: account.account.tone, size: 16)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(account.account.label).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Tau.ink).lineLimit(1)
                            Text(account.account.plan ?? " ").font(.system(size: 10.5)).foregroundStyle(Tau.muted).lineLimit(1)
                        }
                        .frame(width: 92, alignment: .leading)
                        cell(account, account.account.windows.first)
                        cell(account, account.account.windows.dropFirst().first)
                    }
                    Spacer(minLength: 0)
                }
            }
            .padding(.top, 4)
        }
    }
    @ViewBuilder func cell(_ account: PlanAccount, _ window: UsageWindow?) -> some View {
        if let window {
            let level = state.level(account, window)
            VStack(spacing: 3) {
                HStack(spacing: 2) {
                    Text("\(window.short ?? window.label) · \(window.resetDate.map { until($0, now: state.now) } ?? "")").foregroundStyle(Tau.muted)
                    Spacer(minLength: 2)
                    Text(level == .stale ? "–" : "\(window.left)%").fontWeight(.semibold).foregroundStyle(level.text).monospacedDigit()
                }
                .font(.system(size: 11)).lineLimit(1).minimumScaleFactor(0.85)
                Track(left: WidgetModel.expired(window, now: state.now) ? 0 : window.left, tone: Tau.tone(account.account.tone), level: level)
            }
            .frame(maxWidth: .infinity)
        } else {
            Color.clear.frame(maxWidth: .infinity, maxHeight: 1)
        }
    }
}

struct PlanLarge: View {
    var state: PlanState
    /// Accounts while they fit: a head line and three lines per window.
    var shown: [PlanAccount] {
        var room: CGFloat = 382 - 30 - 15 - 10, result: [PlanAccount] = []
        for account in state.accounts {
            let need = 16 + CGFloat(account.account.windows.count) * 43 + (result.isEmpty ? 0 : 18)
            if need > room { break }
            room -= need; result.append(account)
        }
        return result
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            WidgetHeader(title: "Plan limits") { PlanAge(state: state, long: true) }
            VStack(alignment: .leading, spacing: 9) {
                ForEach(Array(shown.enumerated()), id: \.element) { index, account in
                    if index > 0 { Rectangle().fill(Tau.lineSoft).frame(height: 1) }
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 6) {
                            ProviderMark(mark: account.account.mark, tone: account.account.tone)
                            Text(account.account.label).font(.system(size: 13, weight: .semibold)).foregroundStyle(Tau.ink)
                            if let plan = account.account.plan { Text(plan).font(.system(size: 11.5, weight: .medium)).foregroundStyle(Tau.muted) }
                            Spacer(minLength: 4)
                            if account.machines > 1 { Text("\(account.machines) machines").font(.system(size: 10.5, weight: .medium)).foregroundStyle(Tau.faint) }
                        }
                        .lineLimit(1)
                        ForEach(account.account.windows, id: \.self) { window in row(account, window) }
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }
    func row(_ account: PlanAccount, _ window: UsageWindow) -> some View {
        let level = state.level(account, window)
        let expired = WidgetModel.expired(window, now: state.now)
        return VStack(spacing: 3) {
            HStack {
                Text(window.label).foregroundStyle(Tau.ink2)
                Spacer()
                Text(expired ? "–" : "\(window.left)% left").fontWeight(.semibold).foregroundStyle(level == .stale ? Tau.faint : level == .normal ? Tau.ink : level.text).monospacedDigit()
            }
            .font(.system(size: 11.5))
            Track(left: expired ? 0 : window.left, tone: Tau.tone(account.account.tone), level: level)
            HStack {
                Text(expired ? "reset · waiting for a new reading" : window.resetDate.map { "resets \(clock($0, now: state.now)) · \(until($0, now: state.now))" } ?? "")
                Spacer()
                pace(window, level: level)
            }
            .font(.system(size: 10.5)).foregroundStyle(Tau.faint).monospacedDigit().lineLimit(1)
        }
    }
    @ViewBuilder func pace(_ window: UsageWindow, level: Level) -> some View {
        if level != .stale {
            switch window.pace {
            case "spent": Text("spent").foregroundStyle(Tau.failInk)
            case "runs-out": Text("runs out \(window.paceAt.map { day(Date(ms: $0), now: state.now) } ?? "soon")").foregroundStyle(Tau.warn)
            case "ahead": Text("above pace").foregroundStyle(Tau.warn)
            case "on": Text("on pace")
            default: EmptyView()
            }
        }
    }
}

// Lock screen: iOS draws these monochrome, so level shows by number and shape only.
struct PlanRectangular: View {
    var state: PlanState
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) { TauGlyph(size: 12); Text("Plan limits").font(.system(size: 12.5, weight: .bold)) }
            BarGroups(state: state, accounts: Array(state.accounts.prefix(4)), width: 7, height: 22, groupGap: 9, barGap: 2, marks: false, mono: true)
            if let low = state.lowest {
                Text("\(low.window.left)% · \(low.account.account.label.split(separator: " ").first.map(String.init) ?? "") \(low.window.short ?? low.window.label)\(low.window.resetDate.map { " · " + clock($0, now: state.now) } ?? "")")
                    .font(.system(size: 11, weight: .medium)).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct PlanCircular: View {
    var state: PlanState
    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            if let low = state.lowest {
                Circle().stroke(.primary.opacity(0.25), lineWidth: 5).padding(4)
                Circle().trim(from: 0, to: CGFloat(low.window.left) / 100).stroke(.primary, style: StrokeStyle(lineWidth: 5, lineCap: .round)).rotationEffect(.degrees(-90)).padding(4).widgetAccentable()
                VStack(spacing: 1) {
                    HStack(alignment: .firstTextBaseline, spacing: 0) {
                        Text("\(low.window.left)").font(.system(size: 20, weight: .bold))
                        Text("%").font(.system(size: 11, weight: .semibold))
                    }
                    Text("\(low.account.account.label.split(separator: " ").first.map(String.init) ?? "") \(low.window.short ?? "")").font(.system(size: 9, weight: .semibold)).opacity(0.8).lineLimit(1).minimumScaleFactor(0.7)
                }
                .padding(.horizontal, 8)
            }
        }
    }
}

struct PlanAccessoryEmpty: View {
    var body: some View {
        HStack(spacing: 4) { TauGlyph(size: 12); Text("No plan limits yet").font(.system(size: 12, weight: .semibold)) }
    }
}

struct PlanLimitsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetKind.planLimits, provider: PlanProvider()) { entry in
            PlanLimitsView(entry: entry).containerBackground(for: .widget) { Tau.bg }
        }
        .configurationDisplayName("Plan limits")
        .description("What is left of your plans, per account, from your paired machines.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryCircular])
        .contentMarginsDisabled()
    }
}
