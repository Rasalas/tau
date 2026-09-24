package io.github.rasalas.tau.plugin;

import com.getcapacitor.JSObject;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * A WebSocket that accepts the host's self-signed certificate only when its
 * SHA-256 is the pinned one. The web view's own WebSocket cannot pin, so
 * every socket to a host goes through here.
 */
final class PinnedSocket extends WebSocketListener {

    interface Emit {
        void emit(JSObject event);
    }

    private static final OkHttpClient BASE = new OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(0, TimeUnit.MILLISECONDS)
        .build();

    private final String id;
    private final Emit emit;
    private final WebSocket socket;
    private volatile String seen;
    private volatile boolean mismatch;
    private volatile boolean pinned;
    private volatile boolean finished;

    PinnedSocket(String id, String url, String pin, boolean allowAuthority, Map<String, String> headers, Emit emit) throws Exception {
        this.id = id;
        this.emit = emit;
        OkHttpClient.Builder builder = BASE.newBuilder();
        if (pin != null && url.startsWith("wss:")) {
            X509TrustManager platform = platformTrustManager();
            String wanted = normalized(pin);
            X509TrustManager trust = new X509TrustManager() {
                @Override
                public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                    throw new CertificateException("No client certificates here.");
                }

                @Override
                public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                    if (chain == null || chain.length == 0) throw new CertificateException("The host presented no certificate.");
                    seen = fingerprint(chain[0]);
                    if (normalized(seen).equals(wanted)) {
                        pinned = true;
                        return;
                    }
                    if (allowAuthority) {
                        platform.checkServerTrusted(chain, authType);
                        return;
                    }
                    mismatch = true;
                    throw new CertificateException("certificate-mismatch");
                }

                @Override
                public X509Certificate[] getAcceptedIssuers() {
                    return new X509Certificate[0];
                }
            };
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new TrustManager[] { trust }, null);
            builder.sslSocketFactory(context.getSocketFactory(), trust);
            // The pin is stronger than a name check: the self-signed certificate names none of the LAN addresses.
            builder.hostnameVerifier((host, session) -> pinned || HttpsURLConnection.getDefaultHostnameVerifier().verify(host, session));
        }
        Request.Builder request = new Request.Builder().url(url);
        for (Map.Entry<String, String> header : headers.entrySet()) request.header(header.getKey(), header.getValue());
        socket = builder.build().newWebSocket(request.build(), this);
    }

    void send(String text) {
        socket.send(text);
    }

    void close(int code, String reason) {
        if (!socket.close(code, reason)) socket.cancel();
        finish(code, reason);
    }

    @Override
    public void onOpen(WebSocket webSocket, Response response) {
        JSObject event = base("open");
        if (seen != null) event.put("fingerprint", seen);
        emit.emit(event);
    }

    @Override
    public void onMessage(WebSocket webSocket, String text) {
        JSObject event = base("message");
        event.put("data", text);
        emit.emit(event);
    }

    @Override
    public void onMessage(WebSocket webSocket, ByteString bytes) {
        onMessage(webSocket, bytes.utf8());
    }

    @Override
    public void onClosing(WebSocket webSocket, int code, String reason) {
        webSocket.close(1000, null);
        finish(code, reason);
    }

    @Override
    public void onClosed(WebSocket webSocket, int code, String reason) {
        finish(code, reason);
    }

    @Override
    public void onFailure(WebSocket webSocket, Throwable failure, Response response) {
        finish(1006, mismatch ? "certificate-mismatch" : failure.getMessage());
    }

    private synchronized void finish(int code, String reason) {
        if (finished) return;
        finished = true;
        JSObject event = base("close");
        event.put("code", code);
        if (reason != null && !reason.isEmpty()) event.put("reason", reason);
        if (mismatch) event.put("pinMismatch", true);
        emit.emit(event);
    }

    private JSObject base(String type) {
        JSObject event = new JSObject();
        event.put("id", id);
        event.put("type", type);
        return event;
    }

    private static X509TrustManager platformTrustManager() throws Exception {
        TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        factory.init((KeyStore) null);
        for (TrustManager manager : factory.getTrustManagers()) {
            if (manager instanceof X509TrustManager) return (X509TrustManager) manager;
        }
        throw new IllegalStateException("No platform trust manager.");
    }

    /** SHA-256 of the certificate, `AB:CD:…`, the way a pairing link spells it. */
    static String fingerprint(X509Certificate certificate) throws CertificateException {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
            StringBuilder text = new StringBuilder();
            for (int index = 0; index < digest.length; index++) {
                if (index > 0) text.append(':');
                text.append(String.format(Locale.ROOT, "%02X", digest[index]));
            }
            return text.toString();
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new CertificateException(impossible);
        }
    }

    static String normalized(String fingerprint) {
        return fingerprint.replace(":", "").toUpperCase(Locale.ROOT);
    }
}
