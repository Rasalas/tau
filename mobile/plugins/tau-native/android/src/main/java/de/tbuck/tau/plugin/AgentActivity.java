package de.tbuck.tau.plugin;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import org.json.JSONObject;

/** System-owned ongoing card. The agent runs on a host, so the phone needs no fake foreground service. */
public final class AgentActivity {
    private static final String CHANNEL = "tau-agent-activity";
    public static void update(Context context, JSONObject value) {
        String host = value.optString("hostId"); String thread = value.optString("threadId");
        String state = value.optString("state");
        long now = System.currentTimeMillis(); long expires = value.optLong("expiresAt");
        if (host.isEmpty() || thread.isEmpty() || expires <= now || !java.util.Set.of("running", "completed", "needs-input").contains(state)) return;
        String tag = "activity:" + host + ":" + thread;
        android.content.SharedPreferences saved = context.getSharedPreferences("tau-activities", Context.MODE_PRIVATE);
        if (value.optLong("updatedAt") < saved.getLong(tag, 0)) return;
        saved.edit().putLong(tag, value.optLong("updatedAt")).apply();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Agent activity", NotificationManager.IMPORTANCE_DEFAULT));
        Uri url = new Uri.Builder().scheme("tau").authority("thread").appendQueryParameter("host", host).appendQueryParameter("thread", thread).build();
        Intent intent = new Intent(Intent.ACTION_VIEW, url).setPackage(context.getPackageName()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(context, tag.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String text = state.equals("running") ? "Agent working" : state.equals("needs-input") ? "Your input needed" : "Completed";
        boolean ongoing = !state.equals("completed");
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(context.getApplicationInfo().icon).setContentTitle(value.optString("title", "Agent work"))
            .setContentText(text).setContentIntent(tap).setOnlyAlertOnce(true).setOngoing(ongoing)
            .setAutoCancel(!ongoing).setTimeoutAfter(Math.min(expires - now, 8 * 60 * 60 * 1000L))
            .setCategory(Notification.CATEGORY_PROGRESS);
        if (Build.VERSION.SDK_INT >= 36 && ongoing) builder.setRequestPromotedOngoing(true);
        try { manager.notify(tag, 0, builder.build()); } catch (SecurityException denied) { /* User can deny notifications and keep using Tau. */ }
    }
    public static void clear(Context context, String host) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        String prefix = "activity:" + host + ":";
        android.content.SharedPreferences saved = context.getSharedPreferences("tau-activities", Context.MODE_PRIVATE);
        android.content.SharedPreferences.Editor edit = saved.edit();
        for (String key : saved.getAll().keySet()) if (key.startsWith(prefix)) { manager.cancel(key, 0); edit.remove(key); }
        edit.apply();
        context.getSharedPreferences("tau-usage", Context.MODE_PRIVATE).edit().remove(host).apply();
        UsageWidget.refresh(context);
    }
}
