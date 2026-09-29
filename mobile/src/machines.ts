import type { HostBootstrap, HostExtensionSummary, ThreadIndexSnapshot } from "../../src/shared/contracts";
import {
  applyIndexUpdate,
  environmentProjects,
  environmentThreads,
  type EnvironmentOpenTarget,
  type EnvironmentStatus,
  type EnvironmentTarget,
  type IndexUpdate,
  type UiEnvironment,
  type UiEnvironments,
} from "../../src/shared/environments";
import type { HostPush } from "../../src/shared/host-transport";
import { decodeHostUpdateStatus, HOST_UPDATE_METHODS, type HostUpdateStatus } from "../../src/shared/host-updates";
import type { ClientStorage } from "../../src/workbench/client-storage";
import type { PlatformEnvironments } from "../../src/workbench/environments";
import type { HostClient } from "../../src/workbench/host-client";
import type { HostConnectionState } from "../../src/workbench/host-connection";
import { STORAGE_KEYS } from "../../src/workbench/storage-keys";
import type { RaceFailure, RaceTimers } from "./endpoints";
import type { SavedHost } from "./hosts";
import { MachineLink, type LinkEnd, type LinkSocket } from "./machine-link";
import type { AppRoute } from "./routes";
import { hostStorage } from "./storage";

/** Another host's list, read again this often while the app is in front. */
export const MACHINES_REFRESH_MS = 2 * 60_000;
/** Coming back to the app reads them again, unless they were read this recently. */
export const MACHINES_FOCUS_MIN_MS = 15_000;
/** The first read waits for the shown host's own connection to settle. */
export const MACHINES_START_MS = 1_500;
/** Kept of each host between reads, so a reload shows its threads at once. */
const KEPT_SESSIONS = 80;
const CACHE_KEY = "tau.mobile.machine.v1";
/** What `open` carries to the next page: the app loads afresh on another host. */
export const ARRIVAL_KEY = "tau.mobile.arrival.v1";
const READ_COMMANDS_RETRY_MS = 10_000;

/** Where the phone is looking: the app in front, or away. */
export interface Visibility {
  visible(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface PhoneMachinesOptions {
  /** Every saved host with its token, read once when the list is first asked for. */
  hosts(): Promise<Array<{ host: SavedHost; token?: string }>>;
  /** The page's store, not one host's. */
  storage: ClientStorage;
  /** The host the workbench shows, and its own connection. */
  shown: SavedHost;
  client: Pick<HostClient, "getConnectionState" | "onConnectionState"> & Partial<Pick<HostClient, "hostUpdate">>;
  /** A pinned, raced socket to a saved host. */
  socket(host: SavedHost, onFailure: (failure: RaceFailure) => void): LinkSocket;
  navigate(route: AppRoute): void;
  /** A host refused the phone's token: it is dropped, as opening that host would. */
  forgetToken(id: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  visibility: Visibility;
  now?(): number;
  timers?: RaceTimers;
  lingerMs?: number;
}

interface Kept {
  /** What the last visit found; the next page starts from it instead of "connecting". */
  status?: "connected" | "offline";
  detail?: string;
  index?: ThreadIndexSnapshot;
  running: string[];
  lastSeq?: number;
  lastSeenAt?: number;
  threadCount?: number;
}

interface Machine {
  host: SavedHost;
  token: string | undefined;
  status: EnvironmentStatus;
  detail?: string;
  lastSeenAt?: number;
  readOnly?: boolean;
  update?: HostUpdateStatus;
  index?: ThreadIndexSnapshot;
  threadCount: number;
  running: Set<string>;
  lastSeq?: number;
  link?: MachineLink;
  reading?: Promise<void>;
  readCommands?: { at: number; commands: Promise<Set<string>> };
}

function trimmed(index: ThreadIndexSnapshot): ThreadIndexSnapshot {
  const sessions = [...index.sessions].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, KEPT_SESSIONS);
  return { projects: index.projects, sessions };
}

function shownStatus(state: HostConnectionState): EnvironmentStatus {
  return state === "refused" ? "refused" : state === "reconnecting" ? "offline" : "connected";
}

/**
 * The phone's `Platform.environments` (ADR 0025, K106): every host it paired
 * with, one connection each with its own token. The shown host streams through
 * the workbench's own connection; the others are read in short visits — at
 * start, every two minutes while the app is in front, when it comes back to
 * the front, and on Retry — that replay what the host pushed since the last
 * one, or take a snapshot when it cannot. Opening a thread or starting one on
 * another host loads the app afresh there.
 */
export class PhoneMachines implements PlatformEnvironments {
  private machines = new Map<string, Machine>();
  private loaded: Promise<void> | undefined;
  private snapshot: UiEnvironments | undefined;
  private readonly listeners = new Set<() => void>();
  private shownState: HostConnectionState;
  private shownLostAt: number | undefined;
  private shownUpdate: HostUpdateStatus | undefined;
  private lastRound = 0;
  private stops: Array<() => void> = [];
  private poll: unknown;
  private readonly timers: RaceTimers;

  constructor(private readonly options: PhoneMachinesOptions) {
    this.timers = options.timers ?? { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
    this.shownState = options.client.getConnectionState();
  }

  getSnapshot = (): UiEnvironments | undefined => {
    void this.load();
    return this.snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    void this.load();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Stops every timer and link; the page is going away. */
  dispose(): void {
    for (const stop of this.stops) stop();
    this.stops = [];
    this.timers.clearTimeout(this.poll);
    for (const machine of this.machines.values()) machine.link?.close();
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private load(): Promise<void> {
    this.loaded ??= this.options.hosts().then((hosts) => {
      for (const { host, token } of hosts) {
        if (host.id === this.options.shown.id) continue;
        const kept = this.readKept(host.id);
        this.machines.set(host.id, {
          host,
          token,
          status: token ? kept?.status ?? "connecting" : "refused",
          ...(token ? kept?.detail ? { detail: kept.detail } : {} : { detail: `${host.name} no longer accepts this phone. Open it to pair again.` }),
          ...(kept?.lastSeenAt !== undefined ? { lastSeenAt: kept.lastSeenAt } : {}),
          ...(host.access === "read-only" ? { readOnly: true } : {}),
          ...(kept?.index ? { index: kept.index } : {}),
          threadCount: kept?.threadCount ?? kept?.index?.sessions.length ?? 0,
          running: new Set(kept?.running ?? []),
          ...(kept?.lastSeq !== undefined ? { lastSeq: kept.lastSeq } : {}),
        });
      }
      this.stops.push(this.options.client.onConnectionState((state) => {
        if (state === "reconnecting" && this.shownState !== "reconnecting") this.shownLostAt = this.now();
        this.shownState = state;
        this.publish();
      }));
      this.stops.push(this.options.visibility.subscribe(() => this.onVisibility()));
      void this.options.client.hostUpdate?.("status").then((status) => { this.shownUpdate = status; this.publish(); }, () => undefined);
      this.publish();
      if (this.machines.size === 0) return;
      this.poll = this.timers.setTimeout(() => this.tick(), MACHINES_START_MS);
    });
    return this.loaded;
  }

  private tick(): void {
    if (this.options.visibility.visible()) this.readAll();
    this.poll = this.timers.setTimeout(() => this.tick(), MACHINES_REFRESH_MS);
  }

  private onVisibility(): void {
    if (!this.options.visibility.visible()) {
      // Nothing stays open in the background.
      for (const machine of this.machines.values()) machine.link?.close();
      return;
    }
    if (this.now() - this.lastRound >= MACHINES_FOCUS_MIN_MS) this.readAll();
  }

  private readAll(): void {
    this.lastRound = this.now();
    for (const machine of this.machines.values()) void this.read(machine);
  }

  /** One visit: hello, what changed since the last one, the host's own update state. */
  private read(machine: Machine): Promise<void> {
    if (!machine.token) return Promise.resolve();
    machine.reading ??= (async () => {
      try {
        const link = this.linkOf(machine);
        await link.ready();
        if (!machine.index) await this.snapshotOf(machine, link);
        const update = await link.call<unknown>(HOST_UPDATE_METHODS.status).then(decodeHostUpdateStatus, () => undefined);
        if (update) machine.update = update;
        this.set(machine, { status: "connected", lastSeenAt: this.now() });
        this.keep(machine);
      } catch (error) {
        if (machine.status !== "refused") {
          this.set(machine, { status: "offline", detail: error instanceof Error ? error.message : String(error) });
          this.keep(machine);
        }
      } finally {
        machine.reading = undefined;
      }
    })();
    return machine.reading;
  }

  private async snapshotOf(machine: Machine, link: MachineLink): Promise<void> {
    const bootstrap = await link.call<HostBootstrap>("bootstrap");
    machine.index = trimmed(bootstrap.threadIndex);
    machine.threadCount = bootstrap.threadIndex.sessions.length;
    machine.running = new Set(Object.keys(bootstrap.threadIndex.runs ?? {}));
  }

  private linkOf(machine: Machine): MachineLink {
    machine.link ??= new MachineLink({
      open: (onFailure) => this.options.socket(machine.host, onFailure),
      token: machine.token!,
      lastSeq: () => machine.index ? machine.lastSeq : undefined,
      onHello: (reply) => {
        if (reply.access === "read-only") machine.readOnly = true;
        // A gap the host cannot replay starts from a snapshot again.
        if (reply.resync) machine.index = undefined;
        else for (const push of reply.missed) this.apply(machine, push, false);
        machine.lastSeq = reply.nextSeq - 1;
      },
      onPush: (push) => this.apply(machine, push, true),
      onEnd: (end) => this.ended(machine, end),
      ...(this.options.lingerMs !== undefined ? { lingerMs: this.options.lingerMs } : {}),
      ...(this.options.timers ? { timers: this.options.timers } : {}),
    });
    return machine.link;
  }

  private apply(machine: Machine, push: HostPush, live: boolean): void {
    machine.lastSeq = Math.max(machine.lastSeq ?? 0, push.seq);
    const event = push.event as { type?: string; threadIndex?: ThreadIndexSnapshot; update?: IndexUpdate; sessionId?: string; running?: boolean };
    let changed = false;
    if (event.type === "thread-index" && event.threadIndex) {
      const index = applyIndexUpdate(machine.index, { type: "thread-index", index: event.threadIndex });
      if (index) { machine.index = trimmed(index); machine.threadCount = index.sessions.length; changed = true; }
    } else if (event.type === "host-update" && event.update) {
      const update = event.update as IndexUpdate & { event?: string; sessionId?: string };
      if (update.type === "run" && typeof update.sessionId === "string") {
        if (update.event === "started") machine.running.add(update.sessionId);
        else machine.running.delete(update.sessionId);
        changed = true;
      } else if (machine.index) {
        const index = applyIndexUpdate(machine.index, update);
        if (index) { machine.index = trimmed(index); changed = true; }
      }
    } else if (event.type === "agent-status" && typeof event.sessionId === "string") {
      if (event.running === true) machine.running.add(event.sessionId);
      else machine.running.delete(event.sessionId);
      changed = true;
    }
    if (changed && live) {
      this.set(machine, { lastSeenAt: this.now() });
      this.keep(machine);
    }
  }

  private ended(machine: Machine, end: LinkEnd): void {
    machine.link = undefined;
    if (end.kind === "refused") {
      machine.token = undefined;
      void this.options.forgetToken(machine.host.id);
      this.set(machine, { status: "refused", detail: `${machine.host.name} no longer accepts this phone: its access was revoked, or it ran out unused. Open it to pair again.` });
      return;
    }
    if (end.kind === "certificate") {
      this.set(machine, { status: "refused", detail: end.refusal.reason === "certificate-mismatch" ? `${machine.host.name} answered with another key than the one this phone pinned.` : `${machine.host.name} showed a certificate this phone does not trust.` });
    }
    // A link that closed after its visit leaves the machine as it was.
  }

  private set(machine: Machine, patch: Partial<Pick<Machine, "status" | "detail" | "lastSeenAt">>): void {
    if (patch.status === "connected") delete machine.detail;
    Object.assign(machine, patch);
    this.publish();
  }

  private readKept(id: string): Kept | undefined {
    try {
      const raw = hostStorage(this.options.storage, id).get(CACHE_KEY);
      const kept = raw ? JSON.parse(raw) as Kept : undefined;
      return kept && Array.isArray(kept.running) ? kept : undefined;
    } catch {
      return undefined;
    }
  }

  private keep(machine: Machine): void {
    const kept: Kept = {
      ...(machine.status === "connected" || machine.status === "offline" ? { status: machine.status } : {}),
      ...(machine.status === "offline" && machine.detail ? { detail: machine.detail } : {}),
      ...(machine.index ? { index: machine.index } : {}),
      running: [...machine.running],
      ...(machine.index && machine.lastSeq !== undefined ? { lastSeq: machine.lastSeq } : {}),
      ...(machine.lastSeenAt !== undefined ? { lastSeenAt: machine.lastSeenAt } : {}),
      threadCount: machine.threadCount,
    };
    try { hostStorage(this.options.storage, machine.host.id).set(CACHE_KEY, JSON.stringify(kept)); } catch { /* kept for this run */ }
  }

  /** What the phone settled of a host's threads while it showed that host. */
  private settledOn(id: string): ReadonlySet<string> {
    try {
      const raw = hostStorage(this.options.storage, id).get(STORAGE_KEYS.preferences);
      const list = raw ? (JSON.parse(raw) as { settledThreadIds?: unknown }).settledThreadIds : undefined;
      return new Set(Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : []);
    } catch {
      return new Set();
    }
  }

  private entry(machine: Machine): UiEnvironment {
    const settled = this.settledOn(machine.host.id);
    const threads = machine.index
      ? environmentThreads(machine.index, machine.running).map((thread) => settled.has(thread.id) ? Object.assign(thread, { settled: true }) : thread)
      : [];
    return {
      id: machine.host.id,
      name: machine.host.name,
      local: false,
      status: machine.status,
      ...(machine.detail ? { detail: machine.detail } : {}),
      ...(machine.lastSeenAt !== undefined ? { lastSeenAt: machine.lastSeenAt } : {}),
      ...(machine.readOnly ? { readOnly: true } : {}),
      ...(machine.update ? { update: machine.update } : {}),
      threads,
      threadCount: machine.threadCount,
      projects: machine.index ? environmentProjects(machine.index) : [],
    };
  }

  private publish(): void {
    const { shown } = this.options;
    const status = shownStatus(this.shownState);
    const own: UiEnvironment = {
      id: shown.id,
      name: shown.name,
      local: false,
      status,
      ...(status === "offline" && this.shownLostAt !== undefined ? { lastSeenAt: this.shownLostAt } : {}),
      ...(shown.access === "read-only" ? { readOnly: true } : {}),
      ...(this.shownUpdate ? { update: this.shownUpdate } : {}),
      // The workbench lists the shown host's threads itself.
      threads: [],
      threadCount: 0,
      projects: [],
    };
    const others = [...this.machines.values()].map((machine) => this.entry(machine)).sort((a, b) => a.name.localeCompare(b.name));
    this.snapshot = { shown: shown.id, environments: [own, ...others], secureStorage: true };
    for (const listener of [...this.listeners]) listener();
  }

  private resolve(machine: string): Machine | undefined {
    const byId = this.machines.get(machine);
    if (byId) return byId;
    const named = [...this.machines.values()].filter((entry) => entry.host.name.toLowerCase() === machine.toLowerCase());
    return named.length === 1 ? named[0] : undefined;
  }

  // ---- PlatformEnvironments

  async open(id: string, target?: EnvironmentOpenTarget): Promise<void> {
    await this.load();
    if (id === this.options.shown.id) return;
    const machine = this.machines.get(id);
    if (!machine) throw new Error("This phone has not paired with that machine.");
    if (target && "threadId" in target) {
      this.options.navigate({ view: "workbench", hostId: id, threadId: target.threadId });
      return;
    }
    if (target && "thread" in target) {
      const known = machine.index?.sessions.find((session) => session.path === target.thread.path);
      if (known) { this.options.navigate({ view: "workbench", hostId: id, threadId: known.id }); return; }
    }
    if (target) this.options.storage.set(ARRIVAL_KEY, JSON.stringify({ machine: id, target }));
    this.options.navigate({ view: "workbench", hostId: id });
  }

  takeArrival = async (): Promise<EnvironmentTarget | undefined> => {
    const raw = this.options.storage.get(ARRIVAL_KEY);
    if (!raw) return undefined;
    this.options.storage.remove(ARRIVAL_KEY);
    try {
      const { machine, target } = JSON.parse(raw) as { machine?: string; target?: EnvironmentTarget };
      return machine === this.options.shown.id ? target : undefined;
    } catch {
      return undefined;
    }
  };

  async retry(id: string): Promise<void> {
    await this.load();
    const machine = this.machines.get(id);
    if (!machine) return;
    if (machine.status !== "connected") this.set(machine, { status: "connecting" });
    await this.read(machine);
  }

  async readExtension(machine: string, extensionId: string, command: string, input?: unknown): Promise<unknown> {
    await this.load();
    const found = this.resolve(machine);
    if (!found) throw new Error("This phone has not paired with that machine.");
    if (!found.token) throw new Error(`${found.host.name} no longer accepts this phone.`);
    const link = this.linkOf(found);
    if (!await this.onlyReads(found, link, extensionId, command)) {
      throw new Error(`${found.host.name} has no command ${extensionId}/${command} that only reads.`);
    }
    return link.call("host-extension", [extensionId, command, input]);
  }

  /** The phone's key could change things there, so only a command that host lists as `access: "read"` runs. */
  private async onlyReads(machine: Machine, link: MachineLink, extensionId: string, command: string): Promise<boolean> {
    const key = `${extensionId}\n${command}`;
    const cached = machine.readCommands;
    if (cached && (await cached.commands.catch(() => new Set<string>())).has(key)) return true;
    if (cached && this.now() - cached.at < READ_COMMANDS_RETRY_MS) return false;
    const commands = link.call<HostExtensionSummary[]>("host-extensions")
      .then((list) => new Set(list.flatMap((summary) => (summary.readCommands ?? []).map((name) => `${summary.id}\n${name}`))));
    machine.readCommands = { at: this.now(), commands };
    return (await commands).has(key);
  }

  async rename(id: string, name: string): Promise<void> {
    await this.options.rename(id, name);
    const machine = this.machines.get(id);
    if (machine) { machine.host = { ...machine.host, name }; this.publish(); }
  }

  async remove(id: string): Promise<void> {
    this.machines.get(id)?.link?.close();
    this.machines.delete(id);
    await this.options.remove(id);
    if (id === this.options.shown.id) this.options.navigate({ view: "hosts", explicit: true });
    else this.publish();
  }

  // The phone pairs from its host list, not from inside a workbench.
  pair = async () => ({ state: "failed" as const, message: "Add a machine from the phone's host list: More → Hosts." });
  cancelPairing = async () => undefined;
  discover = async () => ({ hosts: [], serviceType: "" });
  setPreferences = async () => undefined;
  showLocal = async () => { this.options.navigate({ view: "hosts", explicit: true }); };
}
