package de.tbuck.tau.plugin;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONObject;

/**
 * FCM's messages for the app. A sealed push from Tau's relay opens with the key
 * the phone gave its host (mobile/src/push-keys.ts) and is shown from here, in
 * the background too; any other message goes to Capacitor's plugin as before.
 */
public class TauMessagingService extends MessagingService {

    static final String CHANNEL_ID = "tau-threads";
    /** kits/push/protocol.ts: `1.<keyId>.<base64url(nonce ‖ ciphertext ‖ tag)>`. */
    private static final Pattern SEALED = Pattern.compile("^(\\d{1,3})\\.([A-Za-z0-9_-]{16,64})\\.([A-Za-z0-9_-]{40,})$");
    private static final int NONCE_BYTES = 12;
    private static final int BASE64URL = Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP;

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        String sealed = message.getData().get("sealed");
        if (sealed == null) {
            super.onMessageReceived(message);
            return;
        }
        // One that does not open (a forgotten host, another key) is dropped unseen.
        JSONObject content = open(this, sealed);
        if (content != null) show(this, content);
    }

    static JSONObject open(Context context, String sealed) {
        Matcher match = SEALED.matcher(sealed);
        if (!match.matches() || !"1".equals(match.group(1))) return null;
        String keyId = match.group(2);
        try {
            String key = new SecureStore(context).get("push-key.v1:" + keyId);
            if (key == null) return null;
            byte[] bytes = Base64.decode(match.group(3), BASE64URL);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(Base64.decode(key, BASE64URL), "AES"), new GCMParameterSpec(128, bytes, 0, NONCE_BYTES));
            cipher.updateAAD(("tau-push:1:" + keyId).getBytes(StandardCharsets.UTF_8));
            byte[] plain = cipher.doFinal(bytes, NONCE_BYTES, bytes.length - NONCE_BYTES);
            JSONObject content = new JSONObject(new String(plain, StandardCharsets.UTF_8));
            return content.optString("title", null) != null && content.optString("body", null) != null ? content : null;
        } catch (Exception unreadable) {
            return null;
        }
    }

    private static void show(Context context, JSONObject content) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Threads", NotificationManager.IMPORTANCE_HIGH));
        }
        String url = content.optString("url", "");
        // The app's tau:// link, as a link from outside opens it (App's appUrlOpen).
        Intent intent = url.startsWith("tau://")
            ? new Intent(Intent.ACTION_VIEW, Uri.parse(url))
            : context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (intent == null) return;
        intent.setPackage(context.getPackageName());
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        String tag = content.optString("tag", url);
        PendingIntent tap = PendingIntent.getActivity(context, tag.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String body = content.optString("body");
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(smallIcon(context))
            .setContentTitle(content.optString("title"))
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(tap);
        // The same tag replaces the thread's earlier notification.
        manager.notify(tag, 0, builder.build());
    }

    /** The launcher icon's monochrome layer reads as a status bar glyph; the app icon otherwise. */
    private static int smallIcon(Context context) {
        int monochrome = context.getResources().getIdentifier("ic_launcher_monochrome", "drawable", context.getPackageName());
        return monochrome != 0 ? monochrome : context.getApplicationInfo().icon;
    }
}
