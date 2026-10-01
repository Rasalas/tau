package de.tbuck.tau.plugin.widgets

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import androidx.glance.appwidget.updateAll
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Redraws both widgets and the bundled notification. New data comes only from the app or a push;
 * WorkManager just redraws when something turns stale or leaves (periodic work runs at most every
 * 15 min and Doze defers it, so this stays coarse).
 */
object WidgetRefresh {
    private const val NEXT = "tau-widgets-next"
    private const val PERIODIC = "tau-widgets-periodic"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val serial = Mutex()

    @JvmStatic fun request(context: Context) {
        val app = context.applicationContext
        scope.launch { run(app) }
    }

    suspend fun run(context: Context) = serial.withLock {
        WidgetStore.touch()
        val now = System.currentTimeMillis()
        val snapshots = WidgetStore.snapshots(context)
        PlanLimitsWidget().updateAll(context)
        ThreadsWidget().updateAll(context)
        RunningNotification.show(context, WidgetModel.notice(WidgetModel.threadBoard(snapshots, now), now))
        schedule(context, WidgetModel.nextChange(snapshots, now), now)
    }

    private fun schedule(context: Context, next: Long?, now: Long) {
        val work = WorkManager.getInstance(context)
        if (next != null) {
            work.enqueueUniqueWork(NEXT, ExistingWorkPolicy.REPLACE, OneTimeWorkRequestBuilder<TickWorker>()
                .setInitialDelay((next - now).coerceAtLeast(60_000L), TimeUnit.MILLISECONDS).build())
        } else work.cancelUniqueWork(NEXT)
        if (hasWidgets(context)) {
            work.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, PeriodicWorkRequestBuilder<TickWorker>(30, TimeUnit.MINUTES).build())
        } else work.cancelUniqueWork(PERIODIC)
    }

    private fun hasWidgets(context: Context): Boolean {
        val manager = AppWidgetManager.getInstance(context) ?: return false
        return listOf(de.tbuck.tau.plugin.UsageWidget::class.java, ThreadsReceiver::class.java).any { manager.getAppWidgetIds(ComponentName(context, it)).isNotEmpty() }
    }

    class TickWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
        override suspend fun doWork(): Result { run(applicationContext); return Result.success() }
    }
}
