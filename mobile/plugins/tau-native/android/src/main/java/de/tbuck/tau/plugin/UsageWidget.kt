package de.tbuck.tau.plugin

import android.content.Context
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import de.tbuck.tau.plugin.widgets.PlanLimitsWidget
import de.tbuck.tau.plugin.widgets.WidgetRefresh

/** The Plan limits widget. Keeps the first widget's class name, so widgets already placed survive the update. */
class UsageWidget : GlanceAppWidgetReceiver() {
    override val glanceAppWidget = PlanLimitsWidget()
    override fun onEnabled(context: Context) { super.onEnabled(context); WidgetRefresh.request(context) }
    override fun onDisabled(context: Context) { super.onDisabled(context); WidgetRefresh.request(context) }
}
