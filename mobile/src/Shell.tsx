import { useCallback, useEffect, useRef, useState } from "react";
import { Server } from "lucide-react";
import { parsePairingPayload, type PairingPayload } from "../../src/shared/connections";
import type { ClientEnvironment } from "../../src/renderer/client-environment";
import { setHostClient } from "../../src/renderer/host-client-context";
import { createRendererServices, type RendererServices } from "../../src/renderer/renderer-services";
import { setClientStorage, type ClientStorage } from "../../src/workbench/client-storage";
import type { HostClient } from "../../src/workbench/host-client";
import type { HostWakeSource } from "../../src/workbench/host-link";
import { pairingNotice } from "../../src/web/host-token";
import { WebWorkbench } from "../../src/web/WebWorkbench";
import { connectHost, openCandidate } from "./connect";
import { discoveredHosts, withDiscoveredEndpoint, type DiscoveredHost, type DiscoveredService } from "./discovery";
import type { SocketCandidate } from "./endpoints";
import { fallbackHostId, sortHosts, type HostBook, type SavedHost } from "./hosts";
import type { DeviceInfo, ScanResult } from "./native";
import type { SocketBridge } from "./native-socket";
import { pairDevice, sameAddress, type PairTarget } from "./pairing";
import { pushRegistrar } from "./push";
import { routeSearch, type AppRoute } from "./routes";
import { clearHostStorage, hostStorage } from "./storage";
import { AddHostScreen } from "./ui/AddHostScreen";
import { HostsScreen, type HostRowInfo, type NearbyState } from "./ui/HostsScreen";
import { PairingScreen } from "./ui/PairingScreen";

/** Everything the shell needs from the platform, so a test can hand it fakes. */
export interface AppContext {
  storage: ClientStorage;
  book: HostBook;
  bridge: SocketBridge;
  device: DeviceInfo;
  environment: ClientEnvironment;
  wakes?: HostWakeSource;
  scan(): Promise<ScanResult>;
  browse(listener: (services: DiscoveredService[], error?: string) => void): () => void;
  /** Loads the app afresh at `search`; leaving a workbench always does. */
  navigate(search: string): void;
  subscribeToLinks(listener: (route: AppRoute) => void): () => void;
  now?(): Date;
}

type View =
  | { name: "loading" }
  | { name: "hosts"; notice?: string }
  | { name: "add"; error?: string }
  | { name: "pairing"; hostName: string; verification?: string; address?: string; abort: AbortController; from: "hosts" | "add" }
  | { name: "workbench"; host: SavedHost; client: HostClient; storage: ClientStorage; services: RendererServices };

/** A notice that must survive the reload a workbench leaves with. */
const NOTICE_KEY = "tau.mobile.notice";

const ADDRESS_LABEL: Record<string, string> = { lan: "the local network", mdns: "the local network", tailscale: "Tailscale", magicdns: "Tailscale", loopback: "this computer" };

export function payloadTarget(payload: PairingPayload): PairTarget {
  let name = payload.hostName;
  if (!name) {
    try { name = new URL(payload.endpoints[0]?.url ?? "").hostname; } catch { name = undefined; }
  }
  return {
    hostId: payload.hostId ?? fallbackHostId(payload.fingerprint, payload.endpoints),
    name: name || "Tau host",
    ...(payload.fingerprint ? { fingerprint: payload.fingerprint } : {}),
    endpoints: payload.endpoints,
    code: payload.code,
  };
}

function nearbyState(services: DiscoveredService[], error: string | undefined): NearbyState {
  if (!error) return { state: "searching", hosts: discoveredHosts(services) };
  if (error === "denied") return { state: "denied" };
  if (error === "unavailable") return { state: "unavailable" };
  return { state: "failed", message: error };
}

const scanProblem: Record<Exclude<ScanResult, { text: string }>["error"], string | undefined> = {
  cancelled: undefined,
  "camera-denied": "Tau may not use the camera. Allow it in the system settings under Tau, or paste the link instead.",
  "no-camera": "This device has no camera to scan with. Paste the pairing link instead.",
  failed: "The scanner stopped. Try again, or paste the pairing link.",
};

/**
 * The app: the host list, adding and pairing a host, and a host's workbench —
 * the compact web client on a pinned native socket. Leaving a workbench loads
 * the app afresh, so no state of one host lingers into another.
 */
export function Shell({ context, initial }: { context: AppContext; initial: AppRoute }) {
  const { book, storage, device } = context;
  const [view, setView] = useState<View>({ name: "loading" });
  const [hosts, setHosts] = useState<Array<{ host: SavedHost; signedOut: boolean }>>([]);
  const [nearby, setNearby] = useState<NearbyState>({ state: "searching", hosts: [] });
  const viewRef = useRef(view);
  viewRef.current = view;
  const now = () => context.now?.() ?? new Date();

  const refresh = useCallback(async () => {
    const list = await book.list();
    const tokens = await Promise.all(list.map((host) => book.token(host.id)));
    const next = list.map((host, index) => ({ host, signedOut: !tokens[index] }));
    setHosts(next);
    return next;
  }, [book]);

  const leaveTo = useCallback((search: string, notice?: string) => {
    if (notice) storage.set(NOTICE_KEY, notice);
    context.navigate(search);
  }, [context, storage]);

  const openWorkbench = useCallback((host: SavedHost, token: string, threadId?: string) => {
    window.history.replaceState(null, "", `${window.location.pathname}${routeSearch({ view: "workbench", hostId: host.id, ...(threadId ? { threadId } : {}) })}`);
    const scoped = hostStorage(storage, host.id);
    setClientStorage(scoped);
    const { client, connection } = connectHost(host, token, {
      bridge: context.bridge,
      device,
      ...(context.wakes ? { wakes: context.wakes } : {}),
      userAgent: navigator.userAgent,
    }, {
      onAddress: (candidate) => {
        const endpoint = host.endpoints.find((entry) => sameAddress(entry.url, candidate.url));
        void book.update(host.id, { lastUsedAt: now().toISOString(), ...(endpoint ? { lastEndpoint: endpoint } : {}) });
      },
      onUnauthorized: () => {
        void book.forgetToken(host.id).finally(() => leaveTo("?view=hosts", `${host.name} no longer accepts this phone: its access was revoked, or it ran out unused. Open the host to ask again.`));
      },
      onCertificateMismatch: () => leaveTo("?view=hosts", `${host.name} answered with another certificate than the one this phone pinned, so the phone sent it nothing. If the host renewed its certificate, remove it here and scan a new pairing code.`),
    });
    setHostClient(client);
    let registered = false;
    connection.onState((state) => {
      if (state !== "connected" || registered) return;
      registered = true;
      void pushRegistrar()?.register({ host, client }).catch(() => undefined);
    });
    void connection.start("compact").catch(() => undefined);
    void book.update(host.id, { lastUsedAt: now().toISOString() });
    setView({ name: "workbench", host, client, storage: scoped, services: createRendererServices() });
  }, [book, context, device, leaveTo, storage]);

  const startPairing = useCallback((target: PairTarget, from: "hosts" | "add") => {
    const abort = new AbortController();
    setView({ name: "pairing", hostName: target.name, abort, from });
    const update = (change: Partial<Extract<View, { name: "pairing" }>>) =>
      setView((current) => current.name === "pairing" && current.abort === abort ? { ...current, ...change } : current);
    void pairDevice(target, {
      device,
      openSocket: (candidate: SocketCandidate) => openCandidate({ bridge: context.bridge, userAgent: navigator.userAgent }, candidate),
      now,
    }, {
      signal: abort.signal,
      onAddress: (candidate) => update({ address: ADDRESS_LABEL[candidate.kind ?? ""] ?? new URL(candidate.url).hostname }),
      onWaiting: ({ verification }) => update({ verification }),
    }).then(async (outcome) => {
      if (outcome.state === "approved") {
        await book.save(outcome.host, outcome.token);
        openWorkbench(outcome.host, outcome.token);
        return;
      }
      if (viewRef.current.name !== "pairing" || viewRef.current.abort !== abort) return;
      const message = abort.signal.aborted ? undefined : outcome.state === "failed" ? outcome.message : pairingNotice(outcome);
      await refresh();
      setView(from === "add" ? { name: "add", ...(message ? { error: message } : {}) } : { name: "hosts", ...(message ? { notice: message } : {}) });
    });
  }, [book, context.bridge, device, openWorkbench, refresh]);

  /** A saved host: straight in with its token, or ask its owner again when it has none. */
  const openHost = useCallback(async (host: SavedHost, threadId?: string) => {
    const token = await book.token(host.id);
    if (token) openWorkbench(host, token, threadId);
    else startPairing({ hostId: host.id, name: host.name, ...(host.fingerprint ? { fingerprint: host.fingerprint } : {}), endpoints: host.endpoints }, "hosts");
  }, [book, openWorkbench, startPairing]);

  const scan = useCallback(async (from: "hosts" | "add") => {
    const result = await context.scan();
    if ("text" in result) {
      const payload = parsePairingPayload(result.text);
      if (payload && payload.endpoints.length > 0) { startPairing(payloadTarget(payload), from); return; }
      setView({ name: "add", error: "This QR code is not a Tau pairing code. Scan the one in Settings → Connections." });
      return;
    }
    const problem = scanProblem[result.error];
    if (problem) setView({ name: "add", error: problem });
  }, [context, startPairing]);

  // Where the app starts: the route in its address or the link that opened it.
  useEffect(() => {
    void (async () => {
      const notice = storage.get(NOTICE_KEY) ?? undefined;
      storage.remove(NOTICE_KEY);
      const list = await refresh();
      if (initial.view === "workbench") {
        const saved = list.find((entry) => entry.host.id === initial.hostId);
        if (saved) { await openHost(saved.host, initial.threadId); return; }
        setView({ name: "hosts", notice: "That link names a host this phone has not paired with." });
        return;
      }
      if (initial.view === "add") { setView({ name: "add" }); return; }
      // Straight back into the last host, unless the user asked for the list or has something to read.
      const last = sortHosts(list.filter((entry) => !entry.signedOut).map((entry) => entry.host))[0];
      if (!initial.explicit && !notice && last) { await openHost(last); return; }
      setView({ name: "hosts", ...(notice ? { notice } : {}) });
    })();
  }, []);

  // A link from outside (a push notification): the open host follows it in place, another host loads afresh.
  useEffect(() => context.subscribeToLinks((route) => {
    const current = viewRef.current;
    if (route.view === "workbench" && current.name === "workbench" && current.host.id === route.hostId) {
      if (!route.threadId) return;
      window.history.pushState(null, "", `${window.location.pathname}${routeSearch(route)}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
      return;
    }
    context.navigate(routeSearch(route));
  }), [context]);

  // Bonjour runs only while the host list shows it.
  useEffect(() => {
    if (view.name !== "hosts") return undefined;
    return context.browse((services, error) => {
      const next = nearbyState(services, error);
      setNearby(next);
      if (next.state !== "searching") return;
      void (async () => {
        let changed = false;
        for (const found of next.hosts) {
          const saved = (await book.list()).find((host) => host.id === found.hostId);
          const endpoints = saved ? withDiscoveredEndpoint(saved, found) : undefined;
          if (saved && endpoints) { await book.update(saved.id, { endpoints }); changed = true; }
        }
        if (changed) await refresh();
      })();
    });
  }, [book, context, refresh, view.name]);

  switch (view.name) {
    case "loading": return null;
    case "workbench": return <WebWorkbench
      client={view.client}
      storage={view.storage}
      services={view.services}
      environment={{ ...context.environment, shell: { hostLabel: view.host.name, actions: [{ id: "hosts", label: "Hosts", Icon: Server, run: () => leaveTo("?view=hosts") }] } }}
    />;
    case "pairing": return <PairingScreen
      hostName={view.hostName}
      {...(view.verification ? { verification: view.verification } : {})}
      {...(view.address ? { address: view.address } : {})}
      onCancel={() => { view.abort.abort(); setView(view.from === "add" ? { name: "add" } : { name: "hosts" }); }}
    />;
    case "add": return <AddHostScreen
      {...(view.error ? { error: view.error } : {})}
      onBack={() => setView({ name: "hosts" })}
      onScan={() => void scan("add")}
      onSubmit={(payload) => startPairing(payloadTarget(payload), "add")}
    />;
    case "hosts": {
      const seen = new Set(nearby.state === "searching" ? nearby.hosts.map((host) => host.hostId) : []);
      const rows: HostRowInfo[] = hosts.map((entry) => ({ ...entry, nearby: seen.has(entry.host.id) }));
      return <HostsScreen
        rows={rows}
        nearby={nearby}
        {...(view.notice ? { notice: view.notice } : {})}
        now={now().getTime()}
        onOpen={(host) => void openHost(host)}
        onRemove={(host) => void book.remove(host.id).then(() => { clearHostStorage(storage, host.id); return refresh(); })}
        onAdd={() => setView({ name: "add" })}
        onScan={() => void scan("hosts")}
        onAsk={(found: DiscoveredHost) => startPairing({ hostId: found.hostId, name: found.name, fingerprint: found.fingerprint, endpoints: [found.endpoint] }, "hosts")}
      />;
    }
  }
}
