package de.tbuck.tau.plugin.widgets

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.text.format.DateFormat
import android.util.TypedValue
import android.view.Gravity
import android.widget.RemoteViews
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.glance.ColorFilter
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.appwidget.AndroidRemoteViews
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontFamily
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import de.tbuck.tau.plugin.R
import java.util.Date
import java.util.Locale

/** Pieces both widgets share: Material You surfaces, Tau's state and provider colours. */
internal object Ui {
    val warn = ColorProvider(R.color.tau_widget_warn)
    val warnBar = ColorProvider(R.color.tau_widget_warn_bar)
    val warnSoft = ColorProvider(R.color.tau_widget_warn_soft)
    val fail = ColorProvider(R.color.tau_widget_fail)
    val failInk = ColorProvider(R.color.tau_widget_fail_ink)
    val failSoft = ColorProvider(R.color.tau_widget_fail_soft)
    val infoInk = ColorProvider(R.color.tau_widget_info_ink)
    val infoSoft = ColorProvider(R.color.tau_widget_info_soft)
    val ready = ColorProvider(R.color.tau_widget_ready)
    val doneSoft = ColorProvider(R.color.tau_widget_done_soft)

    fun tone(tone: Tone): ColorProvider = ColorProvider(when (tone) {
        Tone.OPENAI -> R.color.tau_widget_openai
        Tone.ANTHROPIC -> R.color.tau_widget_anthropic
        Tone.GOOGLE -> R.color.tau_widget_google
        Tone.PI -> R.color.tau_widget_pi
        Tone.OTHER -> R.color.tau_widget_other
    })

    /** The account's mark as the desktop draws it. */
    @Composable
    fun Mark(account: LimitAccount, size: Dp) = Mark(account.mark, account.initials, account.label, size)

    /**
     * A provider's mark as the desktop draws it: coloured marks keep their colours, the rest take the text colour, and a provider
     * without one its initials in a bordered box. `quiet` is the runtime's mark in a thread's stack, a shade fainter.
     */
    @Composable
    fun Mark(mark: String?, initials: String, name: String?, size: Dp, quiet: Boolean = false) {
        val ink = GlanceTheme.colors.onSurface
        val alpha = if (quiet) 0.7f else 1f
        val (drawable, tint) = when (mark) {
            "claude-code" -> R.drawable.tau_mark_claude to null
            "gemini" -> R.drawable.tau_mark_gemini to null
            "antigravity" -> R.drawable.tau_mark_antigravity to null
            "openai" -> R.drawable.tau_mark_openai to ink
            "anthropic" -> R.drawable.tau_mark_anthropic to ink
            "pi" -> R.drawable.tau_mark_pi to ink
            "opencode" -> R.drawable.tau_mark_opencode to ink
            "cursor" -> R.drawable.tau_mark_cursor to ink
            "grok" -> R.drawable.tau_mark_grok to ink
            else -> null to null
        }
        if (drawable != null) {
            Image(ImageProvider(drawable), contentDescription = name, alpha = alpha, modifier = GlanceModifier.size(size), colorFilter = tint?.let { ColorFilter.tint(it) })
            return
        }
        // The desktop's `.provider-icon-fallback`: a faint edge (the text colour at 14 %) and mono initials, half the box tall.
        val inkColor = ink.getColor(LocalContext.current)
        val edge = ColorProvider(inkColor.copy(alpha = 0.14f * alpha))
        Box(GlanceModifier.size(size), contentAlignment = Alignment.Center) {
            Image(ImageProvider(R.drawable.tau_mark_initials), contentDescription = name, modifier = GlanceModifier.size(size), colorFilter = ColorFilter.tint(edge))
            Text(initials, maxLines = 1, style = TextStyle(color = ColorProvider(inkColor.copy(alpha = alpha)), fontSize = (size.value * 0.5f).sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace))
        }
    }

    /** A thread's marks as the desktop's stack: the runtime's a shade fainter, then the model provider's. */
    @Composable
    fun ThreadMarks(marks: List<ThreadMark>, size: Dp = 12.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            marks.forEachIndexed { index, mark ->
                if (index > 0) Spacer(GlanceModifier.width(size / 2))
                Mark(mark.mark, mark.initials, null, size, quiet = marks.size > 1 && index == 0)
            }
        }
    }

    @Composable
    fun Surface(onClick: Action, vertical: Dp = 16.dp, content: @Composable () -> Unit) {
        Box(GlanceModifier.fillMaxSize().appWidgetBackground().background(GlanceTheme.colors.widgetBackground).cornerRadius(26.dp)
            .padding(horizontal = 16.dp, vertical = vertical).clickable(onClick)) { content() }
    }

    /** The τ badge, the widget's name and on the right its age: a clock in the warn colour once stale. */
    @Composable
    fun Header(title: String, age: String?, stale: Boolean, tight: Boolean = false, trailing: (@Composable () -> Unit)? = null) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = GlanceModifier.fillMaxWidth()) {
            // A stale 2 × 2 header tightens to keep "Plan limits" whole; the title yields before the age.
            Badge(if (tight) 18.dp else 20.dp)
            Spacer(GlanceModifier.width(if (tight) 5.dp else 7.dp))
            Text(title, maxLines = 1, modifier = GlanceModifier.defaultWeight(), style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = if (tight) 12.sp else 13.sp, fontWeight = FontWeight.Medium))
            if (trailing != null) trailing()
            else if (age != null) {
                if (stale) {
                    Image(ImageProvider(R.drawable.tau_ic_clock), contentDescription = "Stale", modifier = GlanceModifier.size(if (tight) 11.dp else 12.dp), colorFilter = ColorFilter.tint(warn))
                    Spacer(GlanceModifier.width(if (tight) 3.dp else 4.dp))
                }
                Text(age, maxLines = 1, style = TextStyle(color = if (stale) warn else GlanceTheme.colors.onSurfaceVariant, fontSize = if (tight) 11.5f.sp else 12.sp, fontWeight = if (stale) FontWeight.Medium else FontWeight.Normal))
            }
        }
    }

    @Composable
    fun Badge(size: Dp) {
        Box(GlanceModifier.size(size).cornerRadius(size / 2).background(GlanceTheme.colors.primaryContainer), contentAlignment = Alignment.Center) {
            Image(ImageProvider(R.drawable.tau_glyph), contentDescription = null, modifier = GlanceModifier.size(size * 0.56f), colorFilter = ColorFilter.tint(GlanceTheme.colors.onPrimaryContainer))
        }
    }

    @Composable
    fun Empty(title: String, body: String) {
        Column(GlanceModifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalAlignment = Alignment.CenterVertically) {
            Badge(30.dp)
            Spacer(GlanceModifier.height(10.dp))
            Text(title, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 14.sp, fontWeight = FontWeight.Bold, textAlign = androidx.glance.text.TextAlign.Center))
            Spacer(GlanceModifier.height(4.dp))
            Text(body, maxLines = 2, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp, textAlign = androidx.glance.text.TextAlign.Center))
        }
    }

    /** A thread state's round icon. A static ring stands for running: widgets do not animate. */
    @Composable
    fun StateIcon(state: ThreadState, size: Dp = 18.dp) {
        val (icon, ink, soft) = when (state) {
            ThreadState.QUESTION -> Triple(R.drawable.tau_ic_question, warn, warnSoft)
            ThreadState.RUNNING -> Triple(R.drawable.tau_ic_running, infoInk, infoSoft)
            ThreadState.DONE -> Triple(R.drawable.tau_ic_check, ready, doneSoft)
            ThreadState.FAILED -> Triple(R.drawable.tau_ic_alert, failInk, failSoft)
        }
        Box(GlanceModifier.size(size).cornerRadius(size / 2).background(soft), contentAlignment = Alignment.Center) {
            Image(ImageProvider(icon), contentDescription = stateName(state), modifier = GlanceModifier.size(size * 0.62f), colorFilter = ColorFilter.tint(ink))
        }
    }

    fun stateName(state: ThreadState): String = when (state) {
        ThreadState.QUESTION -> "Question"; ThreadState.RUNNING -> "Running"; ThreadState.DONE -> "Done"; ThreadState.FAILED -> "Failed"
    }

    fun stateInk(state: ThreadState): ColorProvider = when (state) {
        ThreadState.QUESTION -> warn; ThreadState.RUNNING -> infoInk; ThreadState.DONE -> ready; ThreadState.FAILED -> failInk
    }

    /** Elapsed time that ticks on the home screen without a redraw. `format` takes the time as `%s`. */
    @Composable
    fun Chronometer(since: Long, colour: Int, width: Dp, size: TextUnit = 12.sp, format: String? = null, end: Boolean = false) {
        val context = LocalContext.current
        val views = RemoteViews(context.packageName, R.layout.tau_widget_chronometer)
        val id = R.id.tau_widget_chronometer
        views.setChronometer(id, SystemClock.elapsedRealtime() - (System.currentTimeMillis() - since).coerceAtLeast(0), format, true)
        views.setTextViewTextSize(id, TypedValue.COMPLEX_UNIT_SP, size.value)
        if (Build.VERSION.SDK_INT >= 31) views.setColorStateList(id, "setTextColor", colour)
        else views.setTextColor(id, ContextCompat.getColor(context, colour))
        views.setInt(id, "setGravity", if (end) Gravity.END or Gravity.CENTER_VERTICAL else Gravity.START or Gravity.CENTER_VERTICAL)
        // A fixed width: left to wrap, the remote view takes the whole row.
        AndroidRemoteViews(views, GlanceModifier.width(width))
    }

    fun stateColourRes(state: ThreadState): Int = when (state) {
        ThreadState.QUESTION -> R.color.tau_widget_warn; ThreadState.RUNNING -> R.color.tau_widget_info_ink
        ThreadState.DONE -> R.color.tau_widget_ready; ThreadState.FAILED -> R.color.tau_widget_fail_ink
    }

    fun time(context: Context, at: Long): String = DateFormat.getTimeFormat(context).format(Date(at))

    /** "15:13" or "3:13": no AM/PM, so a 2 × 2 header fits on a 12-hour clock too. */
    fun shortTime(context: Context, at: Long): String =
        if (DateFormat.is24HourFormat(context)) time(context, at)
        else DateFormat.format(DateFormat.getBestDateTimePattern(Locale.getDefault(), "hmm").replace(Regex("\\s*a\\s*"), ""), at).toString()

    /** "Fri 09:00", or just the time today. */
    fun dayTime(context: Context, at: Long, now: Long): String {
        if (DateFormat.format("yyyyMMdd", at) == DateFormat.format("yyyyMMdd", now)) return time(context, at)
        val skeleton = if (DateFormat.is24HourFormat(context)) "EEEHHmm" else "EEEhmma"
        return DateFormat.format(DateFormat.getBestDateTimePattern(Locale.getDefault(), skeleton), at).toString()
    }

    /** `tau://thread?host=…[&thread=…]`, which the app opens (mobile/src/routes.ts); the launcher without a host. */
    fun open(context: Context, hostId: String?, threadId: String? = null): Action {
        val intent = if (hostId == null) context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent()
        else Intent(Intent.ACTION_VIEW, Uri.Builder().scheme("tau").authority("thread").appendQueryParameter("host", hostId)
            .apply { if (threadId != null) appendQueryParameter("thread", threadId) }.build())
        return actionStartActivity(intent.setPackage(context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
    }
}
