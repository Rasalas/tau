package de.tbuck.tau;

import android.app.Activity;
import android.appwidget.AppWidgetHost;
import android.appwidget.AppWidgetHostView;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.ComponentName;
import android.content.Context;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.SizeF;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;
import de.tbuck.tau.plugin.UsageWidget;
import de.tbuck.tau.plugin.widgets.ThreadsReceiver;
import de.tbuck.tau.plugin.widgets.WidgetRefresh;
import de.tbuck.tau.plugin.widgets.WidgetStore;
import java.util.Collections;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Debug only: hosts both widgets at the mocks' sizes (Pixel 9, dp) with the mocks' sample data, and
 * posts the bundled notification, so an emulator shows every state. Needs
 * `adb shell appwidget grantbind --package de.tbuck.tau`.
 *
 *   am start -n de.tbuck.tau/.WidgetGalleryActivity --es kind limits|threads --es scene full|stale|spent|empty|quiet|one|ask|done
 */
public class WidgetGalleryActivity extends Activity {
    private static final int HOST = 0x7a0;
    private static final long MIN = 60_000L;
    private AppWidgetHost host;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        String kind = getIntent().getStringExtra("kind");
        String scene = getIntent().getStringExtra("scene");
        if (kind == null) kind = "limits";
        if (scene == null) scene = "full";
        try { seed(this, scene); } catch (Exception error) { throw new IllegalStateException(error); }

        host = new AppWidgetHost(this, HOST);
        host.deleteHost();
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        column.setPadding(0, dp(56), 0, 0);
        int night = getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
        boolean dark = night == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        // A wallpaper stand-in in the dynamic palette's own colours.
        int top = getColor(dark ? android.R.color.system_accent1_800 : android.R.color.system_accent1_100);
        int bottom = getColor(dark ? android.R.color.system_neutral1_900 : android.R.color.system_accent2_300);
        column.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[] { top, bottom }));
        TextView caption = new TextView(this);
        caption.setText(kind + " · " + scene + " · " + (dark ? "dark" : "light"));
        caption.setTextColor(getColor(dark ? android.R.color.system_neutral1_100 : android.R.color.system_neutral1_800));
        caption.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        column.addView(caption);
        ComponentName provider = new ComponentName(this, "threads".equals(kind) ? ThreadsReceiver.class : UsageWidget.class);
        column.addView(widget(provider, 176, 176));
        column.addView(widget(provider, 376, 176));
        column.addView(widget(provider, 376, 268));
        setContentView(column);
        WidgetRefresh.request(this);
    }

    @Override protected void onStart() { super.onStart(); host.startListening(); }
    @Override protected void onStop() { super.onStop(); host.stopListening(); }

    private AppWidgetHostView widget(ComponentName provider, int width, int height) {
        AppWidgetManager manager = AppWidgetManager.getInstance(this);
        int id = host.allocateAppWidgetId();
        if (!manager.bindAppWidgetIdIfAllowed(id, provider)) throw new IllegalStateException("Run: adb shell appwidget grantbind --package " + getPackageName());
        AppWidgetProviderInfo info = manager.getAppWidgetInfo(id);
        AppWidgetHostView view = host.createView(this, id, info);
        if (Build.VERSION.SDK_INT >= 31) view.updateAppWidgetSize(new Bundle(), Collections.singletonList(new SizeF(width, height)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(width), dp(height));
        params.topMargin = dp(16);
        view.setLayoutParams(params);
        return view;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    /** The mocks' sample data (`.scratch/design/widgets/src/mocks.js`), relative to now, in the app's snapshot form. */
    static void seed(Context context, String scene) throws Exception {
        long now = System.currentTimeMillis();
        for (String host : new String[] { "macbook", "mac-mini", "hetzner" }) WidgetStore.clear(context, host);
        if ("empty".equals(scene)) return;
        long checked = "stale".equals(scene) ? now - 122 * MIN : now - 3 * MIN;
        JSONArray accounts = new JSONArray()
            .put(account("Codex", "ChatGPT Plus", "openai", "codex", "openai:k", checked, window("5-hour", "5h", 34, now + 158 * MIN), window("Weekly", "wk", 91, now + 43 * 60 * MIN, "warn", "runs-out", now + 27 * 60 * MIN)))
            .put(account("Claude Code", "Max", "anthropic", "claude-code", "anthropic:k", checked, "spent".equals(scene) ? window("5-hour", "5h", 100, now + 68 * MIN, "fail", "spent", 0) : window("5-hour", "5h", 12, now + 68 * MIN), window("Weekly", "wk", 47, now + 5 * 24 * 60 * MIN)))
            .put(account("OpenCode Go", null, "other", "opencode", null, checked, window("Monthly", "mo", 22, now + 31 * 24 * 60 * MIN)));
        JSONArray macbook = new JSONArray(), mini = new JSONArray(), hetzner = new JSONArray();
        switch (scene) {
            case "one": mini.put(thread("t2", "Fix flaky pairing test", "tau", "running", now - 12 * MIN - 4_000, null)); break;
            case "ask": macbook.put(thread("t1", "Add pagination to all list endpoints", "shop-api", "question", now - 4 * MIN, "wants to edit src/routes/orders.ts")); break;
            case "done": mini.put(thread("t2", "Fix flaky pairing test", "tau", "done", now - MIN, null)); break;
            case "quiet":
                hetzner.put(thread("t4", "Nightly dependency audit", "tau", "done", now - 6 * MIN, null));
                mini.put(thread("t5", "Migrate CI cache to R2", "infra", "failed", now - 20 * MIN, null));
                break;
            default:
                macbook.put(thread("t1", "Add pagination to all list endpoints", "shop-api", "question", now - 4 * MIN, "wants to edit src/routes/orders.ts"));
                mini.put(thread("t2", "Fix flaky pairing test", "tau", "running", now - 12 * MIN - 4_000, null));
                mini.put(thread("t3", "Rate limiting for checkout endpoint", "shop-api", "running", now - 3 * MIN - 41_000, null));
                hetzner.put(thread("t4", "Nightly dependency audit", "tau", "done", now - 6 * MIN, null));
                mini.put(thread("t5", "Migrate CI cache to R2", "infra", "failed", now - 20 * MIN, null));
        }
        long updated = "stale".equals(scene) ? checked : now;
        WidgetStore.save(context, snapshot("macbook", "MacBook", updated, accounts, macbook));
        WidgetStore.save(context, snapshot("mac-mini", "Mac mini", updated, new JSONArray().put(accounts.getJSONObject(1)), mini));
        WidgetStore.save(context, snapshot("hetzner", "hetzner-1", updated, null, hetzner));
    }

    private static JSONObject snapshot(String host, String machine, long updated, JSONArray accounts, JSONArray threads) throws Exception {
        JSONObject value = new JSONObject().put("version", 3).put("hostId", host).put("machine", machine).put("updatedAt", updated).put("threads", threads);
        if (accounts != null) value.put("accounts", accounts);
        return value;
    }

    private static JSONObject account(String label, String plan, String tone, String mark, String pool, long checked, JSONObject... windows) throws Exception {
        JSONObject value = new JSONObject().put("label", label).put("tone", tone).put("mark", mark).put("checkedAt", checked);
        if (plan != null) value.put("plan", plan);
        if (pool != null) value.put("poolKey", pool);
        JSONArray list = new JSONArray();
        for (JSONObject window : windows) list.put(window);
        return value.put("windows", list);
    }

    private static JSONObject window(String label, String shortLabel, double used, long resets) throws Exception {
        return window(label, shortLabel, used, resets, null, "on", 0);
    }

    private static JSONObject window(String label, String shortLabel, double used, long resets, String level, String pace, long paceAt) throws Exception {
        JSONObject value = new JSONObject().put("label", label).put("short", shortLabel).put("usedPercent", used).put("resetsAt", resets).put("pace", pace);
        if (level != null) value.put("level", level);
        if (paceAt > 0) value.put("paceAt", paceAt);
        return value;
    }

    private static JSONObject thread(String id, String title, String project, String state, long since, String detail) throws Exception {
        boolean asks = "question".equals(state);
        JSONObject value = new JSONObject().put("id", id).put("title", title).put("project", project).put("state", asks ? "waiting" : state);
        if ("running".equals(state)) value.put("startedAt", since);
        else if (asks) value.put("startedAt", since - 6 * MIN).put("askedAt", since);
        else value.put("startedAt", since - 30 * MIN).put("endedAt", since);
        if (detail != null) value.put("reason", detail);
        return value;
    }
}
