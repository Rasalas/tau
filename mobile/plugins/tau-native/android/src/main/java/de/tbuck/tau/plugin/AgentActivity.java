package de.tbuck.tau.plugin;

import android.content.Context;
import de.tbuck.tau.plugin.widgets.WidgetStore;
import org.json.JSONObject;

/** A thread's activity, from the app or a push: it joins its host's widget snapshot and the one bundled notification. */
public final class AgentActivity {
    public static void update(Context context, JSONObject value) { WidgetStore.activity(context, value); }
    public static void clear(Context context, String host) { WidgetStore.clear(context, host); }
}
