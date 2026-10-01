import ActivityKit
import Foundation

// Compiled into the app's plugin and into the TauWidgets extension: one contract for both.

/// One Live Activity per host for all of its threads (K163). A remote start
/// carries `activityId` and the sealed `bootstrap` instead of host and thread.
@available(iOS 16.2, *)
public struct TauActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        public var title: String?
        public var state: String?
        public var expiresAt: Double?
        public var sealed: String? = nil
        /// Written by the app itself; a push carries its rows sealed.
        public var threads: [WidgetThread]? = nil
        public var updatedAt: Double? = nil
        public init(title: String? = nil, state: String? = nil, expiresAt: Double? = nil, sealed: String? = nil, threads: [WidgetThread]? = nil, updatedAt: Double? = nil) {
            self.title = title; self.state = state; self.expiresAt = expiresAt; self.sealed = sealed; self.threads = threads; self.updatedAt = updatedAt
        }
    }
    public var hostId: String?
    public var threadId: String?
    public var activityId: String? = nil
    public var bootstrap: String? = nil
    public init(hostId: String?, threadId: String?, activityId: String? = nil, bootstrap: String? = nil) {
        self.hostId = hostId; self.threadId = threadId; self.activityId = activityId; self.bootstrap = bootstrap
    }
}

public enum WidgetKind {
    public static let planLimits = "TauPlanLimits"
    public static let threads = "TauThreads"
}

public struct UsageWindow: Codable, Hashable {
    public var label: String
    public var short: String?
    public var usedPercent: Double
    public var resetsAt: Double?
    public var level: String?
    public var pace: String?
    public var paceAt: Double?
    public var left: Int { Int((100 - min(100, max(0, usedPercent))).rounded()) }
    public var resetDate: Date? { resetsAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

public struct UsageAccount: Codable, Hashable {
    public var poolKey: String?
    public var label: String
    public var plan: String?
    public var tone: String?
    public var mark: String?
    public var checkedAt: Double
    public var windows: [UsageWindow]
}

/// A host's accounts, as the Plan limits widget reads them.
public struct UsageSnapshot: Hashable {
    public var hostId: String
    public var machine: String?
    public var updatedAt: Double?
    public var accounts: [UsageAccount]
}

public struct WidgetThread: Codable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var project: String?
    /// waiting, running, done or failed.
    public var state: String
    public var startedAt: Double?
    public var endedAt: Double?
    public var askedAt: Double?
    public var reason: String?
    /// Set when rows of several hosts are merged.
    public var hostId: String? = nil
    public var machine: String? = nil
    public var active: Bool { state == "waiting" || state == "running" }
    public init(id: String, title: String, project: String? = nil, state: String, startedAt: Double? = nil, endedAt: Double? = nil, askedAt: Double? = nil, reason: String? = nil, hostId: String? = nil, machine: String? = nil) {
        self.id = id; self.title = title; self.project = project; self.state = state; self.startedAt = startedAt; self.endedAt = endedAt; self.askedAt = askedAt; self.reason = reason; self.hostId = hostId; self.machine = machine
    }
}

/// A host's threads, as the Threads widget and the Live Activity read them.
public struct ThreadsSnapshot: Hashable {
    public var hostId: String
    public var machine: String?
    public var updatedAt: Double
    public var threads: [WidgetThread]
}

/// What the app writes per host (`mobile/src/widgets.ts`, version 3), the same bytes Android reads.
public struct WidgetSnapshot: Codable, Hashable {
    public var version: Int?
    public var hostId: String
    public var machine: String?
    public var updatedAt: Double
    /// Absent until the host answered once; the last accounts stay meanwhile.
    public var accounts: [UsageAccount]?
    public var threads: [WidgetThread]
    public init(hostId: String, machine: String? = nil, updatedAt: Double, accounts: [UsageAccount]? = nil, threads: [WidgetThread] = []) {
        self.version = 3; self.hostId = hostId; self.machine = machine; self.updatedAt = updatedAt; self.accounts = accounts; self.threads = threads
    }
    public var usage: UsageSnapshot? { accounts.map { UsageSnapshot(hostId: hostId, machine: machine, updatedAt: updatedAt, accounts: $0) } }
    public var threadsSnapshot: ThreadsSnapshot { ThreadsSnapshot(hostId: hostId, machine: machine, updatedAt: updatedAt, threads: threads) }
}

/// An account as the widget draws it: one plan once across hosts, its freshest reading.
public struct PlanAccount: Hashable {
    public var account: UsageAccount
    public var hostId: String
    /// Hosts that read this plan ("2 machines").
    public var machines: Int
    public var checked: Date { Date(timeIntervalSince1970: account.checkedAt / 1000) }
}

public enum WidgetModel {
    /// A reading older than this is drawn faded with its age.
    public static let staleAfter: TimeInterval = 15 * 60
    /// A finished thread stays in a host's Live Activity this long.
    public static let endedShown: TimeInterval = 15 * 60
    static let toneOrder = ["openai", "anthropic", "google", "pi", "other"]
    static let stateRank = ["waiting": 0, "running": 1, "done": 2, "failed": 2]

    /// The snapshot to keep: a write without accounts keeps the previous ones.
    public static func keeping(_ next: WidgetSnapshot, previous: WidgetSnapshot?) -> WidgetSnapshot {
        var kept = next
        if kept.accounts == nil { kept.accounts = previous?.accounts }
        return kept
    }

    /// Every host's accounts as one list: a pooled plan once (its freshest reading), in the sidebar's fixed order.
    public static func merge(_ snapshots: [UsageSnapshot]) -> [PlanAccount] {
        var pooled: [String: PlanAccount] = [:]
        var hosts: [String: Set<String>] = [:]
        for snapshot in snapshots.sorted(by: { $0.hostId < $1.hostId }) {
            for (index, account) in snapshot.accounts.enumerated() where !account.windows.isEmpty {
                let key = account.poolKey ?? "\(snapshot.hostId)#\(index)"
                hosts[key, default: []].insert(snapshot.hostId)
                if let prior = pooled[key], prior.account.checkedAt >= account.checkedAt { continue }
                pooled[key] = PlanAccount(account: account, hostId: snapshot.hostId, machines: 1)
            }
        }
        return pooled.map { key, value in var entry = value; entry.machines = hosts[key]?.count ?? 1; return entry }
            .sorted { left, right in
                let l = toneOrder.firstIndex(of: left.account.tone ?? "other") ?? toneOrder.count
                let r = toneOrder.firstIndex(of: right.account.tone ?? "other") ?? toneOrder.count
                return l != r ? l < r : left.account.label != right.account.label ? left.account.label < right.account.label : left.hostId < right.hostId
            }
    }

    public static func stale(_ account: PlanAccount, now: Date) -> Bool { now.timeIntervalSince(account.checked) > staleAfter }
    public static func expired(_ window: UsageWindow, now: Date) -> Bool { window.resetDate.map { $0 <= now } ?? false }

    /// The window with the least left that still describes its period.
    public static func lowest(_ accounts: [PlanAccount], now: Date) -> (account: PlanAccount, window: UsageWindow)? {
        var best: (account: PlanAccount, window: UsageWindow)?
        for account in accounts {
            for window in account.account.windows where !expired(window, now: now) {
                if best == nil || window.left < best!.window.left { best = (account, window) }
            }
        }
        return best
    }

    /// The newest reading among all accounts: "as of 14:02".
    public static func newest(_ accounts: [PlanAccount]) -> Date? { accounts.map(\.checked).max() }

    /// When the drawing changes without new data: a reading turns stale, a window resets.
    public static func changes(_ accounts: [PlanAccount], now: Date) -> [Date] {
        var dates = Set<Date>()
        for account in accounts {
            let stale = account.checked.addingTimeInterval(staleAfter)
            if stale > now { dates.insert(stale) }
            for window in account.account.windows { if let reset = window.resetDate, reset > now { dates.insert(reset) } }
        }
        return dates.sorted().prefix(12).map { $0 }
    }

    /// Every host's threads, a question first, then running ones by start, then ended ones newest first.
    public static func threads(_ snapshots: [ThreadsSnapshot]) -> [WidgetThread] {
        snapshots.flatMap { snapshot in snapshot.threads.map { row in var row = row; row.hostId = snapshot.hostId; row.machine = snapshot.machine; return row } }
            .sorted(by: ordered)
    }

    static func ordered(_ left: WidgetThread, _ right: WidgetThread) -> Bool {
        let l = stateRank[left.state] ?? 3, r = stateRank[right.state] ?? 3
        if l != r { return l < r }
        switch left.state {
        case "waiting": return (left.askedAt ?? 0) < (right.askedAt ?? 0)
        case "running": return (left.startedAt ?? 0) < (right.startedAt ?? 0)
        default: return (left.endedAt ?? 0) > (right.endedAt ?? 0)
        }
    }

    /// What a host's Live Activity lists: the threads at work and those that ended a moment ago.
    public static func activityRows(_ threads: [WidgetThread], now: Date) -> [WidgetThread] {
        Array(threads.filter { $0.active || ($0.endedAt.map { now.timeIntervalSince1970 * 1000 - $0 < endedShown * 1000 } ?? false) }
            .sorted(by: ordered).prefix(4))
    }

    public static func count(_ threads: [WidgetThread], _ state: String) -> Int { threads.filter { $0.state == state }.count }
}
