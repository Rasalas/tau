import type {
  EnvironmentPairInput,
  EnvironmentPairResult,
  EnvironmentTarget,
  UiEnvironment,
  UiEnvironmentPairing,
  UiEnvironments,
} from "../shared/environments.js";
import { environmentProjects, environmentThreads, orderEndpoints, socketUrl } from "../shared/environments.js";
import { reachedEndpoints } from "../shared/connections.js";
import { EnvironmentCatalog, endpointTrust, type SavedEnvironment, type SecretBox } from "./environment-catalog.js";
import { EnvironmentMonitor, type EnvironmentMonitorOptions, type MonitorState } from "./environment-monitor.js";
import { pairEnvironment, type PairEnvironmentOptions } from "./environment-pairing.js";
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
  /**
   * Point the page at another machine, or back at this one (`undefined`).
   * The window's process attaches its uplink and loads the page again.
   */
  show(connection: EnvironmentConnection | undefined): Promise<void>;
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

  constructor(private readonly options: WindowEnvironmentsOptions) {
    this.shownId = options.local.id;
  }

  async start(): Promise<void> {
    this.catalog = await EnvironmentCatalog.open(this.options.catalogPath, this.options.box, this.options.logger);
    for (const saved of this.catalog.list()) this.watchSaved(saved);
    this.schedulePublish();
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
    };
  }

  async pair(input: EnvironmentPairInput): Promise<EnvironmentPairResult> {
    if (!this.catalog) throw new Error("The machine list is not ready yet.");
    if (!this.catalog.secure) return { state: "failed", message: "This machine offers Tau no encrypted storage (no keychain or secret service), so it cannot keep another machine's key." };
    this.pairingAbort?.abort();
    const abort = new AbortController();
    this.pairingAbort = abort;
    const setPairing = (pairing: UiEnvironmentPairing | undefined) => {
      if (this.pairingAbort !== abort) return;
      this.pairing = pairing;
      this.schedulePublish();
    };
    setPairing({ address: input.text.trim().slice(0, 200), state: "connecting" });
    const result = await (this.options.pair ?? pairEnvironment)({
      text: input.text,
      deviceName: input.deviceName?.trim() || this.options.deviceName,
      signal: abort.signal,
      onConnecting: (address) => setPairing({ address, state: "connecting" }),
      onWaiting: ({ address, verification, expiresAt }) => setPairing({ address, state: "waiting", verification, expiresAt }),
    });
    if (this.pairingAbort === abort) {
      this.pairingAbort = undefined;
      this.pairing = undefined;
      this.schedulePublish();
    }
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
    return { state: "added", environment: this.snapshot().environments.find((entry) => entry.id === result.environment.id)! };
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
  async open(id: string, target?: EnvironmentTarget): Promise<void> {
    if (id === this.options.local.id) {
      this.shownId = id;
      this.arrival = target;
      this.schedulePublish();
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
    await this.options.show(connection);
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
      for (const endpoint of entry.endpoints) {
        if (!endpoint.url.startsWith("https:")) continue;
        const url = socketUrl(endpoint.url);
        if (hostEndpoint(url).hostname !== bare) continue;
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
    return (this.catalog?.list() ?? []).some((entry) => entry.endpoints.some((endpoint) => {
      const socket = new URL(socketUrl(endpoint.url));
      return socket.protocol === target.protocol && socket.host === target.host;
    }));
  }

  close(): void {
    this.closed = true;
    this.pairingAbort?.abort();
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
        void catalog?.update(saved.id, {
          ...(page ? { lastUrl: page } : {}),
          readOnly: reply.access === "read-only" ? true : undefined,
          ...(migrate ? { publicKey: certificate.presented.publicKey, fingerprint: undefined } : {}),
        }).catch(() => undefined);
      },
      onReach: (url, reach) => {
        const entry = current();
        if (reach.hostId && reach.hostId !== saved.id) return;
        const endpoints = reachedEndpoints(reach.endpoints, entry.endpoints.find((endpoint) => socketUrl(endpoint.url) === url));
        if (JSON.stringify(endpoints) === JSON.stringify(entry.endpoints)) return;
        this.options.logger.info("environment.endpoints-updated", { id: saved.id, endpoints: endpoints.length });
        void catalog?.update(saved.id, { endpoints }).catch(() => undefined);
      },
    });
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
      onChange: (state) => {
        if (this.watched.get(id) !== entry) return;
        entry.state = state;
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
