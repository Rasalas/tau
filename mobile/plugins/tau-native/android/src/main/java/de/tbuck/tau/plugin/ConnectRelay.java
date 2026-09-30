package de.tbuck.tau.plugin;

import java.io.InputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/** Moves opaque host TLS bytes between one loopback socket and a CA-verified relay. */
final class ConnectRelay extends WebSocketListener {
    interface Ready { void ready(String url); void failed(); }
    private static final int CHUNK = 64 * 1024;
    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS)
        .callTimeout(15, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ServerSocket listener;
    private final String remote;
    private final String token;
    private final Runnable failure;
    private volatile Socket local;
    private volatile WebSocket socket;
    private volatile boolean finished;
    private Ready pending;

    ConnectRelay(String remote, String token, Runnable failure) throws Exception {
        URI url = new URI(remote);
        if (!"wss".equals(url.getScheme()) || url.getHost() == null || url.getUserInfo() != null || url.getFragment() != null || token == null || !token.matches("[A-Za-z0-9_-]{43}")) {
            throw new IllegalArgumentException("A secure relay URL and client credential are required.");
        }
        this.remote = remote; this.token = token; this.failure = failure;
        listener = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
        listener.setSoTimeout(15_000);
    }

    synchronized void start(String inner, Ready ready) {
        if (finished) { ready.failed(); return; }
        pending = ready;
        worker.execute(() -> {
            try {
                URI url = new URI(inner);
                if (!"wss".equals(url.getScheme()) || url.getHost() == null || url.getUserInfo() != null) throw new IllegalArgumentException("The host must use pinned TLS.");
                String path = url.getRawPath();
                String query = url.getRawQuery();
                String loopback = "wss://127.0.0.1:" + listener.getLocalPort() + (path == null || path.isEmpty() ? "/" : path) + (query == null ? "" : "?" + query);
                synchronized (this) {
                    if (finished) return;
                    pending = null;
                    ready.ready(loopback);
                }
                Socket accepted = listener.accept();
                synchronized (this) {
                    if (finished) { accepted.close(); return; }
                    local = accepted;
                    accepted.setSoTimeout(0);
                    listener.close();
                    socket = CLIENT.newWebSocket(new Request.Builder().url(remote).header("Authorization", "Bearer " + token).build(), this);
                }
            } catch (Exception error) { fail(); }
        });
    }

    @Override public synchronized void onOpen(WebSocket webSocket, Response response) {
        if (finished) { webSocket.cancel(); return; }
        worker.execute(() -> {
            try {
                InputStream input = local.getInputStream();
                byte[] buffer = new byte[CHUNK];
                while (!finished) {
                    int count = input.read(buffer);
                    if (count < 0) break;
                    if (webSocket.queueSize() > 1024 * 1024 || !webSocket.send(ByteString.of(buffer, 0, count))) break;
                }
            } catch (Exception ignored) { } finally { fail(); }
        });
    }

    @Override public void onMessage(WebSocket webSocket, ByteString bytes) {
        if (finished) return;
        if (bytes.size() == 0 || bytes.size() > CHUNK) { fail(); return; }
        try { local.getOutputStream().write(bytes.toByteArray()); } catch (Exception error) { fail(); }
    }
    @Override public void onMessage(WebSocket webSocket, String text) { fail(); }
    @Override public void onClosing(WebSocket webSocket, int code, String reason) { fail(); }
    @Override public void onClosed(WebSocket webSocket, int code, String reason) { fail(); }
    @Override public void onFailure(WebSocket webSocket, Throwable error, Response response) { fail(); }

    void close() { stop(false); }
    private void fail() { stop(true); }
    private synchronized void stop(boolean notify) {
        if (finished) return;
        finished = true;
        try { listener.close(); } catch (Exception ignored) { }
        try { if (local != null) local.close(); } catch (Exception ignored) { }
        if (socket != null) socket.cancel();
        worker.shutdownNow();
        if (pending != null) { Ready ready = pending; pending = null; ready.failed(); }
        if (notify) failure.run();
    }
}
