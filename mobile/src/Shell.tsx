import { followActivities, type ActivityPort } from "./activities";
import { useCallback, useEffect, useRef, useState } from "react";
import { Server } from "lucide-react";
import { parseMobilePairingPayload, connectCandidate, type MobilePairingPayload, type MobileConnect } from "./relay-connect";
import type { ClientEnvironment } from "../../src/renderer/client-environment";
import { setHostClient } from "../../src/renderer/host-client-context";
import { createRendererServices, type RendererServices } from "../../src/renderer/renderer-services";
import { createMemoryStorage, setClientStorage, type ClientStorage } from "../../src/workbench/client-storage";
import type { HostClient } from "../../src/workbench/host-client";
import type { HostWakeSource } from "../../src/workbench/host-link";
import { pairingNotice } from "../../src/web/host-token";
import { WebWorkbench } from "../../src/web/WebWorkbench";
import { certificateRefusalNotice, connectHost, openCandidate } from "./connect";
import { nearbyHosts, withDiscoveredEndpoints, type DiscoveredHost, type NativeService } from "./discovery";
import { RacingSocket, socketCandidates, type SocketCandidate } from "./endpoints";
import { fallbackHostId, helloEndpoints, migratedPin, sortHosts, type HostBook, type SavedHost } from "./hosts";
import { PhoneMachines, type Visibility } from "./machines";
import type { DeviceInfo, ScanResult } from "./native";
import type { SocketBridge } from "./native-socket";
import { pairDevice, sameAddress, targetPins, type PairTarget } from "./pairing";
import { pushRegistrar } from "./push";
import { routeSearch, type AppRoute } from "./routes";
import { clearHostStorage, hostStorage } from "./storage";
import { AddHostScreen } from "./ui/AddHostScreen";
import { HostsScreen, type HostRowInfo, type NearbyState } from "./ui/HostsScreen";
import { PairingScreen } from "./ui/PairingScreen";
import { createDemoHost } from "./demo-host";

/** Everything the shell needs from the platform, so a test can hand it fakes. */
export interface AppContext {
  activities?: ActivityPort;
  remoteActivities?: import("./activity-start").RemoteActivities;
  storage: ClientStorage;
  book: HostBook;
  bridge: SocketBridge;
  device: DeviceInfo;
  environment: ClientEnvironment;
  wakes?: HostWakeSource;
  scan(): Promise<ScanResult>;
  browse(listener: (services: NativeService[], error?: string) => void): () => void;
  /** Loads the app afresh at `search`; leaving a workbench always does. */
  navigate(search: string): void;
  subscribeToLinks(listener: (route: AppRoute) => void): () => void;
  /** Whether the app is in front; the other hosts are read only then. The page's own by default. */
  visibility?: Visibility;
  now?(): Date;
}

type View =
  | { name: "loading" }
  | { name: "hosts"; notice?: string }
  | { name: "demo"; client: HostClient; storage: ClientStorage; services: RendererServices; environment: ClientEnvironment }
  | { name: "add"; error?: string; text?: string }
  | { name: "pairing"; hostName: string; verification?: string; address?: string; abort: AbortController; from: "hosts" | "add"; text?: string }
  | { name: "workbench"; host: SavedHost; client: HostClient; storage: ClientStorage; services: RendererServices; environment: ClientEnvironment };

/** A notice that must survive the reload a workbench leaves with. */
const NOTICE_KEY = "tau.mobile.notice";

const ADDRESS_LABEL: Record<string, string> = { lan: "the local network", mdns: "the local network", tailscale: "Tailscale", magicdns: "Tailscale", loopback: "this computer" };

const documentVisibility: Visibility = {
  visible: () => document.visibilityState === "visible",
  subscribe: (listener) => {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

export function payloadTarget(payload: MobilePairingPayload): PairTarget {
  let name = payload.hostName;
  if (!name) {
    try { name = new URL(payload.endpoints[0]?.url ?? "").hostname; } catch { name = undefined; }
  }
  return {
    hostId: payload.hostId ?? fallbackHostId(payload.fingerprint ?? payload.publicKey, payload.endpoints),
    name: name || "Tau host",
    ...targetPins(payload),
    endpoints: payload.endpoints,
    code: payload.code,
    ...(payload.connect ? { connect: payload.connect } : {}),
  };
}

function nearbyState(services: NativeService[], error: string | undefined, virtual: boolean): NearbyState {
  if (!error) return { state: "searching", hosts: nearbyHosts(services, virtual) };
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
  const [remoteStatus, setRemoteStatus] = useState<Record<string, import("./activity-start").RemoteActivityStatus>>({});
  const [remoteNotice, setRemoteNotice] = useState<string>();
  const activityFollow = useRef<ReturnType<typeof followActivities>>(undefined);
  const viewRef = useRef(view);
  viewRef.current = view;
  /** The pairing attempt on screen; set at once, since a refused address can fail before the next render. */
  const pairingRef = useRef<AbortController>(undefined);
  const now = () => context.now?.() ?? new Date();

  const refresh = useCallback(async () => {
    const list = await book.list();
    const tokens = await Promise.all(list.map((host) => book.token(host.id)));
    const next = list.map((host, index) => ({ host, signedOut: !tokens[index] }));
    setHosts(next);
    if (context.remoteActivities) {
      const states = await Promise.all(next.map(async ({ host }) => [host.id, await context.remoteActivities!.status(host.id).catch(() => ({ available: false, enabled: false }))] as const));
      setRemoteStatus(Object.fromEntries(states));
    }
    return next;
  }, [book]);

  const leaveTo = useCallback((search: string, notice?: string) => {
    if (notice) storage.set(NOTICE_KEY, notice);
    context.navigate(search);
  }, [context, storage]);

  const openWorkbench = useCallback((host: SavedHost, token: string, threadId?: string, connect?: MobileConnect) => {
    window.history.replaceState(null, "", `${window.location.pathname}${routeSearch({ view: "workbench", hostId: host.id, ...(threadId ? { threadId } : {}) })}`);
    const scoped = hostStorage(storage, host.id);
    setClientStorage(scoped);
    // Read at every reconnect: a migrated pin or a refreshed address list applies to the next socket.
    let current = host;
    const learn = (change: Partial<SavedHost>) => {
      current = { ...current, ...change };
      void book.update(host.id, change);
    };
    const { client, connection } = connectHost(() => current, token, {
      bridge: context.bridge,
      ...(connect ? { connect } : {}),
      device,
      ...(context.wakes ? { wakes: context.wakes } : {}),
      userAgent: navigator.userAgent,
    }, {
      onAddress: (candidate) => {
        const endpoint = current.endpoints.find((entry) => sameAddress(entry.url, candidate.url));
        void book.update(host.id, { lastUsedAt: now().toISOString(), ...(endpoint ? { lastEndpoint: endpoint } : {}) });
      },
      onUnauthorized: () => {
        void activityFollow.current?.revoke();
        void book.forgetToken(host.id).finally(() => leaveTo("?view=hosts", `${host.name} no longer accepts this phone: its access was revoked, or it ran out unused. Open the host to ask again.`));
      },
      // After every hello: an old certificate pin moves to the key, and the host's addresses are taken as it names them.
      onHello: (address, reply) => {
        const pin = migratedPin(current, address);
        const endpoints = helloEndpoints(current, reply.host, address.candidate.url, sameAddress);
        if (pin || endpoints) learn({ ...pin, ...(endpoints ? { endpoints } : {}) });
      },
      onCertificateRefused: (refusal) => leaveTo("?view=hosts", certificateRefusalNotice(host.name, refusal)),
    });
    setHostClient(client);
    activityFollow.current?.stop();

    // The connection starts out "connected", so its first hello is the moment to hand over the push token.
    void connection.start("compact").then((reply) => {
      if (reply) {
        void Promise.resolve(pushRegistrar()?.register({ host, client })).catch(() => undefined).then(() => {
          void context.remoteActivities?.connect(current).catch(() => undefined);
          if (context.activities) activityFollow.current = followActivities(host.id, client, context.activities, { machine: host.name });
        });
      }
    }).catch(() => undefined);
    void book.update(host.id, { lastUsedAt: now().toISOString() });
    // Every other paired host, each over its own token, for the thread list and "Run on".
    const otherRelays = new Map<string, MobileConnect>();
    const machines = new PhoneMachines({
      hosts: async () => {
        const list = await book.list();
        return Promise.all(list.map(async (saved) => {
          const relay = await book.connect(saved.id);
          if (relay) otherRelays.set(saved.id, relay);
          return { host: saved, token: await book.token(saved.id) };
        }));
      },
      storage,
      shown: host,
      client,
      socket: (other, onFailure) => {
        const pins = { ...(other.publicKey ? { publicKey: other.publicKey } : {}), ...(other.fingerprint ? { fingerprint: other.fingerprint } : {}) };
        const relay = otherRelays.get(other.id);
        const relayCandidate = relay ? connectCandidate(relay, pins) : undefined;
        return new RacingSocket([...socketCandidates(other.endpoints, pins, device), ...(relayCandidate ? [relayCandidate] : [])], (candidate) => openCandidate({ bridge: context.bridge, userAgent: navigator.userAgent }, candidate), { onFailure });
      },
      navigate: (route) => leaveTo(routeSearch(route)),
      forgetToken: async (id) => { await context.activities?.clear(id); await book.forgetToken(id); },
      rename: (id, name) => book.update(id, { name }),
      remove: async (id) => { await context.activities?.clear(id); await book.remove(id); clearHostStorage(storage, id); void pushRegistrar()?.forget(id).catch(() => undefined); },
      visibility: context.visibility ?? documentVisibility,
    });
    const environment: ClientEnvironment = {
      ...context.environment,
      createPlatform: (ports) => ({ ...context.environment.createPlatform(ports), environments: machines }),
      shell: { hostLabel: host.name, actions: [{ id: "hosts", label: "Hosts", Icon: Server, run: () => leaveTo("?view=hosts") }] },
    };
    setView({ name: "workbench", host, client, storage: scoped, services: createRendererServices(), environment });
  }, [book, context, device, leaveTo, storage]);

  const startPairing = useCallback((target: PairTarget, from: "hosts" | "add", text?: string) => {
    const abort = new AbortController();
    pairingRef.current = abort;
    setView({ name: "pairing", hostName: target.name, abort, from, ...(text ? { text } : {}) });
    const update = (change: Partial<Extract<View, { name: "pairing" }>>) =>
      setView((current) => current.name === "pairing" && current.abort === abort ? { ...current, ...change } : current);
    void pairDevice(target, {
      device,
      openSocket: (candidate: SocketCandidate) => openCandidate({ bridge: context.bridge, userAgent: navigator.userAgent }, candidate),
      now,
    }, {
      signal: abort.signal,
      onAddress: (candidate) => update({ address: candidate.connect ? "Tau Connect" : ADDRESS_LABEL[candidate.kind ?? ""] ?? new URL(candidate.url).hostname }),
      onWaiting: ({ verification }) => update({ verification }),
    }).catch((error: unknown) => ({ state: "failed" as const, message: error instanceof Error ? error.message : String(error) })).then(async (outcome) => {
      if (pairingRef.current !== abort) return;
      pairingRef.current = undefined;
      if (outcome.state === "approved") {
        await book.save(outcome.host, outcome.token, target.connect);
        openWorkbench(outcome.host, outcome.token, undefined, target.connect);
        return;
      }
      const message = abort.signal.aborted ? undefined : outcome.state === "failed" ? outcome.message : pairingNotice(outcome);
      await refresh();
      setView(from === "add" ? { name: "add", ...(message ? { error: message } : {}), ...(text ? { text } : {}) } : { name: "hosts", ...(message ? { notice: message } : {}) });
    });
  }, [book, context.bridge, device, openWorkbench, refresh]);

  /** A saved host: straight in with its token, or ask its owner again when it has none. */
  const openHost = useCallback(async (host: SavedHost, threadId?: string) => {
    const token = await book.token(host.id);
    const connect = await book.connect(host.id);
    if (token) openWorkbench(host, token, threadId, connect);
    else startPairing({ hostId: host.id, name: host.name, ...targetPins(host), endpoints: host.endpoints, ...(connect ? { connect } : {}) }, "hosts");
  }, [book, openWorkbench, startPairing]);

  const scan = useCallback(async (from: "hosts" | "add") => {
    const result = await context.scan();
    if ("text" in result) {
      const payload = parseMobilePairingPayload(result.text);
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
      for (const entry of list) if (entry.signedOut) void context.activities?.clear(entry.host.id);
      if (initial.view === "workbench") {
        const saved = list.find((entry) => entry.host.id === initial.hostId);
        if (saved) { await openHost(saved.host, initial.threadId); return; }
        setView({ name: "hosts", notice: "That link names a host this phone has not paired with." });
        return;
      }
      if (initial.view === "add") {
        const pending = await book.takeConnectLink();
        const text = initial.text ?? pending;
        setView({ name: "add", ...(text ? { text } : {}) }); return;
      }
      // Straight back into the last host, unless the user asked for the list or has something to read.
      const last = sortHosts(list.filter((entry) => !entry.signedOut).map((entry) => entry.host))[0];
      if (!initial.explicit && !notice && last) { await openHost(last); return; }
      setView({ name: "hosts", ...(notice ? { notice } : {}) });
    })();
  }, []);

  // A link from outside (a push notification): the open host follows it in place, another host loads afresh.
  useEffect(() => context.subscribeToLinks((route) => {
    const current = viewRef.current;
    if (route.view === "add" && route.text) {
      pairingRef.current?.abort(); pairingRef.current = undefined;
      if (current.name === "workbench") void book.stageConnectLink(route.text).then(() => context.navigate("?view=add"));
      else setView({ name: "add", text: route.text });
      return;
    }
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
      const next = nearbyState(services, error, device.virtual);
      setNearby(next);
      if (next.state !== "searching") return;
      // A saved host seen at a new address keeps it, first.
      void book.list().then(async (saved) => {
        const moves = next.hosts.flatMap((found) => {
          const host = saved.find((entry) => entry.id === found.hostId);
          const endpoints = host ? withDiscoveredEndpoints(host, found) : undefined;
          return host && endpoints ? [{ id: host.id, endpoints }] : [];
        });
        if (moves.length === 0) return;
        await Promise.all(moves.map((move) => book.update(move.id, { endpoints: move.endpoints })));
        await refresh();
      });
    });
  }, [book, context, device.virtual, refresh, view.name]);

  switch (view.name) {
    case "loading": return null;
    case "demo":
    case "workbench": return <WebWorkbench
      client={view.client}
      storage={view.storage}
      services={view.services}
      environment={view.environment}
    />;
    case "pairing": return <PairingScreen
      hostName={view.hostName}
      {...(view.verification ? { verification: view.verification } : {})}
      {...(view.address ? { address: view.address } : {})}
      onCancel={() => { view.abort.abort(); pairingRef.current = undefined; setView(view.from === "add" ? { name: "add", ...(view.text ? { text: view.text } : {}) } : { name: "hosts" }); }}
    />;
    case "add": return <AddHostScreen
      {...(view.error ? { error: view.error } : {})}
      {...(view.text ? { initialText: view.text } : {})}
      onBack={() => setView({ name: "hosts" })}
      onScan={() => void scan("add")}
      onSubmit={(payload, text) => startPairing(payloadTarget(payload), "add", text)}
    />;
    case "hosts": {
      const seen = new Set(nearby.state === "searching" ? nearby.hosts.map((host) => host.hostId) : []);
      const rows: HostRowInfo[] = hosts.map(({ host, signedOut }) => ({ host, signedOut, nearby: seen.has(host.id), ...(remoteStatus[host.id] ? { remoteActivity: remoteStatus[host.id] } : {}) }));
      return <HostsScreen
        rows={rows}
        nearby={nearby}
        {...(remoteNotice || view.notice ? { notice: remoteNotice ?? view.notice } : {})}
        {...(context.remoteActivities ? { onRemoteActivity: (host: SavedHost, enabled: boolean) => {
          setRemoteNotice(undefined);
          void context.remoteActivities!.setEnabled(host, enabled).then(() => refresh()).catch((error: unknown) => setRemoteNotice(error instanceof Error ? error.message : "Live Activity settings could not be saved."));
        } } : {})}
        now={now().getTime()}
        onOpen={(host) => void openHost(host)}
        onRemove={(host) => void Promise.resolve(context.activities?.clear(host.id)).then(() => book.remove(host.id)).then(() => { clearHostStorage(storage, host.id); void pushRegistrar()?.forget(host.id).catch(() => undefined); return refresh(); })}
        onAdd={() => setView({ name: "add" })}
        onDemo={() => {
          const demo = createDemoHost();
          const memory = createMemoryStorage();
          setClientStorage(memory);
          setHostClient(demo.client);
          void demo.start();
          setView({ name: "demo", client: demo.client, storage: memory, services: createRendererServices(), environment: {
            ...context.environment,
            shell: { hostLabel: "Local demo · simulated replies", actions: [{ id: "exit-demo", label: "Exit demo", Icon: Server, run: () => leaveTo("?view=hosts") }] },
          } });
        }}
        onScan={() => void scan("hosts")}
        onAsk={(found: DiscoveredHost) => startPairing({ hostId: found.hostId, name: found.name, ...targetPins(found), endpoints: found.endpoints }, "hosts")}
      />;
    }
  }
}
