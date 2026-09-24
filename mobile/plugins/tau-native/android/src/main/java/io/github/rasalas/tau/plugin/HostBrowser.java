package io.github.rasalas.tau.plugin;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Browses for Tau hosts over multicast DNS and resolves each to an address,
 * a port and its TXT record (host id, certificate fingerprint). One
 * resolution at a time: older Android versions refuse a second one.
 */
final class HostBrowser {

    interface Emit {
        void emit(JSArray services, String error);
    }

    private final NsdManager nsd;
    private final WifiManager.MulticastLock multicast;
    private final Emit emit;
    private final Map<String, JSObject> services = new LinkedHashMap<>();
    private final ArrayDeque<NsdServiceInfo> pending = new ArrayDeque<>();
    private NsdManager.DiscoveryListener listener;
    private boolean resolving;

    HostBrowser(Context context, Emit emit) {
        this.nsd = (NsdManager) context.getSystemService(Context.NSD_SERVICE);
        WifiManager wifi = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        this.multicast = wifi != null ? wifi.createMulticastLock("tau-bonjour") : null;
        if (multicast != null) multicast.setReferenceCounted(false);
        this.emit = emit;
    }

    synchronized void start(String type) {
        stop();
        if (nsd == null) {
            emit.emit(new JSArray(), "unavailable");
            return;
        }
        if (multicast != null) multicast.acquire();
        listener = new NsdManager.DiscoveryListener() {
            @Override
            public void onDiscoveryStarted(String serviceType) {}

            @Override
            public void onDiscoveryStopped(String serviceType) {}

            @Override
            public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                emit.emit(new JSArray(), "Discovery did not start (" + errorCode + ").");
            }

            @Override
            public void onStopDiscoveryFailed(String serviceType, int errorCode) {}

            @Override
            public void onServiceFound(NsdServiceInfo info) {
                enqueue(info);
            }

            @Override
            public void onServiceLost(NsdServiceInfo info) {
                synchronized (HostBrowser.this) {
                    services.remove(info.getServiceName());
                    publish();
                }
            }
        };
        nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener);
    }

    synchronized void stop() {
        if (listener != null) {
            try {
                nsd.stopServiceDiscovery(listener);
            } catch (IllegalArgumentException alreadyStopped) {
                // Stopping twice is fine.
            }
            listener = null;
        }
        if (multicast != null && multicast.isHeld()) multicast.release();
        services.clear();
        pending.clear();
    }

    private synchronized void enqueue(NsdServiceInfo info) {
        pending.add(info);
        next();
    }

    @SuppressWarnings("deprecation")
    private synchronized void next() {
        if (resolving || pending.isEmpty() || listener == null) return;
        resolving = true;
        nsd.resolveService(pending.poll(), new NsdManager.ResolveListener() {
            @Override
            public void onResolveFailed(NsdServiceInfo info, int errorCode) {
                done();
            }

            @Override
            public void onServiceResolved(NsdServiceInfo info) {
                synchronized (HostBrowser.this) {
                    InetAddress address = info.getHost();
                    if (address != null && listener != null) {
                        JSObject service = new JSObject();
                        service.put("name", info.getServiceName());
                        String host = address.getHostAddress();
                        if (address instanceof Inet6Address) {
                            int zone = host.indexOf('%');
                            host = "[" + (zone >= 0 ? host.substring(0, zone) : host) + "]";
                        }
                        service.put("host", host);
                        service.put("port", info.getPort());
                        JSObject txt = new JSObject();
                        for (Map.Entry<String, byte[]> entry : info.getAttributes().entrySet()) {
                            if (entry.getValue() != null) txt.put(entry.getKey(), new String(entry.getValue(), StandardCharsets.UTF_8));
                        }
                        service.put("txt", txt);
                        services.put(info.getServiceName(), service);
                        publish();
                    }
                }
                done();
            }
        });
    }

    private synchronized void done() {
        resolving = false;
        next();
    }

    private void publish() {
        JSArray list = new JSArray();
        for (JSObject service : services.values()) list.put(service);
        emit.emit(list, null);
    }
}
