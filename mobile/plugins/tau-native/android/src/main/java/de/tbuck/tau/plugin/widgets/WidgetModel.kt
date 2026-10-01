package de.tbuck.tau.plugin.widgets

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.roundToLong

/**
 * What the widgets and the running-threads notification draw, built from the
 * hosts' snapshots. The app's (`mobile/src/widgets.ts`, version 3) is the one iOS reads too;
 * `fromWire` folds it into the model, and `WidgetStore` keeps that form (version 2) so a pushed
 * activity can be merged per thread. Pure, so JVM tests cover it.
 */
object WidgetModel {
    const val WIRE_VERSION = 3
    const val STORED_VERSION = 2
    /** A reading older than this keeps its values but draws faded, as the app's stale bars do. */
    const val FRESH_MS = 15 * 60_000L
    /** A running thread nobody updated for this long is gone (the host's own limit for activities). */
    const val ACTIVE_MS = 8 * 60 * 60_000L
    /** Finished threads stay in the Threads widget this long. */
    const val FINISHED_MS = 3 * 60 * 60_000L
    /** And this long in the notification, as a dismissable one. */
    const val DONE_NOTICE_MS = 15 * 60_000L

    /** A stored snapshot. */
    fun parse(json: String): Snapshot? = try { read(JSONObject(json), wire = false) } catch (_: Exception) { null }

    /** The app's snapshot, as `widgetSnapshot` hands it over. */
    fun fromWire(value: JSONObject): Snapshot? = try { read(value, wire = true) } catch (_: Exception) { null }

    private fun read(value: JSONObject, wire: Boolean): Snapshot? {
        val host = value.optString("hostId")
        if (value.optInt("version") != (if (wire) WIRE_VERSION else STORED_VERSION) || host.isEmpty() || host.length > 200) return null
        val updatedAt = value.optLong("updatedAt")
        val accounts = value.optJSONArray("accounts")?.let { list -> objects(list).mapNotNull(::account) }
        val threads = objects(value.optJSONArray("threads")).mapNotNull { if (wire) wireThread(it, updatedAt) else thread(it) }
        return Snapshot(host, value.optString("machine").take(60), updatedAt, accounts, threads)
    }

    private fun account(value: JSONObject): Account? {
        val label = value.optString("label").take(100)
        if (label.isEmpty()) return null
        val windows = objects(value.optJSONArray("windows")).mapNotNull { window ->
            val used = window.optDouble("usedPercent", Double.NaN)
            if (used.isNaN()) null else Window(
                window.optString("label").take(50), window.optString("short").take(4),
                used.coerceIn(0.0, 100.0), window.optLong("resetsAt").takeIf { it > 0 },
                Level.of(window.optString("level")), Pace.of(window.optString("pace")), window.optLong("paceAt").takeIf { it > 0 },
            )
        }
        return Account(
            value.optString("poolKey").ifEmpty { null }, label, value.optString("plan").take(40).ifEmpty { null },
            Tone.of(value.optString("tone")), mark(value.optString("mark")), value.optLong("checkedAt"), windows,
        )
    }

    /** The app names marks by provider; Android has six drawables. */
    fun mark(id: String): String? = when (id) {
        "" -> null
        "codex", "openai" -> "codex"
        "claude-code", "anthropic" -> "claude-code"
        "gemini", "antigravity" -> "gemini"
        "opencode", "pi" -> id
        else -> "other"
    }

    /** A thread of the app's snapshot: the time it entered its state is `since`, the snapshot's own time its `updatedAt`. */
    private fun wireThread(value: JSONObject, updatedAt: Long): Thread? {
        val id = value.optString("id")
        val state = ThreadState.of(value.optString("state").let { if (it == "waiting") "question" else it }) ?: return null
        if (id.isEmpty() || id.length > 200) return null
        val entered = when (state) {
            ThreadState.QUESTION -> value.optLong("askedAt")
            ThreadState.RUNNING -> value.optLong("startedAt")
            else -> value.optLong("endedAt")
        }.takeIf { it > 0 } ?: value.optLong("startedAt").takeIf { it > 0 } ?: updatedAt
        return Thread(
            id, value.optString("title").take(100).ifEmpty { "Agent work" }, value.optString("project").take(60).ifEmpty { null },
            state, entered, updatedAt, value.optString("reason").take(120).ifEmpty { null },
        )
    }

    private fun thread(value: JSONObject): Thread? {
        val id = value.optString("id")
        val state = ThreadState.of(value.optString("state")) ?: return null
        if (id.isEmpty() || id.length > 200) return null
        return Thread(
            id, value.optString("title").take(100).ifEmpty { "Agent work" }, value.optString("project").take(60).ifEmpty { null },
            state, value.optLong("since"), value.optLong("updatedAt"), value.optString("detail").take(120).ifEmpty { null },
        )
    }

    private fun objects(list: JSONArray?): List<JSONObject> =
        if (list == null) emptyList() else (0 until list.length()).mapNotNull { list.optJSONObject(it) }

    fun toJson(snapshot: Snapshot): JSONObject = JSONObject()
        .put("version", STORED_VERSION).put("hostId", snapshot.hostId).put("machine", snapshot.machine)
        .put("updatedAt", snapshot.updatedAt)
        .apply {
            snapshot.accounts?.let { accounts ->
                put("accounts", JSONArray(accounts.map { account ->
                    JSONObject().put("label", account.label).put("tone", account.tone.key).put("checkedAt", account.checkedAt)
                        .apply {
                            account.poolKey?.let { put("poolKey", it) }; account.plan?.let { put("plan", it) }; account.mark?.let { put("mark", it) }
                        }
                        .put("windows", JSONArray(account.windows.map { window ->
                            JSONObject().put("label", window.label).put("short", window.short).put("usedPercent", window.usedPercent)
                                .apply {
                                    window.resetsAt?.let { put("resetsAt", it) }; window.level?.let { put("level", it.key) }
                                    window.pace?.let { put("pace", it.key) }; window.paceAt?.let { put("paceAt", it) }
                                }
                        }))
                }))
            }
        }
        .put("threads", JSONArray(snapshot.threads.map { thread ->
            JSONObject().put("id", thread.id).put("title", thread.title).put("state", thread.state.key)
                .put("since", thread.since).put("updatedAt", thread.updatedAt)
                .apply { thread.project?.let { put("project", it) }; thread.detail?.let { put("detail", it) } }
        }))

    /**
     * A pushed per-thread activity (version 1, `kits/push/protocol.ts`) folded into its host's
     * snapshot; an older update than the one kept loses.
     */
    fun withActivity(previous: Snapshot?, activity: JSONObject, now: Long): Snapshot? {
        val host = activity.optString("hostId"); val id = activity.optString("threadId")
        val pushed = when (activity.optString("state")) {
            "running" -> ThreadState.RUNNING; "needs-input" -> ThreadState.QUESTION; "completed" -> ThreadState.DONE; else -> null
        }
        val at = activity.optLong("updatedAt")
        if (activity.optInt("version") != 1 || host.isEmpty() || host.length > 200 || id.isEmpty() || id.length > 200 || pushed == null) return null
        if (activity.optLong("expiresAt") <= now) return null
        val base = previous ?: Snapshot(host, "", 0, null, emptyList())
        val kept = base.threads.firstOrNull { it.id == id }
        if (kept != null && kept.updatedAt > at) return null
        // A push says "completed" for a failed turn too; the app's snapshot knew better.
        val state = if (pushed == ThreadState.DONE && kept?.state == ThreadState.FAILED) ThreadState.FAILED else pushed
        val since = if (kept != null && kept.state == state) kept.since else at
        val title = activity.optString("title").take(100).ifEmpty { kept?.title ?: "Agent work" }
        val next = Thread(id, title, kept?.project, state, since, at, kept?.detail.takeIf { kept?.state == state })
        return base.copy(threads = listOf(next) + base.threads.filter { it.id != id })
    }

    fun planLimits(snapshots: Collection<Snapshot>, now: Long): PlanLimits {
        val pooled = linkedMapOf<String, Pair<Account, MutableSet<String>>>()
        for (snapshot in snapshots.sortedBy { it.hostId }) {
            for (account in snapshot.accounts.orEmpty()) {
                if (account.windows.isEmpty()) continue
                val key = account.poolKey ?: "${snapshot.hostId}\u0000${account.label}"
                val kept = pooled[key]
                val hosts = kept?.second ?: mutableSetOf()
                hosts += snapshot.hostId
                pooled[key] = (if (kept == null || account.checkedAt > kept.first.checkedAt) account else kept.first) to hosts
            }
        }
        val accounts = pooled.values.map { (account, hosts) ->
            val stale = now - account.checkedAt > FRESH_MS
            LimitAccount(account.label, account.plan, account.tone, account.mark, hosts.size, account.checkedAt, stale,
                account.windows.map { window ->
                    val left = (100 - window.usedPercent).roundToLong().toInt().coerceIn(0, 100)
                    // The juicebars' own level and pace come with the snapshot; a stale reading shows neither.
                    val level = if (stale) Level.STALE else window.level ?: Level.NONE
                    val pace = if (stale) null else window.pace
                    LimitWindow(window.label, window.short.ifEmpty { window.label.take(2).lowercase() }, left, window.resetsAt?.takeIf { it > now }, level, pace, window.paceAt)
                })
        }.sortedWith(compareBy<LimitAccount> { it.tone.ordinal }.thenBy { it.label })
        val candidates = accounts.filter { !it.stale }.ifEmpty { accounts }
        val lowest = candidates.flatMap { account -> account.windows.map { account to it } }.minByOrNull { it.second.left }
        val stale = accounts.isNotEmpty() && accounts.all { it.stale }
        val newestHost = snapshots.filter { !it.accounts.isNullOrEmpty() }.maxByOrNull { it.updatedAt }?.hostId
        return PlanLimits(accounts, lowest, accounts.maxOfOrNull { it.checkedAt } ?: 0, stale, newestHost)
    }

    fun threadBoard(snapshots: Collection<Snapshot>, now: Long): ThreadBoard {
        val items = snapshots.flatMap { snapshot ->
            snapshot.threads.filter { thread ->
                if (thread.state.active) now - thread.updatedAt <= ACTIVE_MS else now - thread.since <= FINISHED_MS
            }.map { ThreadItem(snapshot.hostId, snapshot.machine, it) }
        }.sortedWith(compareBy<ThreadItem> { it.thread.state.rank }.thenBy { if (it.thread.state.active) it.thread.since else -it.thread.since })
        val count = { state: ThreadState -> items.count { it.thread.state == state } }
        val newest = snapshots.maxOfOrNull { snapshot -> maxOf(snapshot.updatedAt, snapshot.threads.maxOfOrNull { it.updatedAt } ?: 0) } ?: 0
        val stale = items.any { it.thread.state.active } && now - newest > FRESH_MS
        return ThreadBoard(items, count(ThreadState.QUESTION), count(ThreadState.RUNNING), count(ThreadState.DONE), count(ThreadState.FAILED), stale, newest)
    }

    /** The one bundled notification: ongoing while anything runs or asks, briefly dismissable after. */
    fun notice(board: ThreadBoard, now: Long): Notice? {
        val active = board.items.filter { it.thread.state.active }
        if (active.isNotEmpty()) {
            val running = active.filter { it.thread.state == ThreadState.RUNNING }
            val question = active.firstOrNull { it.thread.state == ThreadState.QUESTION }
            val title = if (active.size == 1) active[0].thread.title else counts(board.questions, board.running)
            return Notice(
                ongoing = true, title = title, items = active, single = active.size == 1,
                chronometerFrom = (running.minOfOrNull { it.thread.since } ?: active[0].thread.since),
                chronometer = running.isNotEmpty(), question = question, tap = active[0],
                signature = active.joinToString("|") { "${it.hostId}:${it.thread.id}:${it.thread.state.key}" },
            )
        }
        val done = board.items.filter { !it.thread.state.active && now - it.thread.since <= DONE_NOTICE_MS }
        if (done.isEmpty()) return null
        val failed = done.count { it.thread.state == ThreadState.FAILED }
        val title = if (done.size == 1) done[0].thread.title else listOfNotNull(
            (done.size - failed).takeIf { it > 0 }?.let { "$it done" }, failed.takeIf { it > 0 }?.let { "$it failed" },
        ).joinToString(", ")
        return Notice(
            ongoing = false, title = title, items = done, single = done.size == 1, chronometerFrom = done[0].thread.since,
            chronometer = false, question = null, tap = done[0],
            signature = done.joinToString("|") { "${it.hostId}:${it.thread.id}:${it.thread.state.key}" },
        )
    }

    /** When the drawing changes without new data: a reading turns stale, a finished thread leaves. */
    fun nextChange(snapshots: Collection<Snapshot>, now: Long): Long? = snapshots.flatMap { snapshot ->
        snapshot.accounts.orEmpty().map { it.checkedAt + FRESH_MS } + snapshot.threads.flatMap { thread ->
            if (thread.state.active) listOf(thread.updatedAt + FRESH_MS, thread.updatedAt + ACTIVE_MS)
            else listOf(thread.since + DONE_NOTICE_MS, thread.since + FINISHED_MS)
        } + (snapshot.updatedAt + FRESH_MS)
    }.filter { it > now }.minOrNull()

    fun counts(questions: Int, running: Int): String = listOfNotNull(
        questions.takeIf { it > 0 }?.let { if (it == 1) "1 question" else "$it questions" },
        running.takeIf { it > 0 }?.let { "$it running" },
    ).joinToString(", ")

    /** "in 40 min", "in 2 h", "in 2 d": coarse, since a widget does not redraw every minute. */
    fun resetsIn(now: Long, at: Long?): String? {
        if (at == null || at <= now) return null
        val minutes = (at - now + 59_999) / 60_000
        return when {
            minutes < 60 -> "in $minutes min"
            minutes < 24 * 60 -> "in ${minutes / 60} h"
            else -> "in ${(minutes / (24 * 60.0)).roundToLong()} d"
        }
    }

    /** "runs out Thu", "spent", "above pace": what the large widget says of a window's pace; nothing when it is on pace. */
    fun paceLabel(window: LimitWindow, now: Long, zone: ZoneId = ZoneId.systemDefault()): String? = when (window.pace) {
        Pace.SPENT -> "spent"
        Pace.RUNS_OUT -> "runs out " + (window.paceAt?.let { day(it, now, zone) } ?: "soon")
        Pace.AHEAD -> "above pace"
        else -> null
    }

    /** A time today, else the weekday ("14:32", "Thu"), as the iPhone's widgets say it. */
    fun day(at: Long, now: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        val date = Instant.ofEpochMilli(at).atZone(zone)
        return if (date.toLocalDate() == Instant.ofEpochMilli(now).atZone(zone).toLocalDate()) "%02d:%02d".format(date.hour, date.minute)
        else date.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.getDefault())
    }

    /** "Codex weekly": the account's first word and the window, as the 2 × 2 names the lowest. */
    fun windowName(account: LimitAccount, window: LimitWindow): String =
        "${account.label.substringBefore(' ').substringBefore('·').trim()} ${window.label.lowercase()}".trim()
}

enum class Tone(val key: String) {
    OPENAI("openai"), ANTHROPIC("anthropic"), GOOGLE("google"), PI("pi"), OTHER("other");
    companion object { fun of(key: String): Tone = entries.firstOrNull { it.key == key } ?: OTHER }
}

enum class Level(val key: String) {
    NONE(""), WARN("warn"), FAIL("fail"), STALE("stale");
    companion object { fun of(key: String): Level? = entries.firstOrNull { it.key.isNotEmpty() && it.key == key && it != STALE } }
}

enum class Pace(val key: String) {
    ON("on"), AHEAD("ahead"), RUNS_OUT("runs-out"), SPENT("spent");
    companion object { fun of(key: String): Pace? = entries.firstOrNull { it.key == key } }
}

enum class ThreadState(val key: String, val rank: Int, val active: Boolean) {
    QUESTION("question", 0, true), RUNNING("running", 1, true), DONE("done", 2, false), FAILED("failed", 2, false);
    companion object { fun of(key: String): ThreadState? = entries.firstOrNull { it.key == key } }
}

data class Window(val label: String, val short: String, val usedPercent: Double, val resetsAt: Long?, val level: Level?, val pace: Pace?, val paceAt: Long?)
data class Account(val poolKey: String?, val label: String, val plan: String?, val tone: Tone, val mark: String?, val checkedAt: Long, val windows: List<Window>)
data class Thread(val id: String, val title: String, val project: String?, val state: ThreadState, val since: Long, val updatedAt: Long, val detail: String?)
data class Snapshot(val hostId: String, val machine: String, val updatedAt: Long, val accounts: List<Account>?, val threads: List<Thread>)

data class LimitWindow(val label: String, val short: String, val left: Int, val resetsAt: Long?, val level: Level, val pace: Pace? = null, val paceAt: Long? = null)
data class LimitAccount(val label: String, val plan: String?, val tone: Tone, val mark: String?, val machines: Int, val checkedAt: Long, val stale: Boolean, val windows: List<LimitWindow>)
data class PlanLimits(val accounts: List<LimitAccount>, val lowest: Pair<LimitAccount, LimitWindow>?, val asOf: Long, val stale: Boolean, val hostId: String?)

data class ThreadItem(val hostId: String, val machine: String, val thread: Thread)
data class ThreadBoard(val items: List<ThreadItem>, val questions: Int, val running: Int, val done: Int, val failed: Int, val stale: Boolean, val asOf: Long)
data class Notice(
    val ongoing: Boolean, val title: String, val items: List<ThreadItem>, val single: Boolean,
    val chronometerFrom: Long, val chronometer: Boolean, val question: ThreadItem?, val tap: ThreadItem, val signature: String,
)
