package de.tbuck.tau.plugin.widgets

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

class WidgetModelTest {
    private val now = 1_800_000_000_000L
    private val min = 60_000L

    private fun window(label: String, short: String, used: Double, resetsIn: Long?, level: String? = null, pace: String? = null, paceIn: Long? = null) = JSONObject()
        .put("label", label).put("short", short).put("usedPercent", used)
        .apply { resetsIn?.let { put("resetsAt", now + it) }; level?.let { put("level", it) }; pace?.let { put("pace", it) }; paceIn?.let { put("paceAt", now + it) } }

    private fun account(label: String, tone: String, checkedAt: Long, vararg windows: JSONObject, poolKey: String? = null) = JSONObject()
        .put("label", label).put("tone", tone).put("checkedAt", checkedAt).put("windows", JSONArray(windows.toList()))
        .apply { poolKey?.let { put("poolKey", it) } }

    /** A thread as the app writes it: `since` is when it asked, started or ended, depending on the state. */
    private fun thread(id: String, state: String, since: Long) = JSONObject()
        .put("id", id).put("title", "Thread $id").put("project", "shop-api").put("state", if (state == "question") "waiting" else state)
        .apply {
            when (state) {
                "question" -> put("startedAt", since - 60_000).put("askedAt", since).put("reason", "Allow edit?")
                "running" -> put("startedAt", since)
                else -> put("startedAt", since - 60_000).put("endedAt", since)
            }
        }

    private fun snapshot(host: String, accounts: List<JSONObject>?, threads: List<JSONObject> = emptyList(), updatedAt: Long = now) = WidgetModel.fromWire(
        JSONObject().put("version", 3).put("hostId", host).put("machine", "Mac $host").put("updatedAt", updatedAt)
            .put("threads", JSONArray(threads)).apply { accounts?.let { put("accounts", JSONArray(it)) } },
    )!!

    @Test fun ordersAccountsByProviderAndNamesTheLowestWindow() {
        val limits = WidgetModel.planLimits(listOf(snapshot("a", listOf(
            account("OpenCode Go", "other", now, window("Monthly", "mo", 22.0, 31 * 24 * 60 * min)),
            account("Claude Code", "anthropic", now, window("5-hour", "5h", 12.0, 70 * min), window("Weekly", "wk", 47.0, 5 * 24 * 60 * min)),
            account("Codex", "openai", now - 2 * min, window("5-hour", "5h", 34.0, 158 * min), window("Weekly", "wk", 91.0, 43 * 60 * min, "warn", "runs-out", 30 * 60 * min)),
        ))), now)
        assertEquals(listOf("Codex", "Claude Code", "OpenCode Go"), limits.accounts.map { it.label })
        val (account, lowest) = limits.lowest!!
        assertEquals("Codex weekly", WidgetModel.windowName(account, lowest))
        assertEquals(9, lowest.left)
        assertEquals(Level.WARN, lowest.level)
        assertEquals(now, limits.asOf)
        assertFalse(limits.stale)
        assertEquals("in 2 d", WidgetModel.resetsIn(now, lowest.resetsAt))
    }

    @Test fun poolsOneSubscriptionAcrossMachinesWithItsFreshestRead() {
        val limits = WidgetModel.planLimits(listOf(
            snapshot("a", listOf(account("Claude Code", "anthropic", now - 5 * min, window("5-hour", "5h", 30.0, null), poolKey = "anthropic:k"))),
            snapshot("b", listOf(account("Claude Code", "anthropic", now - min, window("5-hour", "5h", 100.0, null, "fail", "spent"), poolKey = "anthropic:k"))),
        ), now)
        assertEquals(1, limits.accounts.size)
        assertEquals(2, limits.accounts[0].machines)
        assertEquals(Level.FAIL, limits.accounts[0].windows[0].level)
    }

    @Test fun keepsStaleValuesButMarksThem() {
        val limits = WidgetModel.planLimits(listOf(snapshot("a", listOf(account("Codex", "openai", now - 2 * 60 * min, window("Weekly", "wk", 91.0, null))))), now)
        assertTrue(limits.stale)
        assertEquals(9, limits.accounts[0].windows[0].left)
        assertEquals(Level.STALE, limits.accounts[0].windows[0].level)
    }

    @Test fun emptyWithoutReadings() {
        val limits = WidgetModel.planLimits(listOf(snapshot("a", null)), now)
        assertTrue(limits.accounts.isEmpty())
        assertNull(limits.lowest)
        assertFalse(limits.stale)
    }

    @Test fun rejectsAnotherVersion() {
        assertNull(WidgetModel.parse(JSONObject().put("version", 1).put("hostId", "a").toString()))
        assertNull(WidgetModel.fromWire(JSONObject().put("version", 2).put("hostId", "a")))
        assertNull(WidgetModel.parse("not json"))
    }

    @Test fun ordersThreadsQuestionThenRunningThenFinished() {
        val board = WidgetModel.threadBoard(listOf(snapshot("a", null, listOf(
            thread("done", "done", now - 6 * min),
            thread("short", "running", now - 3 * min),
            thread("failed", "failed", now - 20 * min),
            thread("long", "running", now - 12 * min),
            thread("ask", "question", now - 4 * min),
            thread("old", "done", now - 5 * 60 * min),
        )), snapshot("lost", null, listOf(thread("lost", "running", now - 9 * 60 * min)), updatedAt = now - 9 * 60 * min)), now)
        assertEquals(listOf("ask", "long", "short", "done", "failed"), board.items.map { it.thread.id })
        assertEquals(listOf(1, 2, 1, 1), listOf(board.questions, board.running, board.done, board.failed))
        assertEquals("Mac a", board.items[0].machine)
        assertFalse(board.stale)
    }

    @Test fun bundlesActiveThreadsIntoOneOngoingNotice() {
        val board = WidgetModel.threadBoard(listOf(snapshot("a", null, listOf(
            thread("ask", "question", now - 4 * min), thread("long", "running", now - 12 * min), thread("short", "running", now - 3 * min),
        ))), now)
        val notice = WidgetModel.notice(board, now)!!
        assertTrue(notice.ongoing)
        assertEquals("1 question, 2 running", notice.title)
        assertEquals(now - 12 * min, notice.chronometerFrom)
        assertTrue(notice.chronometer)
        assertEquals("ask", notice.question?.thread?.id)
        assertEquals("ask", notice.tap.thread.id)
    }

    @Test fun aFinishedThreadLeavesADismissableNoticeForAWhile() {
        val recent = WidgetModel.threadBoard(listOf(snapshot("a", null, listOf(thread("done", "done", now - 5 * min)))), now)
        val notice = WidgetModel.notice(recent, now)!!
        assertFalse(notice.ongoing)
        assertEquals("Thread done", notice.title)
        val later = WidgetModel.threadBoard(listOf(snapshot("a", null, listOf(thread("done", "done", now - 30 * min)))), now)
        assertNull(WidgetModel.notice(later, now))
    }

    @Test fun marksThreadsStaleWhenNothingArrivedForAWhile() {
        val board = WidgetModel.threadBoard(listOf(snapshot("a", null, listOf(thread("long", "running", now - 60 * min)), updatedAt = now - 40 * min)), now)
        assertTrue(board.stale)
        assertEquals(1, board.running)
    }

    @Test fun foldsAPushedActivityIntoItsHostsSnapshot() {
        val base = snapshot("a", null, listOf(thread("t", "running", now - 10 * min)), updatedAt = now - 2 * min)
        val activity = { state: String, at: Long -> JSONObject().put("version", 1).put("hostId", "a").put("threadId", "t").put("title", "Fix flaky pairing test").put("state", state).put("updatedAt", at).put("expiresAt", at + 15 * min) }
        val asked = WidgetModel.withActivity(base, activity("needs-input", now), now)
        assertNotNull(asked)
        assertEquals(ThreadState.QUESTION, asked!!.threads[0].state)
        assertEquals("shop-api", asked.threads[0].project)
        assertEquals(now, asked.threads[0].since)
        assertNull(WidgetModel.withActivity(asked, activity("running", now - min), now))
        val fresh = WidgetModel.withActivity(null, activity("running", now), now)!!
        assertEquals("a", fresh.hostId)
        assertNull(WidgetModel.withActivity(null, activity("running", now - 20 * min), now))
        val failed = snapshot("a", null, listOf(thread("t", "failed", now - min)))
        assertEquals(ThreadState.FAILED, WidgetModel.withActivity(failed, activity("completed", now), now)!!.threads[0].state)
    }

    @Test fun roundTripsThroughJson() {
        val original = snapshot("a", listOf(account("Codex", "openai", now, window("Weekly", "wk", 91.0, 60 * min), poolKey = "openai:k")), listOf(thread("t", "running", now)))
        assertEquals(original, WidgetModel.parse(WidgetModel.toJson(original).toString()))
    }

    @Test fun takesLevelAndPaceFromTheSnapshotInsteadOfDerivingThem() {
        val limits = WidgetModel.planLimits(listOf(snapshot("a", listOf(account("Codex", "openai", now,
            window("5-hour", "5h", 95.0, 60 * min), window("Weekly", "wk", 91.0, 43 * 60 * min, "warn", "runs-out", 30 * 60 * min))))), now)
        val (five, week) = limits.accounts[0].windows
        assertEquals(Level.NONE, five.level)
        assertEquals(Level.WARN, week.level)
        assertEquals(Pace.RUNS_OUT, week.pace)
        assertNull(WidgetModel.paceLabel(five, now))
    }

    @Test fun saysWhenAWindowRunsOutByTheWeekdayOrTheClock() {
        val window = LimitWindow("Weekly", "wk", 9, null, Level.WARN, Pace.RUNS_OUT, now + 30 * 60 * min)
        val label = WidgetModel.paceLabel(window, now, ZoneOffset.UTC)!!
        assertTrue(label, Regex("runs out \\S+").matches(label))
        assertEquals("runs out 14:40", WidgetModel.paceLabel(window.copy(paceAt = now + (6 * 60 + 40) * min), now, ZoneOffset.UTC))
        assertEquals("runs out soon", WidgetModel.paceLabel(window.copy(paceAt = null), now))
        assertEquals("spent", WidgetModel.paceLabel(window.copy(pace = Pace.SPENT), now))
        assertEquals("above pace", WidgetModel.paceLabel(window.copy(pace = Pace.AHEAD), now))
        assertNull(WidgetModel.paceLabel(window.copy(pace = Pace.ON), now))
    }

    @Test fun showsNeitherLevelNorPaceOnAStaleReading() {
        val limits = WidgetModel.planLimits(listOf(snapshot("a", listOf(account("Codex", "openai", now - 2 * 60 * min,
            window("Weekly", "wk", 91.0, null, "warn", "runs-out", 60 * min))))), now)
        assertEquals(Level.STALE, limits.accounts[0].windows[0].level)
        assertNull(limits.accounts[0].windows[0].pace)
    }

    @Test fun readsWhenAThreadEnteredItsStateAndWhyItFailedOrAsks() {
        val board = WidgetModel.threadBoard(listOf(snapshot("a", null, listOf(
            thread("ask", "question", now - 4 * min), thread("run", "running", now - 12 * min), thread("end", "failed", now - 6 * min),
        ))), now)
        assertEquals(listOf(now - 4 * min, now - 12 * min, now - 6 * min), board.items.map { it.thread.since })
        assertEquals(listOf("ask", "run", "end"), board.items.map { it.thread.id })
        assertEquals("Allow edit?", board.items[0].thread.detail)
        assertEquals(ThreadState.FAILED, board.items[2].thread.state)
        assertTrue(board.items.all { it.thread.updatedAt == now })
    }

    @Test fun mapsTheAppsMarksToAndroidsDrawables() {
        assertEquals(listOf("codex", "codex", "claude-code", "claude-code", "gemini", "gemini", "opencode", "pi", "other", "other"),
            listOf("codex", "openai", "claude-code", "anthropic", "gemini", "antigravity", "opencode", "pi", "cursor", "grok").map { WidgetModel.mark(it) })
        assertNull(WidgetModel.mark(""))
    }

    @Test fun resetTimesReadCoarsely() {
        assertEquals("in 40 min", WidgetModel.resetsIn(now, now + 40 * min))
        assertEquals("in 1 h", WidgetModel.resetsIn(now, now + 68 * min))
        assertEquals("in 31 d", WidgetModel.resetsIn(now, now + 31 * 24 * 60 * min))
        assertNull(WidgetModel.resetsIn(now, now - min))
    }
}
