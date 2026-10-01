package de.tbuck.tau.plugin.widgets

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.LinearProgressIndicator
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
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
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider

/** "Plan limits": 2 × 2 juicebars and the lowest rest, 4 × 2 a row per account, 4 × 3 a row per window. */
class PlanLimitsWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(SMALL, WIDE, LARGE))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            val version by WidgetStore.version.collectAsState()
            val now = remember(version) { System.currentTimeMillis() }
            val limits = remember(version) { WidgetModel.planLimits(WidgetStore.snapshots(context), now) }
            GlanceTheme { PlanLimits(limits, now) }
        }
    }

    companion object {
        val SMALL = DpSize(110.dp, 110.dp)
        val WIDE = DpSize(250.dp, 110.dp)
        val LARGE = DpSize(250.dp, 210.dp)
    }
}

@Composable
internal fun PlanLimits(limits: PlanLimits, now: Long) {
    val context = LocalContext.current
    val size = LocalSize.current
    Ui.Surface(Ui.open(context, limits.hostId)) {
        when {
            limits.accounts.isEmpty() -> Ui.Empty("No plan limits yet", "Open Tau once with a paired machine.")
            size.width >= PlanLimitsWidget.WIDE.width && size.height >= PlanLimitsWidget.LARGE.height -> Large(limits, now)
            size.width >= PlanLimitsWidget.WIDE.width -> Wide(limits, now)
            else -> Small(limits, now)
        }
    }
}

/** A stale bar keeps its length and loses its colour. */
@Composable
private fun barColour(window: LimitWindow, account: LimitAccount): ColorProvider = when (window.level) {
    Level.WARN -> Ui.warnBar
    Level.FAIL -> Ui.fail
    Level.STALE -> GlanceTheme.colors.outline
    Level.NONE -> Ui.tone(account.tone)
}

@Composable
private fun valueColour(window: LimitWindow): ColorProvider? = when (window.level) {
    Level.WARN -> Ui.warn
    Level.FAIL -> Ui.failInk
    Level.STALE -> GlanceTheme.colors.onSurfaceVariant
    else -> null
}

@Composable
private fun Small(limits: PlanLimits, now: Long) {
    val context = LocalContext.current
    Column(GlanceModifier.fillMaxSize()) {
        Ui.Header("Plan limits", Ui.shortTime(context, limits.asOf), limits.stale, tight = limits.stale)
        Box(GlanceModifier.fillMaxWidth().defaultWeight(), contentAlignment = Alignment.Center) { Juicebars(limits.accounts, barWidth = 9, barHeight = 36) }
        limits.lowest?.let { (account, window) -> Lowest(account, window, limits.stale, now, big = 28) }
    }
}

@Composable
private fun Lowest(account: LimitAccount, window: LimitWindow, stale: Boolean, now: Long, big: Int) {
    val colour = if (stale) GlanceTheme.colors.onSurfaceVariant else valueColour(window) ?: GlanceTheme.colors.onSurface
    Row(verticalAlignment = Alignment.Bottom) {
        Text("${window.left}%", style = TextStyle(color = colour, fontSize = big.sp, fontWeight = FontWeight.Bold))
        Text(" left", modifier = GlanceModifier.padding(bottom = 4.dp), style = TextStyle(color = colour, fontSize = 13.sp, fontWeight = FontWeight.Medium))
    }
    Row {
        Text(WidgetModel.windowName(account, window), maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 12.sp, fontWeight = FontWeight.Medium))
        WidgetModel.resetsIn(now, window.resetsAt)?.let { Text(" · $it", maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp)) }
    }
}

/** Standing bars, filled from below with what is left, one group per account with its mark below. */
@Composable
private fun Juicebars(accounts: List<LimitAccount>, barWidth: Int, barHeight: Int, numbers: Boolean = false) {
    Row(verticalAlignment = Alignment.Bottom) {
        accounts.take(6).forEachIndexed { index, account ->
            Column(GlanceModifier.padding(start = if (index == 0) 0.dp else if (numbers) 16.dp else 13.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Row(verticalAlignment = Alignment.Bottom) {
                    account.windows.take(3).forEachIndexed { at, window ->
                        if (at > 0) Spacer(GlanceModifier.width(if (numbers) 5.dp else 3.dp))
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Box(GlanceModifier.width(barWidth.dp).height(barHeight.dp).cornerRadius(4.dp).background(trackColour(window)), contentAlignment = Alignment.BottomCenter) {
                                val fill = barHeight * window.left / 100
                                if (fill > 0) Box(GlanceModifier.width(barWidth.dp).height(fill.dp).cornerRadius(if (fill > 6) 4.dp else 0.dp).background(barColour(window, account))) {}
                            }
                            if (numbers) {
                                Text("${window.left}", style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 11.sp, fontWeight = FontWeight.Medium))
                                Text(window.short, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 10.sp))
                            }
                        }
                    }
                }
                Spacer(GlanceModifier.height(5.dp))
                Ui.Mark(account, 12.dp)
            }
        }
    }
}

@Composable
private fun trackColour(window: LimitWindow): ColorProvider = if (window.level == Level.FAIL) Ui.failSoft else GlanceTheme.colors.surfaceVariant

/** 4 × 2, choice B: one row per account with its name and its first two windows as lying bars. */
@Composable
private fun Wide(limits: PlanLimits, now: Long) {
    val context = LocalContext.current
    Column(GlanceModifier.fillMaxSize()) {
        Ui.Header("Plan limits", if (limits.stale) Ui.time(context, limits.asOf) else "as of ${Ui.time(context, limits.asOf)}", limits.stale)
        Column(GlanceModifier.fillMaxWidth().defaultWeight().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            limits.accounts.take(3).forEachIndexed { index, account ->
                if (index > 0) Spacer(GlanceModifier.height(6.dp))
                Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Ui.Mark(account, 16.dp)
                    Spacer(GlanceModifier.width(9.dp))
                    Column(GlanceModifier.width(86.dp)) {
                        Text(account.label, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 12.5f.sp, fontWeight = FontWeight.Medium))
                        Text(account.plan ?: machines(account) ?: " ", maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp))
                    }
                    Spacer(GlanceModifier.width(9.dp))
                    Cell(account, account.windows.getOrNull(0), now, GlanceModifier.defaultWeight())
                    Spacer(GlanceModifier.width(9.dp))
                    Cell(account, account.windows.getOrNull(1), now, GlanceModifier.defaultWeight())
                }
            }
        }
    }
}

private fun machines(account: LimitAccount): String? = if (account.machines > 1) "${account.machines} machines" else null

@Composable
private fun Cell(account: LimitAccount, window: LimitWindow?, now: Long, modifier: GlanceModifier) {
    Column(modifier) {
        if (window == null) return@Column
        Row(GlanceModifier.fillMaxWidth()) {
            Text(listOfNotNull(window.short, WidgetModel.resetsIn(now, window.resetsAt)).joinToString(" · "), maxLines = 1, modifier = GlanceModifier.defaultWeight(),
                style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp))
            Text("${window.left}%", maxLines = 1,
                style = TextStyle(color = valueColour(window) ?: GlanceTheme.colors.onSurface, fontSize = 11.sp, fontWeight = FontWeight.Medium))
        }
        Spacer(GlanceModifier.height(3.dp))
        Bar(account, window)
    }
}

@Composable
private fun Bar(account: LimitAccount, window: LimitWindow, modifier: GlanceModifier = GlanceModifier.fillMaxWidth()) {
    LinearProgressIndicator(progress = window.left / 100f, modifier = modifier.height(5.dp).cornerRadius(3.dp), color = barColour(window, account), backgroundColor = trackColour(window))
}

/** 4 × 3: per account its name, plan and machines, then each window with bar, rest and reset. */
@Composable
private fun Large(limits: PlanLimits, now: Long) {
    val context = LocalContext.current
    // Glance allows ten children per container: accounts and their windows are capped to what fits anyway.
    var rows = 0
    val shown = limits.accounts.take(4).mapNotNull { account ->
        val room = 9 - rows - 1
        if (room <= 0) null else account.copy(windows = account.windows.take(minOf(room, 4))).also { rows += 1 + it.windows.size }
    }
    Column(GlanceModifier.fillMaxSize()) {
        Ui.Header("Plan limits", if (limits.stale) Ui.time(context, limits.asOf) else "as of ${Ui.time(context, limits.asOf)}", limits.stale)
        shown.forEachIndexed { index, account ->
            Column(GlanceModifier.fillMaxWidth().padding(top = if (index == 0) 8.dp else 7.dp)) {
                Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Ui.Mark(account, 14.dp)
                    Text(account.label, maxLines = 1, modifier = GlanceModifier.padding(start = 6.dp), style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 12.5f.sp, fontWeight = FontWeight.Medium))
                    account.plan?.let { Text(it, maxLines = 1, modifier = GlanceModifier.padding(start = 6.dp), style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp)) }
                    Spacer(GlanceModifier.defaultWeight())
                    machines(account)?.let { Text(it, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp)) }
                }
                for (window in account.windows) {
                    val pace = WidgetModel.paceLabel(window, now)
                    Row(GlanceModifier.fillMaxWidth().padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(GlanceModifier.width(66.dp)) {
                            Text(window.label, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.5f.sp))
                            if (pace != null) Text(pace, maxLines = 1, style = TextStyle(color = if (window.pace == Pace.SPENT) Ui.failInk else Ui.warn, fontSize = 10.sp))
                        }
                        Bar(account, window, GlanceModifier.defaultWeight())
                        Text("${window.left}%", maxLines = 1, modifier = GlanceModifier.width(44.dp),
                            style = TextStyle(color = valueColour(window) ?: GlanceTheme.colors.onSurface, fontSize = 11.5f.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.End))
                        Text(WidgetModel.resetsIn(now, window.resetsAt) ?: "", maxLines = 1, modifier = GlanceModifier.width(52.dp).padding(start = 8.dp),
                            style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp))
                    }
                }
            }
        }
    }
}
