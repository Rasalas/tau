package de.tbuck.tau.plugin.widgets

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject

/** The hosts' last snapshots, one per host, kept until the host is forgotten (stale values stay drawn). */
object WidgetStore {
    private const val PREFS = "tau-widgets"
    private const val PREFIX = "snapshot."
    private val changes = MutableStateFlow(0L)

    /** Bumped on every write and tick; the widgets' compositions read the store again. */
    val version: StateFlow<Long> get() = changes

    fun snapshots(context: Context): List<Snapshot> =
        prefs(context).all.filterKeys { it.startsWith(PREFIX) }.values.mapNotNull { (it as? String)?.let(WidgetModel::parse) }

    /** From the app: a missing usage part keeps the last one, and a pushed thread newer than the snapshot stays. */
    @JvmStatic fun save(context: Context, value: JSONObject) {
        val next = WidgetModel.snapshot(value) ?: return
        synchronized(this) {
            val previous = read(context, next.hostId)
            val pushed = previous?.threads.orEmpty().filter { kept -> kept.updatedAt > next.updatedAt && next.threads.none { it.id == kept.id } }
            write(context, next.copy(
                machine = next.machine.ifEmpty { previous?.machine.orEmpty() },
                accounts = next.accounts ?: previous?.accounts,
                threads = pushed + next.threads.map { thread -> previous?.threads?.firstOrNull { it.id == thread.id && it.updatedAt > thread.updatedAt } ?: thread },
            ))
        }
        WidgetRefresh.request(context)
    }

    /** A per-thread activity, from the app or a push in the background. */
    @JvmStatic fun activity(context: Context, value: JSONObject) {
        synchronized(this) {
            val next = WidgetModel.withActivity(read(context, value.optString("hostId")), value, System.currentTimeMillis()) ?: return
            write(context, next)
        }
        WidgetRefresh.request(context)
    }

    @JvmStatic fun clear(context: Context, hostId: String) {
        prefs(context).edit().remove(PREFIX + hostId).apply()
        WidgetRefresh.request(context)
    }

    fun touch() { changes.value = changes.value + 1 }

    private fun read(context: Context, hostId: String): Snapshot? = prefs(context).getString(PREFIX + hostId, null)?.let(WidgetModel::parse)

    private fun write(context: Context, snapshot: Snapshot) {
        prefs(context).edit().putString(PREFIX + snapshot.hostId, WidgetModel.toJson(snapshot).toString()).apply()
    }

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
