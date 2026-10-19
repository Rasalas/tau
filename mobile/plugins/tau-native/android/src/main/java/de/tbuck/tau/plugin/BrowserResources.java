package de.tbuck.tau.plugin;

import android.net.Uri;
import android.util.Base64;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.JSObject;
import java.io.ByteArrayInputStream;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/** Document responses for resources read over the workbench's pinned socket. */
final class BrowserResources extends BridgeWebViewClient {
    private static final int MAX_BYTES = 10 * 1024 * 1024;
    private static final String HOST = "tau-resources.localhost";
    private final Map<String, Pending> pending = new ConcurrentHashMap<>();
    private final Consumer<JSObject> request;
    private final boolean enabled;
    private static final class Pending {
        final String connection;
        final CompletableFuture<WebResourceResponse> response = new CompletableFuture<>();
        Pending(String connection) { this.connection = connection; }
    }

    BrowserResources(Bridge bridge, Consumer<JSObject> request) {
        super(bridge);
        this.request = request;
        enabled = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) && !bridge.getConfig().isUsingLegacyBridge();
        // A legacy JavascriptInterface is exposed in every frame. Keep it out
        // even if Capacitor fell back after registering its origin-aware listener.
        if (enabled) bridge.getWebView().removeJavascriptInterface("androidBridge");
        // Tau uses neither global HTTP interception nor a native cookie jar.
        // These interfaces otherwise bypass the frame's opaque origin.
        bridge.getWebView().removeJavascriptInterface("CapacitorCookiesAndroidInterface");
        bridge.getWebView().removeJavascriptInterface("CapacitorHttpAndroidInterface");
    }

    private static boolean isResource(Uri url) { return HOST.equals(url.getHost()) && "https".equals(url.getScheme()); }

    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (isResource(request.getUrl())) return request.isForMainFrame();
        return super.shouldOverrideUrlLoading(view, request);
    }

    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest resource) {
        Uri url = resource.getUrl();
        if (!isResource(url)) return super.shouldInterceptRequest(view, resource);
        String path = url.getPath();
        if (!enabled || resource.isForMainFrame() || !"GET".equals(resource.getMethod()) || url.getPort() != -1
            || url.getUserInfo() != null || url.getQuery() != null || url.getFragment() != null
            || path == null || !path.matches("/[0-9a-f-]{36}/resources/[0-9a-f]{64}")) return response(404, Collections.emptyMap(), new byte[0]);
        String[] pieces = path.split("/");
        try { UUID.fromString(pieces[1]); } catch (IllegalArgumentException error) { return response(404, Collections.emptyMap(), new byte[0]); }
        return load(pieces[1], pieces[3]);
    }

    /** One read of a resource through the workbench's connection; the web view and `openDocument` share it. */
    WebResourceResponse load(String connection, String hash) {
        String id = UUID.randomUUID().toString();
        Pending entry = new Pending(connection);
        synchronized (pending) {
            if (pending.size() >= 16) return response(429, Collections.emptyMap(), new byte[0]);
            pending.put(id, entry);
        }
        JSObject event = new JSObject(); event.put("id", id); event.put("connectionId", entry.connection); event.put("path", "/resources/" + hash);
        try {
            request.accept(event);
            // WebView calls interception on a worker. The workbench and native
            // plugin threads remain free to deliver the socket response.
            return entry.response.get(30, TimeUnit.SECONDS);
        } catch (Exception error) { return response(504, Collections.emptyMap(), new byte[0]); }
        finally { pending.remove(id); }
    }

    void respond(String id, int status, JSObject headers, String body) {
        Pending entry = pending.remove(id);
        if (entry == null) return;
        try {
            if (status < 200 || status > 599 || (status >= 300 && status < 400) || body.length() > ((MAX_BYTES + 2) / 3) * 4) throw new IllegalArgumentException();
            byte[] bytes = Base64.decode(body, Base64.NO_WRAP);
            if (bytes.length > MAX_BYTES) throw new IllegalArgumentException();
            Map<String, String> safe = new HashMap<>();
            for (String name : new String[] { "content-type", "content-security-policy", "content-disposition", "content-range", "accept-ranges" }) {
                String value = headers.getString(name);
                if (value != null && value.length() <= 16_384 && !value.contains("\r") && !value.contains("\n")) safe.put(name, value);
            }
            entry.response.complete(response(status, safe, bytes));
        } catch (Exception error) { entry.response.complete(response(502, Collections.emptyMap(), new byte[0])); }
    }

    void close(String connection) {
        pending.forEach((id, entry) -> {
            if (connection == null || entry.connection.equals(connection)) {
                if (pending.remove(id, entry)) entry.response.complete(response(404, Collections.emptyMap(), new byte[0]));
            }
        });
    }

    private static WebResourceResponse response(int status, Map<String, String> headers, byte[] bytes) {
        Map<String, String> safe = new HashMap<>(headers);
        String sandbox = "sandbox allow-scripts allow-forms";
        safe.put("content-security-policy", safe.containsKey("content-security-policy") ? safe.get("content-security-policy") + ", " + sandbox : sandbox + "; default-src 'none'");
        safe.put("cache-control", "private, no-store");
        safe.put("x-content-type-options", "nosniff");
        safe.put("referrer-policy", "no-referrer");
        String contentType = safe.getOrDefault("content-type", "application/octet-stream");
        return new WebResourceResponse(contentType.split(";", 2)[0].trim(), "UTF-8", status, "Resource", safe, new ByteArrayInputStream(bytes));
    }
}
