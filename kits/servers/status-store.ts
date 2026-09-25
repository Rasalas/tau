import { errorMessage, type HostExtensionClient } from "tau";
import { SERVERS_STATUS_EVENT, SERVERS_STATUS_TOPIC, decodeServersStatus, type ServersStatus, type ServersStatusEvent } from "./view-protocol.js";

export interface StatusEntry {
  status?: ServersStatus;
  error?: string;
  loading: boolean;
}

const EMPTY: StatusEntry = { loading: false };
// Several reasons to look again within this window become one ask.
const REFRESH_DELAY = 600;

/**
 * The desktop's copy of each project's server status, keyed by the path the
 * client asked with. It watches the host's status topic only while some view
 * is subscribed, and asks the host again when a turn ends or files change.
 */
export class ServersStatusStore {
  private readonly entries = new Map<string, StatusEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private unwatch: (() => void) | undefined;
  private unlisten: (() => void) | undefined;
  private unfocus: (() => void) | undefined;
  /** The last status the host published per workspace, and when in this store's order of things. */
  private readonly published = new Map<string, { status: ServersStatus; at: number }>();
  private clock = 0;

  constructor(private readonly host: HostExtensionClient) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.unwatch = this.host.watch?.(SERVERS_STATUS_TOPIC);
      this.unlisten = this.host.onEvent(SERVERS_STATUS_EVENT, (payload) => this.receive(payload));
      // Files edited in another program: look again when the user comes back to the window.
      const onFocus = () => this.refreshLoaded();
      globalThis.addEventListener?.("focus", onFocus);
      this.unfocus = () => globalThis.removeEventListener?.("focus", onFocus);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.unwatch?.();
        this.unlisten?.();
        this.unfocus?.();
        this.unwatch = undefined;
        this.unlisten = undefined;
        this.unfocus = undefined;
      }
    };
  };

  get(cwd: string | undefined): StatusEntry {
    return (cwd && this.entries.get(cwd)) || EMPTY;
  }

  /**
   * The label of a target the thread deployed to without a commit since, from
   * statuses already loaded: a rail row never makes the host read a project.
   */
  deployedUncommitted(projectPath: string, threadId: string): string | undefined {
    for (const [cwd, entry] of this.entries) {
      if (cwd !== projectPath && entry.status?.workspace !== projectPath) continue;
      const target = entry.status?.targets.find((candidate) => candidate.uncommittedThreads.includes(threadId));
      if (target) return target.label;
    }
    return undefined;
  }

  private set(cwd: string, entry: StatusEntry): void {
    this.entries.set(cwd, entry);
    for (const listener of [...this.listeners]) listener();
  }

  private receive(payload: unknown): void {
    const event = payload as Partial<ServersStatusEvent> | undefined;
    const status = decodeServersStatus(event?.status);
    if (!status) return;
    this.published.set(status.workspace, { status, at: ++this.clock });
    for (const [cwd, entry] of this.entries) {
      if (cwd === status.workspace || entry.status?.workspace === status.workspace) this.set(cwd, { ...entry, status, loading: false });
    }
  }

  /** Loads a project's status once; later asks come from the refresh triggers. */
  ensure(cwd: string | undefined): void {
    if (!cwd || this.entries.has(cwd)) return;
    this.load(cwd, false);
  }

  load(cwd: string, fresh: boolean): Promise<void> {
    const current = this.entries.get(cwd) ?? EMPTY;
    this.set(cwd, { ...current, loading: true });
    const asked = ++this.clock;
    return this.host.invoke("status", { cwd, ...(fresh ? { fresh: true } : {}) }).then(
      (value) => {
        const answered = decodeServersStatus(value);
        // The client may name the project another way than the host: an event that came in meanwhile is newer.
        const newer = answered && this.published.get(answered.workspace);
        const status = newer && newer.at > asked ? newer.status : answered;
        this.set(cwd, status ? { status, loading: false } : { ...current, error: "The host answered no status.", loading: false });
      },
      (failure: unknown) => this.set(cwd, { ...current, error: errorMessage(failure), loading: false }),
    );
  }

  /** A fresh look at the local side of every project a view shows, soon. */
  refreshLoaded(only?: string): void {
    for (const cwd of this.entries.keys()) {
      if (only && cwd !== only) continue;
      clearTimeout(this.timers.get(cwd));
      this.timers.set(cwd, setTimeout(() => { this.timers.delete(cwd); if (this.listeners.size > 0) void this.load(cwd, true); }, REFRESH_DELAY));
    }
  }

  /** Reaches the server; the status comes back through the answer and the topic. */
  async check(cwd: string, targetId: string): Promise<void> {
    const value = await this.host.invoke("check", { cwd, targetId });
    const status = decodeServersStatus(value);
    if (status) this.set(cwd, { status, loading: false });
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.unwatch?.();
    this.unlisten?.();
    this.unfocus?.();
    this.listeners.clear();
  }
}
