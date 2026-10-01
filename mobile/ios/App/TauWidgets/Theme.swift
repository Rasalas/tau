import SwiftUI
import WidgetKit

/// Tau's tokens as the mocks use them (`.scratch/design/widgets/src/mocks.css`), from the asset catalog.
enum Tau {
    static let bg = Color("w-bg"), ink = Color("ink"), ink2 = Color("ink-2"), muted = Color("muted"), faint = Color("faint"), fainter = Color("fainter")
    static let track = Color("track"), lineSoft = Color("line-soft"), brand = Color("brand"), brandOn = Color("brand-on")
    static let info = Color("info"), infoInk = Color("info-ink"), ready = Color("ready"), done = Color("done")
    static let warn = Color("warn"), warnBar = Color("warn-bar"), warnChip = Color("warn-chip"), fail = Color("fail"), failInk = Color("fail-ink")
    static func tone(_ name: String?) -> Color { Color("provider-" + (["openai", "anthropic", "google", "pi"].contains(name ?? "") ? name! : "other")) }
    /// The Dynamic Island is black in both modes; these read on it.
    enum Island {
        static let working = Color(red: 0xa6 / 255, green: 0xbf / 255, blue: 0xee / 255)
        static let waiting = Color(red: 0xf0 / 255, green: 0xc9 / 255, blue: 0x6f / 255)
        static let done = Color(red: 0x7f / 255, green: 0xd1 / 255, blue: 0x97 / 255)
        static let failed = Color(red: 0xf0 / 255, green: 0x8a / 255, blue: 0x80 / 255)
    }
}

extension Date {
    init(ms: Double) { self.init(timeIntervalSince1970: ms / 1000) }
}

/// The Tau mark: τ on its blue plate. The τ is a template image, so it never clips at small sizes.
struct TauPlate: View {
    var size: CGFloat
    var body: some View {
        RoundedRectangle(cornerRadius: size * 7 / 32, style: .continuous).fill(Tau.brand)
            .overlay(Image("tau-plate-glyph").resizable().renderingMode(.template).foregroundStyle(Tau.brandOn))
            .frame(width: size, height: size)
    }
}

struct TauGlyph: View {
    var size: CGFloat
    var body: some View { Image("tau-glyph").resizable().renderingMode(.template).frame(width: size, height: size) }
}

/// A provider's mark as the app draws it: coloured marks as they are, the others in their tone or ink.
struct ProviderMark: View {
    var mark: String?
    var tone: String?
    var size: CGFloat = 14
    var body: some View {
        Group {
            if let mark, ["codex", "gemini", "antigravity"].contains(mark) {
                Image("mark-" + mark).resizable()
            } else if let mark {
                Image("mark-" + mark).resizable().renderingMode(.template).foregroundStyle(mark == "claude-code" || mark == "anthropic" ? Tau.tone("anthropic") : Tau.ink2)
            } else {
                RoundedRectangle(cornerRadius: size / 4).fill(Tau.tone(tone).opacity(0.25))
            }
        }
        .frame(width: size, height: size)
    }
}

/// The level a value is drawn at: low, spent, or an old reading.
enum Level {
    case normal, warn, fail, stale
    var text: Color { switch self { case .normal: Tau.ink; case .warn: Tau.warn; case .fail: Tau.failInk; case .stale: Tau.faint } }
}

func windowLevel(_ window: UsageWindow, stale: Bool, now: Date) -> Level {
    if stale || WidgetModel.expired(window, now: now) { return .stale }
    if window.left <= 0 || window.level == "fail" { return .fail }
    if window.left <= 10 || window.level == "warn" { return .warn }
    return .normal
}

/// One juicebar: upright, filled from the bottom with what is left.
struct Juicebar: View {
    var left: Int
    var tone: Color
    var level: Level
    var width: CGFloat
    var height: CGFloat
    var radius: CGFloat = 2.5
    var track: Color = Tau.track
    var body: some View {
        ZStack(alignment: .bottom) {
            RoundedRectangle(cornerRadius: radius).fill(level == .fail ? Tau.fail.opacity(0.3) : track)
            if left > 0 {
                Rectangle().fill(fill).frame(height: height * CGFloat(left) / 100).widgetAccentable()
            }
        }
        .frame(width: width, height: height)
        .clipShape(RoundedRectangle(cornerRadius: radius))
    }
    var fill: Color { switch level { case .warn: Tau.warnBar; case .fail: Tau.fail; case .stale: Tau.fainter; case .normal: tone } }
}

/// A lying bar, filled from the left with what is left.
struct Track: View {
    var left: Int
    var tone: Color
    var level: Level
    var height: CGFloat = 5
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(level == .fail ? Tau.fail.opacity(0.3) : Tau.track)
                if left > 0 { Capsule().fill(fill).frame(width: geometry.size.width * CGFloat(left) / 100).widgetAccentable() }
            }
        }
        .frame(height: height)
    }
    var fill: Color { switch level { case .warn: Tau.warnBar; case .fail: Tau.fail; case .stale: Tau.fainter; case .normal: tone } }
}

/// The running state's mark: a ring with a lit arc. Widgets do not animate, so it stands still.
struct Spinner: View {
    var size: CGFloat = 10
    var line: CGFloat = 1.6
    var track: Color = Tau.info.opacity(0.35)
    var arc: Color = Tau.infoInk
    var body: some View {
        ZStack {
            Circle().stroke(track, lineWidth: line)
            Circle().trim(from: 0, to: 0.25).stroke(arc, style: StrokeStyle(lineWidth: line, lineCap: .round)).rotationEffect(.degrees(-135 + 35))
        }
        .frame(width: size - line, height: size - line)
        .frame(width: size, height: size)
    }
}

/// A thread's state in a tinted circle, as in the thread list.
struct StateIcon: View {
    var state: String
    var size: CGFloat = 18
    var body: some View {
        ZStack {
            Circle().fill(background)
            switch state {
            case "running": Spinner(size: size * 0.61)
            case "waiting": Image(systemName: "questionmark").font(.system(size: size * 0.5, weight: .heavy)).foregroundStyle(Tau.warn)
            case "done": Image(systemName: "checkmark").font(.system(size: size * 0.48, weight: .heavy)).foregroundStyle(Tau.ready)
            default: Image(systemName: "exclamationmark.triangle").font(.system(size: size * 0.5, weight: .bold)).foregroundStyle(Tau.failInk)
            }
        }
        .frame(width: size, height: size)
    }
    var background: Color {
        switch state {
        case "running": Tau.info.opacity(0.14)
        case "waiting": Tau.warnBar.opacity(0.22)
        case "done": Tau.done.opacity(0.18)
        default: Tau.fail.opacity(0.18)
        }
    }
}

func stateColor(_ state: String) -> Color {
    switch state { case "running": Tau.infoInk; case "waiting": Tau.warn; case "done": Tau.ready; default: Tau.failInk }
}

/// A widget's head line: the mark, its name, and on the right how old its data is.
struct WidgetHeader<Trailing: View>: View {
    var title: String
    @ViewBuilder var trailing: Trailing
    var body: some View {
        HStack(spacing: 5) {
            TauPlate(size: 15)
            Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(Tau.muted)
            Spacer(minLength: 4)
            trailing
        }
        .lineLimit(1)
        .minimumScaleFactor(0.85)
    }
}

/// "3 min ago": the system's live relative styles spell out "2 minutes, 3 seconds", so this is
/// coarse text and the timelines carry an entry for each step.
struct Ago: View {
    var date: Date
    var now: Date
    var suffix = true
    var body: some View { Text(coarseAgo(date, now: now) + (suffix ? " ago" : "")) }
}

/// "in 2 h", "in 2 d": the coarse time until a reset.
func until(_ date: Date, now: Date) -> String {
    let seconds = date.timeIntervalSince(now)
    if seconds <= 0 { return "reset" }
    let minutes = Int((seconds / 60).rounded(.up))
    if minutes < 45 { return "in \(minutes) min" }
    let hours = Int((seconds / 3600).rounded())
    if hours < 48 { return "in \(hours) h" }
    return "in \(Int((seconds / 86400).rounded())) d"
}

/// "16:40" today, "Fri 09:00" this week, "1 Nov" later.
func clock(_ date: Date, now: Date) -> String {
    let calendar = Calendar.current
    if calendar.isDate(date, inSameDayAs: now) { return date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)) }
    if date.timeIntervalSince(now) < 6 * 86400 { return date.formatted(.dateTime.weekday(.abbreviated).hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)) }
    return date.formatted(.dateTime.day().month(.abbreviated))
}

/// "15:20" today, "Thu" after.
func day(_ date: Date, now: Date) -> String {
    Calendar.current.isDate(date, inSameDayAs: now) ? hhmm(date) : date.formatted(.dateTime.weekday(.abbreviated))
}

func hhmm(_ date: Date) -> String { date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)) }

/// "14:32" or "1:02:05": how long a run took.
func duration(_ seconds: TimeInterval) -> String {
    let total = max(0, Int(seconds.rounded()))
    let hours = total / 3600, minutes = (total % 3600) / 60, rest = total % 60
    return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%d:%02d", minutes, rest)
}

/// "6 min", "1 h": how long ago, coarse and static (the widget reloads for it).
func coarseAgo(_ date: Date, now: Date) -> String {
    let minutes = max(0, Int(now.timeIntervalSince(date) / 60))
    if minutes < 60 { return "\(max(1, minutes)) min" }
    let hours = Int((Double(minutes) / 60).rounded())
    return hours < 48 ? "\(hours) h" : "\(Int((Double(hours) / 24).rounded())) d"
}

/// The run's clock, counting up live.
struct Elapsed: View {
    var since: Date
    var body: some View {
        Text(timerInterval: since...Date.distantFuture, countsDown: false).monospacedDigit()
    }
}

struct Machine: View {
    var name: String
    var size: CGFloat = 10
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "display").font(.system(size: size * 0.9, weight: .medium))
            Text(name)
        }
    }
}

/// The empty state: the Tau mark instead of placeholder text.
struct EmptyWidget: View {
    var title: String
    var detail: String
    var body: some View {
        VStack(spacing: 6) {
            TauPlate(size: 30)
            Text(title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Tau.ink).padding(.top, 4)
            Text(detail).font(.system(size: 11.5)).foregroundStyle(Tau.muted).multilineTextAlignment(.center).frame(maxWidth: 150)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The App Group's snapshots, as the app last wrote them.
enum SharedSnapshots {
    static var defaults: UserDefaults? { UserDefaults(suiteName: "group.de.tbuck.tau") }
    static func read<T: Decodable>(_ prefix: String) -> [T] {
        (defaults?.dictionaryRepresentation() ?? [:]).compactMap { key, value in
            guard key.hasPrefix(prefix), let data = value as? Data else { return nil }
            return try? JSONDecoder().decode(T.self, from: data)
        }
    }
    static var snapshots: [WidgetSnapshot] { read("widget.") }
    static var usage: [UsageSnapshot] { snapshots.compactMap(\.usage) }
    static var threads: [ThreadsSnapshot] { snapshots.map(\.threadsSnapshot) }
    static func machine(_ host: String?) -> String? {
        guard let host, let data = defaults?.data(forKey: "widget." + host) else { return nil }
        return (try? JSONDecoder().decode(WidgetSnapshot.self, from: data))?.machine
    }
}

func threadURL(host: String?, thread: String?) -> URL? {
    guard let host else { return nil }
    var url = URLComponents(); url.scheme = "tau"; url.host = "thread"
    url.queryItems = [URLQueryItem(name: "host", value: host)] + (thread.map { [URLQueryItem(name: "thread", value: $0)] } ?? [])
    return url.url
}

func usageURL(host: String?) -> URL? {
    guard let host else { return URL(string: "tau://hosts") }
    var url = URLComponents(); url.scheme = "tau"; url.host = "usage"
    url.queryItems = [URLQueryItem(name: "host", value: host)]
    return url.url
}
