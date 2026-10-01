import XCTest

final class WidgetModelTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func ms(_ offset: TimeInterval) -> Double { (now.timeIntervalSince1970 + offset) * 1000 }

    func account(_ label: String, tone: String, key: String?, checked: TimeInterval, used: [Double]) -> UsageAccount {
        UsageAccount(poolKey: key, label: label, tone: tone, checkedAt: ms(checked), windows: used.enumerated().map { index, value in
            UsageWindow(label: index == 0 ? "5-hour" : "Weekly", usedPercent: value, resetsAt: ms(3600 * Double(index + 1)))
        })
    }

    func testMergesOnePlanAcrossHostsByItsFreshestReadingInTheFixedOrder() {
        let mini = UsageSnapshot(hostId: "mini", accounts: [account("OpenCode Go", tone: "other", key: nil, checked: -60, used: [22]),
                                                            account("Claude Code", tone: "anthropic", key: "anthropic:k", checked: -600, used: [3, 40])])
        let book = UsageSnapshot(hostId: "book", accounts: [account("Claude Code", tone: "anthropic", key: "anthropic:k", checked: -30, used: [12, 47]),
                                                            account("Codex", tone: "openai", key: "openai:k", checked: -60, used: [34, 91])])
        let merged = WidgetModel.merge([mini, book])
        XCTAssertEqual(merged.map(\.account.label), ["Codex", "Claude Code", "OpenCode Go"])
        XCTAssertEqual(merged[1].machines, 2)
        XCTAssertEqual(merged[1].hostId, "book")
        XCTAssertEqual(merged[1].account.windows[0].left, 88)
        let lowest = WidgetModel.lowest(merged, now: now)
        XCTAssertEqual(lowest?.account.account.label, "Codex")
        XCTAssertEqual(lowest?.window.left, 9)
        XCTAssertEqual(WidgetModel.newest(merged), Date(timeIntervalSince1970: (ms(-30)) / 1000))
    }

    func testAReadingTurnsStaleAndAPassedResetDropsOutOfTheLowest() {
        var codex = account("Codex", tone: "openai", key: "openai:k", checked: -20 * 60, used: [99, 10])
        codex.windows[0].resetsAt = ms(-1)
        let merged = WidgetModel.merge([UsageSnapshot(hostId: "h", accounts: [codex])])
        XCTAssertTrue(WidgetModel.stale(merged[0], now: now))
        XCTAssertTrue(WidgetModel.expired(merged[0].account.windows[0], now: now))
        XCTAssertEqual(WidgetModel.lowest(merged, now: now)?.window.label, "Weekly")
        // The drawing changes again when the weekly window resets; the old reading is stale already.
        XCTAssertEqual(WidgetModel.changes(merged, now: now), [Date(timeIntervalSince1970: ms(7200) / 1000)])
    }

    func testOrdersThreadsAQuestionFirstThenRunningThenTheNewestEnded() {
        let a = ThreadsSnapshot(hostId: "a", machine: "Mac mini", updatedAt: ms(0), threads: [
            WidgetThread(id: "late", title: "Late run", state: "running", startedAt: ms(-60)),
            WidgetThread(id: "old", title: "Ended long ago", state: "done", endedAt: ms(-3600)),
        ])
        let b = ThreadsSnapshot(hostId: "b", machine: "MacBook", updatedAt: ms(0), threads: [
            WidgetThread(id: "early", title: "Early run", state: "running", startedAt: ms(-600)),
            WidgetThread(id: "ask", title: "Question", state: "waiting", askedAt: ms(-30)),
            WidgetThread(id: "fail", title: "Failed", state: "failed", endedAt: ms(-120)),
        ])
        let merged = WidgetModel.threads([a, b])
        XCTAssertEqual(merged.map(\.id), ["ask", "early", "late", "fail", "old"])
        XCTAssertEqual(merged[0].machine, "MacBook")
        XCTAssertEqual(merged[1].hostId, "b")
        // The Live Activity keeps what works and what ended within a quarter hour, four at most.
        XCTAssertEqual(WidgetModel.activityRows(merged, now: now).map(\.id), ["ask", "early", "late", "fail"])
        XCTAssertEqual(WidgetModel.activityRows([merged[4]], now: now), [])
    }

    func testReadsTheAppsSnapshotAndKeepsTheLastAccountsWhenNewOnesAreMissing() throws {
        let json = """
        {"version":3,"hostId":"mini","machine":"Mac mini","updatedAt":1,"accounts":[{"label":"Codex","tone":"openai","mark":"codex","checkedAt":2,
        "windows":[{"label":"Weekly","short":"wk","usedPercent":91,"level":"warn","pace":"runs-out","paceAt":5}]}],
        "threads":[{"id":"t","title":"Fix","state":"waiting","startedAt":3,"askedAt":4,"reason":"Allow edit?"}]}
        """
        let first = try JSONDecoder().decode(WidgetSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(first.usage?.accounts[0].windows[0].level, "warn")
        XCTAssertEqual(first.usage?.accounts[0].windows[0].pace, "runs-out")
        XCTAssertEqual(first.threadsSnapshot.threads[0].reason, "Allow edit?")
        let later = WidgetSnapshot(hostId: "mini", machine: "Mac mini", updatedAt: 9, threads: [])
        XCTAssertNil(later.usage)
        XCTAssertEqual(WidgetModel.keeping(later, previous: first).accounts?.count, 1)
        XCTAssertEqual(WidgetModel.keeping(later, previous: first).updatedAt, 9)
    }
}
