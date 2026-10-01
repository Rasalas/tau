package de.tbuck.tau.plugin;

import android.content.res.Configuration;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The Tau app's own native side: the Keystore-backed store, pinned sockets,
 * the QR scanner and Bonjour. `mobile/src/native.ts` is its TypeScript face.
 */
@CapacitorPlugin(name = "TauNative")
public class TauNativePlugin extends Plugin {

    @PluginMethod public void activityTokens(PluginCall call) { JSObject result = new JSObject(); result.put("tokens", new org.json.JSONArray()); call.resolve(result); }
    /** The app's snapshot of one host: accounts and threads, the same JSON iOS reads. */
    @PluginMethod public void widgetSnapshot(PluginCall call) { de.tbuck.tau.plugin.widgets.WidgetStore.save(getContext(), call.getData()); call.resolve(); }
    @PluginMethod public void activityClear(PluginCall call) { AgentActivity.clear(getContext(), call.getString("hostId", "")); call.resolve(); }

    private final Map<String, PinnedSocket> sockets = new ConcurrentHashMap<>();
    private final Map<String, ConnectRelay> relays = new ConcurrentHashMap<>();
    private SecureStore store;
    private HostBrowser browser;

    @Override
    public void load() {
        store = new SecureStore(getContext());
        // The web view would scale text by the font scale on its own, but not the rows around it; the page scales both.
        getBridge().executeOnMainThread(() -> getBridge().getWebView().getSettings().setTextZoom(100));
    }

    /** The system's font scale; the manifest keeps the activity through a change (`fontScale`), and `textScale` reports it. */
    @PluginMethod
    public void textScale(PluginCall call) {
        call.resolve(textScaleEvent(getContext().getResources().getConfiguration()));
    }

    @Override
    protected void handleOnConfigurationChanged(Configuration newConfig) {
        notifyListeners("textScale", textScaleEvent(newConfig));
    }

    private static JSObject textScaleEvent(Configuration config) {
        JSObject event = new JSObject();
        event.put("scale", config.fontScale);
        return event;
    }

    @PluginMethod
    public void secureGet(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("key is required");
            return;
        }
        try {
            String value = store.get(key);
            JSObject result = new JSObject();
            if (value != null) result.put("value", value);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void secureSet(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("key and value are required");
            return;
        }
        try {
            store.set(key, value);
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void secureRemove(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("key is required");
            return;
        }
        store.remove(key);
        call.resolve();
    }

    @PluginMethod
    public void socketOpen(PluginCall call) {
        String id = call.getString("id");
        String url = call.getString("url");
        if (id == null || url == null || !(url.startsWith("ws://") || url.startsWith("wss://"))) {
            call.reject("id and a ws: or wss: url are required");
            return;
        }
        Map<String, String> headers = new HashMap<>();
        JSObject given = call.getObject("headers", new JSObject());
        for (Iterator<String> names = given.keys(); names.hasNext(); ) {
            String name = names.next();
            String value = given.optString(name, null);
            if (value != null) headers.put(name, value);
        }
        JSObject connect = call.getObject("connect");
        if (connect != null && (!url.startsWith("wss://") || (call.getString("publicKey") == null && call.getString("fingerprint") == null))) {
            call.reject("Connect requires a pinned TLS host."); return;
        }
        java.util.function.Consumer<String> open = (socketUrl) -> {
            try {
                PinnedSocket socket = new PinnedSocket(id, socketUrl, call.getString("publicKey"), call.getString("fingerprint"), connect == null && Boolean.TRUE.equals(call.getBoolean("allowAuthority", false)), headers, (event) -> {
                    if ("close".equals(event.getString("type"))) {
                        sockets.remove(id);
                        ConnectRelay relay = relays.remove(id);
                        if (relay != null) relay.close();
                    }
                    notifyListeners("socket", event);
                });
                sockets.put(id, socket);
                call.resolve();
            } catch (Exception error) { call.reject("Host socket could not start."); }
        };
        if (connect == null) { open.accept(url); return; }
        try {
            ConnectRelay relay = new ConnectRelay(connect.getString("url"), connect.getString("token"), () -> {
                PinnedSocket socket = sockets.get(id);
                if (socket != null) socket.close(1006, "Connect relay disconnected.");
                else {
                    JSObject event = new JSObject(); event.put("id", id); event.put("type", "close"); event.put("code", 1006);
                    notifyListeners("socket", event);
                }
                relays.remove(id);
            });
            relays.put(id, relay);
            relay.start(url, new ConnectRelay.Ready() {
                public void ready(String local) { open.accept(local); }
                public void failed() { call.reject("Connect relay could not start."); }
            });
        } catch (Exception error) { call.reject("Connect requires a secure relay and a client credential."); }
    }

    @PluginMethod
    public void socketSend(PluginCall call) {
        PinnedSocket socket = sockets.get(call.getString("id", ""));
        String data = call.getString("data");
        if (socket == null || data == null) {
            call.reject("unknown socket", "unknown-socket");
            return;
        }
        socket.send(data);
        call.resolve();
    }

    @PluginMethod
    public void socketClose(PluginCall call) {
        PinnedSocket socket = sockets.get(call.getString("id", ""));
        if (socket == null) {
            ConnectRelay relay = relays.remove(call.getString("id", ""));
            if (relay != null) { relay.close(); JSObject event = new JSObject(); event.put("id", call.getString("id")); event.put("type", "close"); event.put("code", call.getInt("code", 1000)); notifyListeners("socket", event); call.resolve(); } else call.reject("unknown socket", "unknown-socket");
            return;
        }
        socket.close(call.getInt("code", 1000), call.getString("reason"));
        call.resolve();
    }

    @PluginMethod
    public void scanQr(PluginCall call) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(getActivity(), options);
        scanner
            .startScan()
            .addOnSuccessListener((barcode) -> {
                JSObject result = new JSObject();
                result.put("text", barcode.getRawValue());
                call.resolve(result);
            })
            .addOnCanceledListener(() -> call.reject("Scanning was cancelled.", "cancelled"))
            .addOnFailureListener((error) -> call.reject(error.getMessage(), "failed"));
    }

    @PluginMethod
    public void discoveryStart(PluginCall call) {
        String type = call.getString("type");
        if (type == null || !type.startsWith("_") || !type.endsWith("._tcp")) {
            call.reject("type must be like _tau._tcp");
            return;
        }
        if (browser == null) {
            browser = new HostBrowser(getContext(), (services, error) -> {
                JSObject event = new JSObject();
                event.put("services", services);
                if (error != null) event.put("error", error);
                notifyListeners("discovery", event);
            });
        }
        browser.start(type);
        call.resolve();
    }

    @PluginMethod
    public void discoveryStop(PluginCall call) {
        if (browser != null) browser.stop();
        call.resolve();
    }

    @PluginMethod
    public void deviceInfo(PluginCall call) {
        String name = Settings.Global.getString(getContext().getContentResolver(), Settings.Global.DEVICE_NAME);
        JSObject result = new JSObject();
        result.put("name", name != null ? name : Build.MODEL);
        result.put("model", Build.MODEL);
        result.put("platform", "android");
        result.put("virtual", isEmulator());
        call.resolve(result);
    }

    /** FCM needs the Firebase project's google-services.json at build time; without it registering would crash. */
    @PluginMethod
    public void pushAvailable(PluginCall call) {
        int id = getContext().getResources().getIdentifier("google_app_id", "string", getContext().getPackageName());
        JSObject result = new JSObject();
        result.put("available", id != 0);
        call.resolve(result);
    }

    @Override
    protected void handleOnDestroy() {
        for (PinnedSocket socket : sockets.values()) socket.close(1001, null);
        sockets.clear();
        for (ConnectRelay relay : relays.values()) relay.close();
        relays.clear();
        if (browser != null) browser.stop();
    }

    private static boolean isEmulator() {
        return Build.FINGERPRINT.startsWith("generic") ||
            Build.FINGERPRINT.contains("emulator") ||
            Build.HARDWARE.contains("ranchu") ||
            Build.HARDWARE.contains("goldfish") ||
            Build.PRODUCT.contains("sdk");
    }
}
