package de.tbuck.tau.plugin.widgets

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import de.tbuck.tau.plugin.R

/**
 * One notification for every running thread, not one each (K163, choice B). Ongoing while a thread
 * runs or asks; on Android 16 a promoted "Live Update" with a status bar chip. Never asks for the
 * notification permission: without it the widgets alone show the threads.
 */
object RunningNotification {
    private const val CHANNEL = "tau-agent-activity"
    private const val TAG = "tau-threads"
    private const val PREFS = "tau-widgets-notice"

    fun show(context: Context, notice: Notice?) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (notice == null) {
            manager.cancel(TAG, 0)
            saved.edit().remove("signature").apply()
            return
        }
        // Unchanged: leave it, so a dismissed one stays dismissed and the chronometer does not jump.
        val signature = notice.signature + "\u0000" + notice.title
        if (saved.getString("signature", null) == signature) return
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Agent activity", NotificationManager.IMPORTANCE_DEFAULT))
        }
        try {
            manager.notify(TAG, 0, build(context, notice))
            saved.edit().putString("signature", signature).apply()
        } catch (_: SecurityException) { /* Denied after the check: the widgets still show the threads. */ }
        cancelPerThread(manager)
    }

    fun build(context: Context, notice: Notice): Notification {
        val now = System.currentTimeMillis()
        val top = notice.tap
        val machines = notice.items.map { it.machine }.filter { it.isNotEmpty() }.distinct()
        val builder = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.tau_glyph)
            .setColor(ContextCompat.getColor(context, R.color.tau_widget_brand))
            .setContentTitle(notice.title)
            .setContentIntent(open(context, top.hostId, top.thread.id))
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setOngoing(notice.ongoing)
            .setAutoCancel(!notice.ongoing)
            .setShowWhen(true)
            .setWhen(notice.chronometerFrom)
            .setUsesChronometer(notice.chronometer)
            .setSubText(if (notice.single) machines.firstOrNull() else "${notice.items.size} threads")
        val text = if (notice.single) line(context, top, withTitle = false) else notice.items.joinToString("\n") { line(context, it, withTitle = true) }
        builder.setContentText(text.substringBefore('\n')).setStyle(NotificationCompat.BigTextStyle().bigText(text))
        if (notice.ongoing) {
            if (Build.VERSION.SDK_INT >= 36) builder.setRequestPromotedOngoing(true)
            if (notice.question != null) builder.setShortCriticalText("Question")
            builder.setTimeoutAfter(WidgetModel.ACTIVE_MS)
        } else builder.setTimeoutAfter((WidgetModel.DONE_NOTICE_MS - (now - top.thread.since)).coerceAtLeast(60_000L))
        notice.question?.let { builder.addAction(0, "Answer", open(context, it.hostId, it.thread.id)) }
        if (notice.ongoing || !notice.single) builder.addAction(0, if (notice.single) "Open" else "Open Tau", open(context, top.hostId, null))
        return builder.build()
    }

    private fun line(context: Context, item: ThreadItem, withTitle: Boolean): String {
        val thread = item.thread
        val state = when (thread.state) {
            ThreadState.QUESTION -> thread.detail?.let { "Question · $it" } ?: "Question"
            ThreadState.RUNNING -> "Working since ${Ui.time(context, thread.since)}"
            else -> "${Ui.stateName(thread.state)} · ${Ui.time(context, thread.since)}"
        }
        val where = listOfNotNull(thread.project, item.machine.ifEmpty { null }).joinToString(" · ")
        return if (withTitle) "${thread.title} — $state" else listOf(state, where).filter { it.isNotEmpty() }.joinToString(" · ")
    }

    private fun open(context: Context, hostId: String, threadId: String?): PendingIntent {
        val url = Uri.Builder().scheme("tau").authority("thread").appendQueryParameter("host", hostId)
            .apply { if (threadId != null) appendQueryParameter("thread", threadId) }.build()
        val intent = Intent(Intent.ACTION_VIEW, url).setPackage(context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, url.toString().hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** The cards of earlier versions, one per thread, give way to the bundled one. */
    private fun cancelPerThread(manager: NotificationManager) {
        try {
            for (shown in manager.activeNotifications) if (shown.tag?.startsWith("activity:") == true) manager.cancel(shown.tag, shown.id)
        } catch (_: Exception) { /* Best effort. */ }
    }
}
