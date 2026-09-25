import { lookup } from "node:dns/promises";
import type { UiDiscoveredHosts } from "../shared/discovery.js";
import type {
  EnvironmentAgentsOutcome,
  EnvironmentAgentsResult,
  EnvironmentOpenTarget,
  EnvironmentPairInput,
  EnvironmentPreferences,
  EnvironmentPairResult,
  EnvironmentTarget,
  UiEnvironment,
  UiEnvironmentPairing,
  UiEnvironmentThreadView,
  UiEnvironments,
} from "../shared/environments.js";
import type { TranscriptPage } from "../shared/host-protocol.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import { agentsDeviceName, environmentProjects, environmentThreads, orderEndpoints, refreshEndpoints, sameEndpoints, socketUrl } from "../shared/environments.js";
import type { PairingEndpoint } from "../shared/connections.js";
import { EnvironmentCatalog, endpointTrust, type SavedEnvironment, type SecretBox } from "./environment-catalog.js";
import { EnvironmentMonitor, type EnvironmentMonitorOptions, type MonitorState } from "./environment-monitor.js";
import { EnvironmentThreadWatches } from "./environment-thread-watch.js";
import { pairEnvironment, type NearbyMachine, type PairEnvironmentOptions, type PairEnvironmentResult } from "./environment-pairing.js";
import type { HostLogger } from "./host-log.js";
import {
  CERTIFICATE_ACCEPT,
  CERTIFICATE_DEFAULT,
  CERTIFICATE_REJECT,
  hostEndpoint,
  pinAccepts,
  type EndpointTrust,
  type PresentedIdentity,
} from "./host-tls-trust.js";
import { fingerprintsMatch } from "./host-tls.js";

/** Where the page reaches a machine: what a `WindowHost` attaches to and the page's `?host=`. */
export interface EnvironmentConnection {
  id: string;
  url: string;
  token: string;
  /** How to trust `url`; absent for a plaintext address. */
  trust?: EndpointTrust;
}

export interface WindowEnvironmentsOptions {
  catalogPath: string;
  box: SecretBox;
  logger: HostLogger;
  /** How this window names itself to another machine's owner. */
  deviceName: string;
  /** The window's own machine: its host id and name, and its supervised host once it runs. */
  local: { id: string; name: string };
  /** The list changed; the page hears it as the `environments` window event. */
  publish(environments: UiEnvironments): void;
  /** A thread a tab looks in on changed there; the page hears it as the `environment-thread` window event. */
  publishThread?(view: UiEnvironmentThreadView): void;
  /**
   * Point the page at another machine, or back at this one (`undefined`).
   * The window's process attaches its uplink and loads the page again.
   */
  show(connection: EnvironmentConnection | undefined): Promise<void>;
  /** A Bonjour search from the window's own host (`connections-discover`); absent where it has none. */
  discover?(): Promise<UiDiscoveredHosts>;
  /**
   * This machine's host, which keeps a key of its own per machine for its
   * agents (ADR 0027). Absent where the window has no host of its own.
   */
  agents?: {
    add(entry: SavedEnvironment): Promise<void>;
    remove(id: string): Promise<void>;
  };
  /** How long a start waits for the machine shown last before it shows this one. */
  reopenWaitMs?: number;
  /** Resolves a `.local` name for the page, whose Chromium cannot; the system's resolver by default. */
  resolve?(hostname: string): Promise<string | undefined>;
  /** Test seams. */
  monitor?(options: EnvironmentMonitorOptions): EnvironmentMonitor;
  pair?(options: PairEnvironmentOptions): ReturnType<typeof pairEnvironment>;
  now?(): number;
}

interface Watched {
  monitor: EnvironmentMonitor;
  state: MonitorState;
  /** The address and token the monitor was built with, so a change rebuilds it. */
  key: string;
  /** Kept from the last connection, so an offline machine still lists what it had. */
  kept?: Pick<UiEnvironment, "threads" | "threadCount" | "projects">;
}

/**
 * The machines of one window (ADR 0025): the catalog of saved ones, a small
 * connection to each (and to the window's own host), pairing a new one, and
 * which machine the page shows. Nothing here draws; the page does, from the
 * snapshot this publishes.
 */
export class WindowEnvironments {
  private catalog: EnvironmentCatalog | undefined;
  private readonly watched = new Map<string, Watched>();
  private localConnection: { url: string; token: string } | undefined;
  private shownId: string;
  private arrival: EnvironmentTarget | undefined;
  private pairing: UiEnvironmentPairing | undefined;
  private pairingAbort: AbortController | undefined;
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  /** What the last Bonjour search found, by host id; pairing with one takes its addresses and pin from here. */
  private nearby = new Map<string, NearbyMachine>();
  private readonly connectedWaiters = new Map<string, Set<() => void>>();
  /** Addresses a `.local` name resolved to for the page, by machine id; trusted like the name. */
  private readonly resolved = new Map<string, string>();
  /** Catalog writes nobody awaits: a remembered machine, a migrated pin, fresh addresses. */
  private readonly writes = new Set<Promise<void>>();
  /** Threads of other machines the page looks in on, each subscribed on that machine's connection. */
  private readonly lookIns: EnvironmentThreadWatches;

  constructor(private readonly options: WindowEnvironmentsOptions) {
    this.shownId = options.local.id;
    this.lookIns = new EnvironmentThreadWatches({
      resubscribe: (machine) => this.watched.get(machine)?.monitor.resubscribe(),
      publish: (machine, sessionId) => this.options.publishThread?.(this.threadView(machine, sessionId)),
    });
  }

  async start(): Promise<void> {
    this.catalog = await EnvironmentCatalog.open(this.options.catalogPath, this.options.box, this.options.logger);
    for (const saved of this.catalog.list()) this.watchSaved(saved);
    this.schedulePublish();
    await this.reopenShown();
  }

  /**
   * Shows the machine the window showed last, when the user asked for that
   * and it answers within a moment; otherwise the window starts on this one.
   * Runs before the page first loads, so no page is loaded twice.
   */
  private async reopenShown(): Promise<void> {
    const { reopenShown, lastShown } = this.catalog?.preferences ?? {};
    if (!reopenShown || !lastShown || lastShown === this.options.local.id || !this.catalog?.get(lastShown)) return;
    const reached = await this.whenConnected(lastShown, this.options.reopenWaitMs ?? 2_500);
    this.options.logger.info("environments.reopen", { id: lastShown, reached });
    if (reached && this.shownId === this.options.local.id) await this.open(lastShown).catch(() => undefined);
  }

  private whenConnected(id: string, timeoutMs: number): Promise<boolean> {
    if (this.watched.get(id)?.state.status === "connected") return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiters = this.connectedWaiters.get(id) ?? new Set();
      this.connectedWaiters.set(id, waiters);
      const done = (reached: boolean) => {
        clearTimeout(timer);
        waiters.delete(onConnected);
        resolve(reached);
      };
      const onConnected = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      waiters.add(onConnected);
    });
  }

  /** The supervised host came up, or moved to another port. */
  setLocalHost(url: string, token: string): void {
    this.localConnection = { url, token };
    this.watch(this.options.local.id, `${url}\n${token}`, { urls: () => [url], token });
  }

  get shown(): string { return this.shownId; }
  get showsLocal(): boolean { return this.shownId === this.options.local.id; }

  snapshot(): UiEnvironments {
    const local = this.describe(this.options.local.id, { name: this.options.local.name, local: true });
    const saved = (this.catalog?.list() ?? []).map((entry) => this.describe(entry.id, {
      name: entry.name,
      local: false,
      readOnly: entry.readOnly,
      address: entry.lastUrl,
    }));
    return {
      shown: this.shownId,
      environments: [local, ...saved.sort((a, b) => a.name.localeCompare(b.name))],
      ...(this.pairing ? { pairing: this.pairing } : {}),
      secureStorage: this.catalog?.secure ?? this.options.box.available(),
      ...(this.catalog?.preferences.reopenShown ? { reopenShown: true } : {}),
    };
  }

  async setPreferences(preferences: EnvironmentPreferences): Promise<void> {
    if (!this.catalog) throw new Error("The machine list is not ready yet.");
    await this.catalog.setPreferences({
      ...(preferences.reopenShown !== undefined ? { reopenShown: preferences.reopenShown } : {}),
      // Remembered from now on, so the next start has something to show.
      ...(preferences.reopenShown ? { lastShown: this.shownId } : {}),
    });
    this.schedulePublish();
  }

  /**
   * Looks for machines on this network through the window's own host. A
   * saved machine found with the key (or old certificate) it was pinned for gets the
   * addresses it has now, and is tried at them at once.
   */
  async discover(): Promise<UiDiscoveredHosts> {
    if (!this.options.discover) throw new Error("This window has no host of its own to look from.");
    const result = await this.options.discover();
    this.nearby = new Map(result.hosts.filter((host) => !host.self).map((host) => [host.hostId, {
      hostId: host.hostId,
      name: host.name,
      fingerprint: host.fingerprint,
      ...(host.publicKey ? { publicKey: host.publicKey } : {}),
      endpoints: host.endpoints,
    }]));
    for (const host of result.hosts) {
      const saved = this.catalog?.get(host.hostId);
      if (!saved || !recordMatchesPin(saved, host)) continue;
      if (await this.refreshAddresses(saved.id, host.endpoints, undefined, "bonjour")) this.retry(saved.id);
    }
    return result;
  }

  async pair(input: EnvironmentPairInput): Promise<EnvironmentPairResult> {
    if (!this.catalog) throw new Error("The machine list is not ready yet.");
    if (!this.catalog.secure) return { state: "failed", message: "This machine offers Tau no encrypted storage (no keychain or secret service), so it cannot keep another machine's key." };
    const nearby = input.nearby ? this.nearby.get(input.nearby) : undefined;
    if (input.nearby && !nearby) return { state: "failed", message: "That machine is no longer in the list. Search again." };
    const deviceName = input.deviceName?.trim() || this.options.deviceName;
    // One approval over there lets in this window and, as a device of their own, this machine's agents (ADR 0027).
    const withAgents = input.agents !== false && this.options.agents !== undefined;
    const result = await this.runPairing((nearby?.name ?? input.text ?? "").trim().slice(0, 200), {
      ...(nearby ? { nearby } : { text: input.text ?? "" }),
      deviceName,
      ...(withAgents ? { companion: agentsDeviceName(deviceName) } : {}),
    });
    if (result.state !== "approved") return result;
    if (result.environment.id === this.options.local.id) {
      return { state: "failed", message: "That address is this machine; its threads are listed already." };
    }
    try {
      await this.catalog.save(result.environment);
    } catch (error: unknown) {
      return { state: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    this.options.logger.info("environment.added", { id: result.environment.id, name: result.environment.name, endpoints: result.environment.endpoints.length });
    this.watchSaved(result.environment);
    this.schedulePublish();
    const agents = withAgents ? await this.handOverAgents(result.environment, result.agentsToken) : undefined;
    return { state: "added", environment: this.snapshot().environments.find((entry) => entry.id === result.environment.id)!, ...(agents ? { agents } : {}) };
  }

  /**
   * Lets this machine's agents work on a saved machine, or stops them. On
   * asks that machine's owner once more, for the agents alone; off forgets
   * their key here, and the other machine lists the device until its owner
   * revokes it.
   */
  async setAgents(id: string, on: boolean): Promise<EnvironmentAgentsResult> {
    const agents = this.options.agents;
    if (!agents) return { state: "failed", message: "This window has no host of its own to keep a key for its agents." };
    const saved = this.catalog?.get(id);
    if (!saved) return { state: "failed", message: "Tau does not know that machine." };
    if (!on) {
      await agents.remove(id);
      this.options.logger.info("environment.agents", { id, on });
      return { state: "off" };
    }
    const result = await this.runPairing(saved.name, {
      nearby: { hostId: saved.id, name: saved.name, fingerprint: saved.fingerprint ?? "", ...(saved.publicKey ? { publicKey: saved.publicKey } : {}), endpoints: saved.endpoints },
      deviceName: agentsDeviceName(this.options.deviceName),
    });
    if (result.state !== "approved") return result;
    if (result.environment.id !== saved.id) return { state: "failed", message: `That address answered as another machine than ${saved.name}.` };
    const outcome = await this.handOverAgents(saved, result.environment.token);
    this.options.logger.info("environment.agents", { id, on, added: outcome.added });
    return outcome.added ? { state: "on" } : { state: "failed", message: outcome.message };
  }

  /** Gives this machine's host the agents' key for a machine; the window keeps its own. */
  private async handOverAgents(machine: SavedEnvironment, token: string | undefined): Promise<EnvironmentAgentsOutcome> {
    if (!token) return { added: false, message: `${machine.name} runs a Tau that pairs no agents; update it there, then turn them on here.` };
    try {
      await this.options.agents!.add({ ...machine, token });
      return { added: true };
    } catch (error: unknown) {
      this.options.logger.warn("environment.agents.failed", { id: machine.id, error: error instanceof Error ? error.message : String(error) });
      return { added: false, message: `This computer's host did not take the agents' key: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** One pairing at a time: its progress is published as `pairing`, and `cancelPairing` ends it. */
  private async runPairing(address: string, options: Omit<PairEnvironmentOptions, "signal" | "onConnecting" | "onWaiting">): Promise<PairEnvironmentResult> {
    this.pairingAbort?.abort();
    const abort = new AbortController();
    this.pairingAbort = abort;
    const setPairing = (pairing: UiEnvironmentPairing | undefined) => {
      if (this.pairingAbort !== abort) return;
      this.pairing = pairing;
      this.schedulePublish();
    };
    setPairing({ address, state: "connecting" });
    const result = await (this.options.pair ?? pairEnvironment)({
      ...options,
      signal: abort.signal,
      onConnecting: (url) => setPairing({ address: url, state: "connecting" }),
      onWaiting: ({ address: url, verification, expiresAt }) => setPairing({ address: url, state: "waiting", verification, expiresAt }),
    });
    if (this.pairingAbort === abort) {
      this.pairingAbort = undefined;
      this.pairing = undefined;
      this.schedulePublish();
    }
    return result;
  }

  cancelPairing(): void {
    this.pairingAbort?.abort();
  }

  async rename(id: string, name: string): Promise<boolean> {
    const changed = await this.catalog?.update(id, { name }) ?? false;
    this.schedulePublish();
    return changed;
  }

  /** Forgets a machine and its key. A page showing it goes back to this machine. */
  async remove(id: string): Promise<boolean> {
    if (!this.catalog?.get(id)) return false;
    this.watched.get(id)?.monitor.close();
    this.watched.delete(id);
    await this.catalog.remove(id);
    // Its agents' key goes with it; the other machine lists both devices until its owner revokes them.
    await this.options.agents?.remove(id).catch((error: unknown) => this.options.logger.warn("environment.agents.remove-failed", { id, error: error instanceof Error ? error.message : String(error) }));
    this.options.logger.info("environment.removed", { id });
    this.schedulePublish();
    if (this.shownId === id) await this.open(this.options.local.id);
    return true;
  }

  retry(id: string): void {
    const watched = this.watched.get(id);
    if (!watched) return;
    // A refused monitor has given up; a new one starts over with the saved key.
    if (watched.state.status === "refused") {
      const saved = this.catalog?.get(id);
      this.watched.delete(id);
      watched.monitor.close();
      if (saved) this.watchSaved(saved);
      else if (id === this.options.local.id && this.localConnection) this.setLocalHost(this.localConnection.url, this.localConnection.token);
      return;
    }
    watched.monitor.retryNow();
  }

  /**
   * Shows a machine in the page, with a thread or a new thread's draft to
   * open on arrival. The page of the machine already shown handles its own
   * targets; this is only for crossing to another one.
   */
  async open(id: string, target?: EnvironmentOpenTarget): Promise<void> {
    if (target && "threadId" in target) {
      const session = this.watched.get(id)?.state.index?.sessions.find((entry) => entry.id === target.threadId);
      if (!session) throw new Error(`${this.machineName(id)} does not list that thread${this.watched.get(id)?.state.index ? "" : " yet"}.`);
      return this.open(id, { thread: { path: session.path } });
    }
    if (id === this.options.local.id) {
      this.shownId = id;
      this.arrival = target;
      this.schedulePublish();
      this.rememberShown();
      await this.options.show(undefined);
      return;
    }
    const connection = this.connection(id);
    if (!connection) throw new Error("Tau does not know that machine.");
    const state = this.watched.get(id)?.state;
    if (state?.status !== "connected") {
      const name = this.catalog?.get(id)?.name ?? "That machine";
      throw new Error(state?.status === "refused" ? `${name} refuses this window: ${state.detail ?? ""}`.trim() : `${name} is not reachable right now.`);
    }
    this.shownId = id;
    this.arrival = target;
    this.schedulePublish();
    this.rememberShown();
    await this.options.show(await this.forPage(connection));
  }

  /**
   * The page's Chromium does not resolve `.local` names here, while this
   * process does; the page gets the address, pinned like the name.
   */
  private async forPage(connection: EnvironmentConnection): Promise<EnvironmentConnection> {
    const url = new URL(connection.url);
    if (!/\.local$/iu.test(url.hostname)) return connection;
    const resolve = this.options.resolve ?? (async (name: string) => (await lookup(name)).address);
    const address = await resolve(url.hostname).catch(() => undefined);
    if (!address) return connection;
    this.resolved.set(address.toLowerCase(), connection.id);
    url.hostname = address.includes(":") ? `[${address}]` : address;
    return { ...connection, url: url.toString() };
  }

  private rememberShown(): void {
    if (!this.catalog?.preferences.reopenShown) return;
    this.inBackground(this.catalog.setPreferences({ lastShown: this.shownId }));
  }

  /** What the page was sent here to show; handed out once. */
  takeArrival(): EnvironmentTarget | undefined {
    const arrival = this.arrival;
    this.arrival = undefined;
    return arrival;
  }

  /** The address, key and pin of a saved machine; the one that answers now, else the best known. */
  connection(id: string): EnvironmentConnection | undefined {
    const saved = this.catalog?.get(id);
    if (!saved) return undefined;
    const address = this.watched.get(id)?.state.address;
    const url = address ?? socketUrl(orderEndpoints(saved.endpoints, saved.lastUrl)[0]!.url);
    const trust = endpointTrust(saved, url);
    return { id, url, token: saved.token, ...(trust ? { trust } : {}) };
  }

  /**
   * Chromium's verdict on a certificate, for the page's own sockets: a host
   * name a saved machine was pinned for accepts that machine's key and no
   * other, unless the machine also lists the name as one a CA vouches for;
   * every other name is Chromium's to decide.
   */
  certificateVerdict(hostname: string, presented: PresentedIdentity): number {
    const bare = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    let pinned = false;
    let authority = false;
    for (const entry of this.catalog?.list() ?? []) {
      // The address this process resolved a `.local` name to stands for that name.
      const resolved = this.resolved.get(bare) === entry.id;
      for (const endpoint of entry.endpoints) {
        if (!endpoint.url.startsWith("https:")) continue;
        const url = socketUrl(endpoint.url);
        if (hostEndpoint(url).hostname !== bare && !(resolved && endpoint.kind === "mdns")) continue;
        const trust = endpointTrust(entry, url);
        if (trust?.pin) {
          if (pinAccepts(trust.pin, presented)) return CERTIFICATE_ACCEPT;
          pinned = true;
        }
        if (!trust?.pin || trust.allowAuthority) authority = true;
      }
    }
    // Chromium checks chain and name for an address a CA vouches for.
    return authority || !pinned ? CERTIFICATE_DEFAULT : CERTIFICATE_REJECT;
  }

  /** Whether a socket URL is one of the saved machines' addresses: the page's `Origin` is dropped for exactly these. */
  isSavedSocket(url: string): boolean {
    let target: URL;
    try { target = new URL(url); } catch { return false; }
    const address = target.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    return (this.catalog?.list() ?? []).some((entry) => entry.endpoints.some((endpoint) => {
      const socket = new URL(socketUrl(endpoint.url));
      return socket.protocol === target.protocol && (socket.host === target.host
        || (this.resolved.get(address) === entry.id && socket.port === target.port));
    }));
  }

  /**
   * A thread of a machine, by its id or unique name, looked in on from a tab
   * (API 1.15.0): renews the lease that keeps its stream coming over the
   * window's connection to that machine, or ends it.
   */
  watchThread(machine: string, sessionId: string, on: boolean): UiEnvironmentThreadView | undefined {
    const id = this.resolveMachine(machine) ?? machine;
    if (!on) {
      this.lookIns.unwatch(id, sessionId);
      return undefined;
    }
    if (this.watched.has(id) && this.lookIns.watch(id, sessionId)) this.askOpenDialogs(id);
    return this.threadView(id, sessionId);
  }

  /** A page of a machine's thread, read over the window's connection to it with the window's key there. */
  async transcriptPage(machine: string, sessionId: string, cursor?: HostTranscriptCursor): Promise<TranscriptPage> {
    const id = this.resolveMachine(machine);
    const watched = id ? this.watched.get(id) : undefined;
    if (!id || !watched) throw new Error("Tau does not know that machine.");
    if (watched.state.status !== "connected") {
      throw new Error(watched.state.status === "refused" ? `${this.machineName(id)} refuses this window: ${watched.state.detail ?? ""}`.trim() : `${this.machineName(id)} is not reachable right now.`);
    }
    return watched.monitor.call<TranscriptPage>("transcript-page", cursor ? [sessionId, cursor] : [sessionId]);
  }

  /** A dialog asked before the watch began is heard again: the machine replays its open ones. */
  private askOpenDialogs(id: string): void {
    const watched = this.watched.get(id);
    if (watched?.state.status !== "connected") return;
    watched.monitor.call("sync-extension-ui").catch((error: unknown) => this.options.logger.warn("environment.look-in.replay-failed", { id, error: error instanceof Error ? error.message : String(error) }));
  }

  /** A machine by its host id, or by its name when no other machine has it. */
  private resolveMachine(machine: string): string | undefined {
    if (machine === this.options.local.id || this.catalog?.get(machine)) return machine;
    const named = [
      { id: this.options.local.id, name: this.options.local.name },
      ...(this.catalog?.list() ?? []),
    ].filter((entry) => entry.name.toLowerCase() === machine.toLowerCase());
    return named.length === 1 ? named[0]!.id : undefined;
  }

  private machineName(id: string): string {
    return id === this.options.local.id ? this.options.local.name : this.catalog?.get(id)?.name ?? "That machine";
  }

  private threadView(machine: string, sessionId: string): UiEnvironmentThreadView {
    const known = machine === this.options.local.id || this.catalog?.get(machine) !== undefined;
    const state = this.watched.get(machine)?.state;
    const watch = this.lookIns.get(machine, sessionId);
    const session = state?.index?.sessions.find((entry) => entry.id === sessionId);
    return {
      machine,
      sessionId,
      machineName: known ? this.machineName(machine) : machine,
      status: known ? state?.status ?? "connecting" : "unknown",
      ...(state?.detail ? { detail: state.detail } : {}),
      ...(state?.status !== "connected" && state?.lastSeenAt !== undefined ? { lastSeenAt: state.lastSeenAt } : {}),
      indexed: state?.index !== undefined,
      ...(session ? {
        thread: {
          title: session.title || "Untitled thread",
          path: session.path,
          projectName: session.projectName,
          modifiedAt: session.modifiedAt,
          messageCount: session.messageCount,
          running: state?.running.has(sessionId) ?? false,
          ...(session.usage ? { usage: session.usage } : {}),
          ...(session.parentThreadId ? { parentThreadId: session.parentThreadId } : {}),
        },
      } : {}),
      ...(watch?.asking ? { asking: watch.asking } : {}),
      revision: watch?.revision ?? 0,
    };
  }

  /** Resolves once the catalog writes started in the background are on disk. */
  async settled(): Promise<void> {
    while (this.writes.size > 0) await Promise.all(this.writes);
  }

  private inBackground(write: Promise<unknown>): void {
    const settled = write.then(() => undefined, () => undefined).finally(() => this.writes.delete(settled));
    this.writes.add(settled);
  }

  close(): void {
    this.closed = true;
    this.pairingAbort?.abort();
    this.lookIns.close();
    for (const watched of this.watched.values()) watched.monitor.close();
    this.watched.clear();
    if (this.publishTimer) clearTimeout(this.publishTimer);
  }

  private watchSaved(saved: SavedEnvironment): void {
    const catalog = this.catalog;
    const current = () => catalog?.get(saved.id) ?? saved;
    // Pins are read at every attempt, so a migrated pin needs no new monitor.
    this.watch(saved.id, saved.token, {
      urls: () => orderEndpoints(current().endpoints, current().lastUrl).map((endpoint) => socketUrl(endpoint.url)),
      token: saved.token,
      trust: (url) => endpointTrust(current(), url),
      onReached: (url, reply, certificate) => {
        const entry = current();
        const page = entry.endpoints.find((endpoint) => socketUrl(endpoint.url) === url)?.url;
        // A certificate pin that just held vouches for the key it certified; from now on the key is pinned.
        const migrate = !entry.publicKey && entry.fingerprint && certificate?.via === "pin";
        if (migrate) this.options.logger.info("environment.pin-migrated", { id: saved.id, publicKey: certificate.presented.publicKey });
        if (catalog) {
          this.inBackground(catalog.update(saved.id, {
            ...(page ? { lastUrl: page } : {}),
            readOnly: reply.access === "read-only" ? true : undefined,
            ...(migrate ? { publicKey: certificate.presented.publicKey, fingerprint: undefined } : {}),
          }));
        }
        if (reply.host?.id === saved.id && reply.host.endpoints?.length) {
          this.inBackground(this.refreshAddresses(saved.id, reply.host.endpoints, page, "hello"));
        }
      },
    });
  }

  /** A saved machine's addresses after it told fresh ones; true when they changed. */
  private async refreshAddresses(id: string, fresh: readonly PairingEndpoint[], keep: string | undefined, source: "hello" | "bonjour"): Promise<boolean> {
    const current = this.catalog?.get(id);
    if (!current) return false;
    const endpoints = refreshEndpoints(current.endpoints, fresh, keep ?? current.lastUrl);
    if (sameEndpoints(endpoints, current.endpoints)) return false;
    await this.catalog!.update(id, { endpoints });
    this.options.logger.info("environment.addresses", { id, source, endpoints: endpoints.length });
    return true;
  }

  private watch(id: string, key: string, options: Omit<EnvironmentMonitorOptions, "onChange" | "logger">): void {
    if (this.closed) return;
    const existing = this.watched.get(id);
    if (existing?.key === key) return;
    existing?.monitor.close();
    const entry: Watched = { key, state: { status: "connecting", running: new Set() }, monitor: undefined as unknown as EnvironmentMonitor };
    const kept = existing?.kept;
    if (kept) entry.kept = kept;
    this.watched.set(id, entry);
    entry.monitor = (this.options.monitor ?? ((monitorOptions) => new EnvironmentMonitor(monitorOptions)))({
      ...options,
      logger: this.options.logger,
      threads: () => this.lookIns.threads(id),
      onPush: (event) => { if (this.watched.get(id) === entry) this.lookIns.onPush(id, event); },
      onChange: (state) => {
        if (this.watched.get(id) !== entry) return;
        const reached = state.status === "connected" && entry.state.status !== "connected";
        entry.state = state;
        this.lookIns.onStatus(id, state.status);
        if (reached && this.lookIns.threads(id).length > 0) this.askOpenDialogs(id);
        if (state.status === "connected") for (const waiter of [...this.connectedWaiters.get(id) ?? []]) waiter();
        if (state.index) {
          entry.kept = {
            threads: environmentThreads(state.index, state.running),
            threadCount: state.index.sessions.filter((session) => !session.parentThreadId).length,
            projects: environmentProjects(state.index),
          };
        }
        this.schedulePublish();
      },
    });
  }

  private describe(id: string, base: { name: string; local: boolean; readOnly?: boolean | undefined; address?: string | undefined }): UiEnvironment {
    const watched = this.watched.get(id);
    const state = watched?.state;
    const kept = watched?.kept;
    return {
      id,
      name: base.name,
      local: base.local,
      status: state?.status ?? "connecting",
      ...(state?.detail ? { detail: state.detail } : {}),
      ...(state?.roundTripMs !== undefined ? { roundTripMs: state.roundTripMs } : {}),
      ...(state?.lastSeenAt !== undefined ? { lastSeenAt: state.lastSeenAt } : {}),
      ...(state?.address ?? base.address ? { address: state?.address ?? base.address } : {}),
      ...(state?.readOnly ?? base.readOnly ? { readOnly: true } : {}),
      ...(state?.hostVersion ? { hostVersion: state.hostVersion } : {}),
      threads: kept?.threads ?? [],
      threadCount: kept?.threadCount ?? 0,
      projects: kept?.projects ?? [],
    };
  }

  private schedulePublish(): void {
    if (this.closed || this.publishTimer) return;
    // A burst of index and status pushes becomes one message to the page.
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      this.options.publish(this.snapshot());
    }, 50);
    this.publishTimer.unref?.();
  }
}

/** A Bonjour record carries the pin a machine was saved with: its key, or for an old pin its certificate. */
function recordMatchesPin(saved: Pick<SavedEnvironment, "publicKey" | "fingerprint">, record: { fingerprint: string; publicKey?: string }): boolean {
  if (saved.publicKey) return record.publicKey !== undefined && fingerprintsMatch(record.publicKey, saved.publicKey);
  return saved.fingerprint !== undefined && fingerprintsMatch(record.fingerprint, saved.fingerprint);
}
