package de.tbuck.tau.plugin;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import org.json.JSONArray;
import org.json.JSONObject;

public final class UsageWidget extends AppWidgetProvider {
    public static void save(Context context, JSONObject snapshot) {
        String host = snapshot.optString("hostId");
        if (host.isEmpty()) return;
        context.getSharedPreferences("tau-usage", Context.MODE_PRIVATE).edit().putString(host, snapshot.toString()).apply();
        refresh(context);
    }
    public static void refresh(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        new UsageWidget().onUpdate(context, manager, manager.getAppWidgetIds(new ComponentName(context, UsageWidget.class)));
    }
    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        StringBuilder rows = new StringBuilder();
        long now = System.currentTimeMillis();
        java.util.Map<String, JSONObject> pooled = new java.util.TreeMap<>();
        for (Object value : context.getSharedPreferences("tau-usage", Context.MODE_PRIVATE).getAll().values()) {
            try {
                JSONObject snapshot = new JSONObject((String) value);
                if (snapshot.optLong("expiresAt") <= now) continue;
                JSONArray accounts = snapshot.optJSONArray("accounts");
                if (accounts == null) continue;
                for (int i = 0; i < accounts.length(); i++) {
                    JSONObject account = accounts.getJSONObject(i);
                    String identity = account.optString("poolKey", snapshot.optString("hostId") + ":" + i);
                    JSONObject prior = pooled.get(identity);
                    if (prior == null || account.optLong("checkedAt") >= prior.optLong("checkedAt")) pooled.put(identity, account);
                }
            } catch (Exception unreadable) { /* Ignore an invalid snapshot. */ }
        }
        for (JSONObject account : pooled.values()) {
            JSONArray windows = account.optJSONArray("windows");
            if (windows == null) continue;
            for (int j = 0; j < windows.length(); j++) { JSONObject window = windows.optJSONObject(j); if (window != null) rows.append(account.optString("label")).append(" · ").append(window.optString("label")).append(": ").append(window.optInt("usedPercent")).append("%\n"); }
        }
        int layout = context.getResources().getIdentifier("tau_usage_widget", "layout", context.getPackageName());
        int text = context.getResources().getIdentifier("tau_usage_text", "id", context.getPackageName());
        for (int id : ids) {
            RemoteViews view = new RemoteViews(context.getPackageName(), layout);
            view.setTextViewText(text, rows.length() == 0 ? "Tau usage\nOpen Tau to refresh" : rows.toString());
            Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
            if (launch != null) view.setOnClickPendingIntent(text, PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
            manager.updateAppWidget(id, view);
        }
    }
}
