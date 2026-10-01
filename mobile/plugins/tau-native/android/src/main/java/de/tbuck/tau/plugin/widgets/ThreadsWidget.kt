package de.tbuck.tau.plugin.widgets

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
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
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import de.tbuck.tau.plugin.R

/** "Threads": 2 × 2 the most urgent thread, 4 × 2 and 4 × 3 a list; every row opens its thread. */
class ThreadsWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(PlanLimitsWidget.SMALL, PlanLimitsWidget.WIDE, PlanLimitsWidget.LARGE))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            val version by WidgetStore.version.collectAsState()
            val now = remember(version) { System.currentTimeMillis() }
            val board = remember(version) { WidgetModel.threadBoard(WidgetStore.snapshots(context), now) }
            GlanceTheme { Threads(board, now) }
        }
    }
}

class ThreadsReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget = ThreadsWidget()
    override fun onEnabled(context: Context) { super.onEnabled(context); WidgetRefresh.request(context) }
    override fun onDisabled(context: Context) { super.onDisabled(context); WidgetRefresh.request(context) }
}

@Composable
internal fun Threads(board: ThreadBoard, now: Long) {
    val context = LocalContext.current
    val size = LocalSize.current
    val first = board.items.firstOrNull()
    val list = board.items.isNotEmpty() && size.width >= PlanLimitsWidget.WIDE.width
    Ui.Surface(Ui.open(context, first?.hostId, first?.thread?.id), vertical = if (list) 12.dp else 16.dp) {
        when {
            board.items.isEmpty() -> Ui.Empty("Nothing running", "Threads you start in Tau show here.")
            size.width >= PlanLimitsWidget.WIDE.width -> List(board, if (size.height >= PlanLimitsWidget.LARGE.height) 5 else 3)
            else -> Urgent(board)
        }
    }
}

/** 2 × 2, choice A: the thread that needs you most, and how many others run. */
@Composable
private fun Urgent(board: ThreadBoard) {
    val context = LocalContext.current
    val item = board.items.first()
    val thread = item.thread
    Column(GlanceModifier.fillMaxSize()) {
        Ui.Header("Threads", if (board.stale) Ui.time(context, board.asOf) else null, board.stale)
        Spacer(GlanceModifier.height(12.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Ui.StateIcon(thread.state, 16.dp)
            Spacer(GlanceModifier.width(5.dp))
            Status(thread, 12f, prefix = true)
        }
        Spacer(GlanceModifier.height(5.dp))
        Text(thread.title, maxLines = 2, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 15.sp, fontWeight = FontWeight.Medium))
        Spacer(GlanceModifier.height(3.dp))
        Where(item, 12f)
        Spacer(GlanceModifier.defaultWeight())
        val others = board.items.drop(1).filter { it.thread.state.active }
        if (others.isNotEmpty()) {
            val asking = others.count { it.thread.state == ThreadState.QUESTION }
            val text = if (asking > 0) WidgetModel.counts(asking, others.size - asking) + " more" else "${others.size} more running"
            Row(verticalAlignment = Alignment.CenterVertically) {
                Image(ImageProvider(R.drawable.tau_ic_running), contentDescription = null, modifier = GlanceModifier.size(11.dp), colorFilter = ColorFilter.tint(Ui.infoInk))
                Spacer(GlanceModifier.width(4.dp))
                Text(text, maxLines = 1, style = TextStyle(color = Ui.infoInk, fontSize = 12.sp, fontWeight = FontWeight.Medium))
            }
        }
    }
}

/** Question in amber, running as a live timer, done and failed with the time they ended. */
@Composable
private fun Status(thread: Thread, size: Float, prefix: Boolean = false) {
    val context = LocalContext.current
    val ink = Ui.stateInk(thread.state)
    val style = TextStyle(color = ink, fontSize = size.sp, fontWeight = FontWeight.Medium)
    when (thread.state) {
        ThreadState.RUNNING -> if (prefix) Ui.Chronometer(thread.since, Ui.stateColourRes(thread.state), 120.dp, size.sp, "Working · %s")
            else Ui.Chronometer(thread.since, Ui.stateColourRes(thread.state), 56.dp, size.sp, end = true)
        ThreadState.QUESTION -> if (prefix) Ui.Chronometer(thread.since, Ui.stateColourRes(thread.state), 120.dp, size.sp, "Question · %s") else Text("Question", maxLines = 1, style = style)
        else -> Text("${Ui.stateName(thread.state)} · ${Ui.time(context, thread.since)}", maxLines = 1, style = style)
    }
}

@Composable
private fun Where(item: ThreadItem, size: Float) {
    val style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = size.sp)
    Row(verticalAlignment = Alignment.CenterVertically) {
        item.thread.project?.let { Text("$it · ", maxLines = 1, style = style) }
        if (item.machine.isNotEmpty()) {
            Image(ImageProvider(R.drawable.tau_ic_monitor), contentDescription = null, modifier = GlanceModifier.size((size - 1).dp), colorFilter = ColorFilter.tint(GlanceTheme.colors.onSurfaceVariant))
            Text(" ${item.machine}", maxLines = 1, style = style)
        }
    }
}

@Composable
private fun List(board: ThreadBoard, rows: Int) {
    val context = LocalContext.current
    Column(GlanceModifier.fillMaxSize()) {
        Ui.Header("Threads", null, board.stale) {
            if (board.stale) {
                Image(ImageProvider(R.drawable.tau_ic_clock), contentDescription = "Stale", modifier = GlanceModifier.size(12.dp), colorFilter = ColorFilter.tint(Ui.warn))
                Text(" ${Ui.time(context, board.asOf)}", maxLines = 1, style = TextStyle(color = Ui.warn, fontSize = 12.sp, fontWeight = FontWeight.Medium))
            } else if (rows == 3) {
                if (board.done > 0) Text("${board.done} done", maxLines = 1, style = TextStyle(color = Ui.ready, fontSize = 12.sp))
                if (board.done > 0 && board.failed > 0) Text(" · ", style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp))
                if (board.failed > 0) Text("${board.failed} failed", maxLines = 1, style = TextStyle(color = Ui.failInk, fontSize = 12.sp, fontWeight = FontWeight.Medium))
            }
        }
        Column(GlanceModifier.fillMaxWidth().padding(top = 2.dp)) { board.items.take(rows).forEachIndexed { index, item ->
            if (index > 0) Box(GlanceModifier.fillMaxWidth().height(1.dp).background(GlanceTheme.colors.surfaceVariant)) {}
            Row(GlanceModifier.fillMaxWidth().padding(vertical = 2.dp).clickable(Ui.open(context, item.hostId, item.thread.id)), verticalAlignment = Alignment.CenterVertically) {
                Ui.StateIcon(item.thread.state)
                Spacer(GlanceModifier.width(9.dp))
                Column(GlanceModifier.defaultWeight()) {
                    Text(item.thread.title, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 13.sp, fontWeight = FontWeight.Medium))
                    Where(item, 11f)
                }
                Spacer(GlanceModifier.width(8.dp))
                Status(item.thread, 12f)
            }
        } }
    }
}
