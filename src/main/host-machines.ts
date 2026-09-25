import { authorityName, type PairingEndpoint, type UiHostEndpointKind } from "../shared/connections.js";
import { orderEndpoints, refreshEndpoints, sameEndpoints, socketUrl } from "../shared/environments.js";
import { HOST_ERROR } from "../shared/host-transport.js";
import { EnvironmentCatalog, endpointTrust, type SavedEnvironment } from "./environment-catalog.js";
import { EnvironmentMonitor, type EnvironmentMonitorOptions, type MonitorState } from "./environment-monitor.js";
import {
  BIND_MACHINES_EXTENSION,
  type HostMachine,
  type HostMachineEvent,
  type HostMachineServices,
} from "./host-extensions.js";
import type { HostMethodContext } from "./host-jobs.js";
import { isHostOwner } from "./host-invocation.js";
import type { HostLogger } from "./host-log.js";
import { isMachineRequestMethod, ownerRefusal } from "./host-method-access.js";
import { decodeString } from "./ipc-input.js";

/** A machine this host's agents may reach: what a window saves for itself, with the agents' own token. */
export type HostMachineEntry = SavedEnvironment;

export interface HostMachinesOptions {
  /** `<userData>/host-machines.json`, mode 0600. */
  path: string;
  logger: HostLogger;
  /** This host's own id: a machine never adds itself. */
  ownId: string;
  /** Test seam. */
  monitor?(options: EnvironmentMonitorOptions): EnvironmentMonitor;
}

interface Watched {
  entry: HostMachineEntry;
  monitor: EnvironmentMonitor;
  state: MonitorState;
  /** Listeners by `<extensionId>/<topic>`. */
  topics: Map<string, Set<(event: HostMachineEvent) => void>>;
}

// The host has no keychain: the token is kept like `host-token`, in the clear in a 0600 file.
const PLAIN = { available: () => true, encrypt: (text: string) => text, decrypt: (data: string) => data };

const failure = (message: string, code: string = HOST_ERROR.failed): Error => Object.assign(new Error(message), { code });

/**
 * The machines this host reaches on its own, for its agents (ADR 0027): a
 * catalog in `<userData>/host-machines.json` and one small connection to each,
 * the kind a window keeps for its machines (ADR 0025). The window hands a key
 * over after its owner allowed this machine's agents on the other one.
 */
export class HostMachines {
  private readonly watched = new Map<string, Watched>();
  private readonly listeners = new Set<(machines: readonly HostMachine[]) => void>();
  private closed = false;

  private constructor(private readonly catalog: EnvironmentCatalog, private readonly options: HostMachinesOptions) {}

  static async open(options: HostMachinesOptions): Promise<HostMachines> {
    const machines = new HostMachines(await EnvironmentCatalog.open(options.path, PLAIN, options.logger), options);
    for (const entry of machines.catalog.list()) machines.connect(entry);
    return machines;
  }

  list(): HostMachine[] {
    return [...this.watched.values()].map(describe).sort((a, b) => a.name.localeCompare(b.name));
  }

  subscribe(listener: (machines: readonly HostMachine[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Saves a machine's key and connects; a machine saved before is replaced, its watchers kept. */
  async add(entry: HostMachineEntry): Promise<void> {
    if (entry.id === this.options.ownId) throw failure("That machine is this one.", HOST_ERROR.invalidRequest);
    await this.catalog.save(entry);
    const topics = this.watched.get(entry.id)?.topics;
    this.unwatch(entry.id);
    this.connect(entry, topics);
    this.options.logger.info("machines.added", { id: entry.id, name: entry.name, endpoints: entry.endpoints.length });
    this.changed();
  }

  /** Forgets a machine and its key. The other machine still lists the device until its owner revokes it. */
  async remove(id: string): Promise<boolean> {
    const removed = await this.catalog.remove(id);
    this.unwatch(id);
    if (removed) {
      this.options.logger.info("machines.removed", { id });
      this.changed();
    }
    return removed;
  }

  async call(machine: string, extensionId: string, command: string, input?: unknown, options: { timeoutMs?: number } = {}): Promise<unknown> {
    return this.connected(machine).monitor.call("host-extension", [extensionId, command, input], options.timeoutMs);
  }

  async request(machine: string, method: string, params: readonly unknown[] = [], options: { timeoutMs?: number } = {}): Promise<unknown> {
    if (!isMachineRequestMethod(method)) {
      throw failure(`${method} is not a method a host may ask another machine for; call a kit command there instead.`, HOST_ERROR.forbidden);
    }
    return this.connected(machine).monitor.call(method, params, options.timeoutMs);
  }

  watch(machine: string, extensionId: string, topic: string, listener: (event: HostMachineEvent) => void): () => void {
    if (!topic || topic.length > 256) throw failure("A topic has 1 to 256 characters.", HOST_ERROR.invalidRequest);
    const watched = this.find(machine);
    const key = `${extensionId}/${topic}`;
    const set = watched.topics.get(key) ?? new Set();
    const fresh = !watched.topics.has(key);
    set.add(listener);
    watched.topics.set(key, set);
    if (fresh) watched.monitor.resubscribe();
    return () => {
      set.delete(listener);
      if (set.size > 0 || watched.topics.get(key) !== set) return;
      watched.topics.delete(key);
      watched.monitor.resubscribe();
    };
  }

  /** The seam one extension sees: `watch` names its own kit on the other machine unless told otherwise. */
  forExtension(extensionId: string): HostMachineServices {
    return {
      list: () => this.list(),
      subscribe: (listener) => this.subscribe(listener),
      call: (machine, target, command, input, options) => this.call(machine, target, command, input, options),
      request: (machine, method, params, options) => this.request(machine, method, params, options),
      watch: (machine, topic, listener, options) => this.watch(machine, options?.extension ?? extensionId, topic, listener),
    };
  }

  /** What `services.machines` is before the registry binds it to one extension. */
  get services(): HostMachineServices & { [BIND_MACHINES_EXTENSION]: (extensionId: string) => HostMachineServices } {
    return { ...this.forExtension(""), [BIND_MACHINES_EXTENSION]: (extensionId: string) => this.forExtension(extensionId) };
  }

  close(): void {
    this.closed = true;
    for (const id of [...this.watched.keys()]) this.unwatch(id);
    this.listeners.clear();
  }

  private find(machine: string): Watched {
    const byId = this.watched.get(machine);
    if (byId) return byId;
    const named = [...this.watched.values()].filter((entry) => entry.entry.name.toLowerCase() === machine.trim().toLowerCase());
    if (named.length === 1) return named[0]!;
    throw failure(named.length > 1
      ? `Several machines are called ${machine}; name one by its id.`
      : `This computer's agents have no key for ${machine}. Turn on “Agents may work there” for it in Settings → Machines.`, HOST_ERROR.invalidRequest);
  }

  private connected(machine: string): Watched {
    const watched = this.find(machine);
    const { status, detail } = watched.state;
    if (status === "connected") return watched;
    const name = watched.entry.name;
    if (status === "refused") throw failure(`${name} refuses this computer's agents: ${detail ?? "its key was revoked there"}`, HOST_ERROR.unauthorized);
    throw failure(status === "connecting" ? `Connecting to ${name}…` : `${name} is offline${detail ? `: ${detail}` : "."}`, HOST_ERROR.failed);
  }

  private connect(entry: HostMachineEntry, topics = new Map<string, Set<(event: HostMachineEvent) => void>>()): void {
    if (this.closed) return;
    const current = () => this.catalog.get(entry.id) ?? entry;
    const watched: Watched = { entry, topics, state: { status: "connecting", running: new Set() }, monitor: undefined as unknown as EnvironmentMonitor };
    this.watched.set(entry.id, watched);
    watched.monitor = (this.options.monitor ?? ((options) => new EnvironmentMonitor(options)))({
      urls: () => orderEndpoints(current().endpoints, current().lastUrl).map((endpoint) => socketUrl(endpoint.url)),
      token: entry.token,
      trust: (url) => endpointTrust(current(), url),
      bootstrap: false,
      unauthorizedDetail: "its owner revoked this computer's agents there, or their access expired. Turn them on again in Settings → Machines.",
      topics: () => [...watched.topics.keys()],
      logger: this.options.logger,
      onPush: (event) => deliver(watched, event),
      onChange: (state) => {
        if (this.watched.get(entry.id) !== watched) return;
        const before = watched.state;
        watched.state = state;
        if (before.status !== state.status || before.detail !== state.detail) {
          this.options.logger.info("machines.status", { id: entry.id, status: state.status, ...(state.detail ? { detail: state.detail } : {}) });
        }
        this.changed();
      },
      onReached: (url, reply, certificate) => {
        const saved = current();
        const page = saved.endpoints.find((endpoint) => socketUrl(endpoint.url) === url)?.url;
        // As a window does: a certificate pin that just held vouches for its key.
        const migrate = !saved.publicKey && saved.fingerprint && certificate?.via === "pin";
        const endpoints = reply.host?.id === saved.id && reply.host.endpoints?.length
          ? refreshEndpoints(saved.endpoints, reply.host.endpoints, page ?? saved.lastUrl) : saved.endpoints;
        void this.catalog.update(saved.id, {
          ...(page ? { lastUrl: page } : {}),
          readOnly: reply.access === "read-only" ? true : undefined,
          ...(migrate ? { publicKey: certificate.presented.publicKey, fingerprint: undefined } : {}),
          ...(sameEndpoints(endpoints, saved.endpoints) ? {} : { endpoints }),
        }).catch((error: unknown) => this.options.logger.warn("machines.update-failed", error));
      },
    });
  }

  private unwatch(id: string): void {
    const watched = this.watched.get(id);
    if (!watched) return;
    this.watched.delete(id);
    watched.monitor.close();
  }

  private changed(): void {
    const list = this.list();
    for (const listener of [...this.listeners]) {
      try { listener(list); } catch (error: unknown) { this.options.logger.warn("machines.listener-failed", error); }
    }
  }
}

function describe(watched: Watched): HostMachine {
  const { state, entry } = watched;
  return {
    id: entry.id,
    name: entry.name,
    status: state.status,
    ...(state.detail ? { detail: state.detail } : {}),
    ...(state.roundTripMs !== undefined ? { roundTripMs: state.roundTripMs } : {}),
    ...(state.lastSeenAt !== undefined ? { lastSeenAt: state.lastSeenAt } : {}),
    ...(state.address ?? entry.lastUrl ? { address: state.address ?? entry.lastUrl } : {}),
    ...(state.hostVersion ? { hostVersion: state.hostVersion } : {}),
    ...(state.readOnly ?? entry.readOnly ? { readOnly: true } : {}),
  };
}

function deliver(watched: Watched, event: unknown): void {
  const item = event as { type?: unknown; extensionId?: unknown; topic?: unknown; name?: unknown; payload?: unknown } | undefined;
  if (item?.type !== "extension-event" || typeof item.extensionId !== "string" || typeof item.topic !== "string" || typeof item.name !== "string") return;
  const listeners = watched.topics.get(`${item.extensionId}/${item.topic}`);
  for (const listener of [...listeners ?? []]) {
    try { listener({ name: item.name, ...(item.payload !== undefined ? { payload: item.payload } : {}) }); } catch { /* one watcher's failure is its own */ }
  }
}

const KINDS = new Set<string>(["loopback", "lan", "mdns", "tailscale", "magicdns"]);

/** What `machines-add` takes: the machine as the window paired it, and the agents' token. */
export function decodeMachineEntry(value: unknown): HostMachineEntry {
  const item = value as Record<string, unknown> | undefined;
  if (!item || typeof item !== "object") throw failure("machines-add: expected an object.", HOST_ERROR.invalidRequest);
  const id = decodeString("machines-add", "id", item.id);
  const token = decodeString("machines-add", "token", item.token);
  const endpoints: PairingEndpoint[] = (Array.isArray(item.endpoints) ? item.endpoints : []).flatMap((raw: unknown) => {
    const endpoint = raw as { url?: unknown; kind?: unknown; trustedCertificate?: unknown } | undefined;
    if (typeof endpoint?.url !== "string" || !/^https?:\/\//u.test(endpoint.url)) return [];
    return [{
      url: endpoint.url,
      ...(typeof endpoint.kind === "string" && KINDS.has(endpoint.kind) ? { kind: endpoint.kind as UiHostEndpointKind } : {}),
      ...(endpoint.trustedCertificate === true && authorityName(endpoint.url) ? { trustedCertificate: true } : {}),
    }];
  });
  if (endpoints.length === 0 || endpoints.length > 16) throw failure("machines-add: a machine needs 1 to 16 addresses.", HOST_ERROR.invalidRequest);
  const text = (key: string, max: number): string | undefined => typeof item[key] === "string" && item[key] ? (item[key] as string).slice(0, max) : undefined;
  const publicKey = text("publicKey", 200);
  const fingerprint = text("fingerprint", 200);
  const lastUrl = text("lastUrl", 2_048);
  return {
    id: id.slice(0, 200),
    name: text("name", 80) ?? id.slice(0, 8),
    endpoints,
    ...(publicKey ? { publicKey } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    token,
    addedAt: text("addedAt", 40) ?? new Date().toISOString(),
    ...(lastUrl ? { lastUrl } : {}),
    ...(item.readOnly === true ? { readOnly: true } : {}),
  };
}

type Method = (params: readonly unknown[], context: HostMethodContext) => Promise<unknown>;

/**
 * `machines-*`: the owner's window hands this host a key for another machine,
 * takes it back, and reads how each connection is doing. Keys never leave.
 */
export function createMachineMethods(service: () => HostMachines | undefined): Record<string, Method> {
  const owned = (run: (machines: HostMachines, params: readonly unknown[]) => Promise<unknown>): Method => async (params, context) => {
    if (!isHostOwner(context.principal)) throw ownerRefusal();
    const machines = service();
    if (!machines) throw failure("This host keeps no machines of its own; a host in the window's process has none.", HOST_ERROR.unsupported);
    return run(machines, params);
  };
  return {
    "machines-list": owned(async (machines) => ({ machines: machines.list() })),
    "machines-add": owned(async (machines, params) => {
      await machines.add(decodeMachineEntry(params[0]));
      return { added: true };
    }),
    "machines-remove": owned(async (machines, params) => ({ removed: await machines.remove(decodeString("machines-remove", "id", params[0])) })),
  };
}
