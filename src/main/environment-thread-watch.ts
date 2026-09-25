import type { HostPushEvent } from "../shared/host-transport.js";
import { hostPushScope } from "./host-push-scope.js";

/** A page renews its watch this often at most; one it stops renewing ends after this long. */
export const THREAD_WATCH_LEASE_MS = 60_000;
/** A streaming thread's changes reach the page at most this often. */
export const THREAD_WATCH_THROTTLE_MS = 300;

interface Watch {
  machine: string;
  sessionId: string;
  revision: number;
  asking?: { id: string; title: string };
  expiry?: unknown;
  flush?: unknown;
  lastFlush?: number;
}

export interface EnvironmentThreadWatchesOptions {
  /** The threads watched on a machine changed; its connection sends the new set. */
  resubscribe(machine: string): void;
  /** A watched thread changed; the page hears it after the machine's own state caught up. */
  publish(machine: string, sessionId: string): void;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

const key = (machine: string, sessionId: string) => `${machine}\n${sessionId}`;

/**
 * The threads of other machines a page looks in on (API 1.15.0). A watch is
 * a lease the page renews while its tab is open, so a page that reloads or
 * dies leaves nothing subscribed for long; while one lasts, the machine's
 * connection receives that thread's stream, and each change reaches the page
 * as a new revision, a few times a second at most.
 */
export class EnvironmentThreadWatches {
  private readonly watches = new Map<string, Watch>();
  private readonly statuses = new Map<string, string>();

  constructor(private readonly options: EnvironmentThreadWatchesOptions) {}

  /** Starts or renews a watch; true when it is new and the machine should subscribe. */
  watch(machine: string, sessionId: string): boolean {
    const id = key(machine, sessionId);
    const existing = this.watches.get(id);
    const watch = existing ?? { machine, sessionId, revision: 0 };
    this.clear(watch.expiry);
    watch.expiry = this.timer(() => this.unwatch(machine, sessionId), THREAD_WATCH_LEASE_MS);
    if (existing) return false;
    this.watches.set(id, watch);
    this.options.resubscribe(machine);
    return true;
  }

  unwatch(machine: string, sessionId: string): void {
    const watch = this.watches.get(key(machine, sessionId));
    if (!watch) return;
    this.clear(watch.expiry);
    this.clear(watch.flush);
    this.watches.delete(key(machine, sessionId));
    this.options.resubscribe(machine);
  }

  /** The sessions watched on a machine, for its subscription. */
  threads(machine: string): string[] {
    return [...this.watches.values()].filter((watch) => watch.machine === machine).map((watch) => watch.sessionId).sort();
  }

  get(machine: string, sessionId: string): Pick<Watch, "revision" | "asking"> | undefined {
    return this.watches.get(key(machine, sessionId));
  }

  /** A push the machine sent; what touches a watched thread moves its revision. */
  onPush(machine: string, event: unknown): void {
    if (!event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string") return;
    const push = event as HostPushEvent;
    if (push.type === "thread-index") {
      for (const watch of this.of(machine)) this.bump(watch);
      return;
    }
    if (push.type === "extension-ui-prompt") {
      const watch = this.watches.get(key(machine, push.sessionId));
      if (watch) this.bump(watch, { id: push.prompt.id, title: push.prompt.title });
      return;
    }
    if (push.type === "extension-ui-resolved") {
      const watch = this.watches.get(key(machine, push.sessionId));
      if (watch?.asking?.id === push.id) this.bump(watch, null);
      return;
    }
    const scope = push.type === "agent-status" ? `thread:${push.sessionId}` : threadShellScope(push) ?? hostPushScope(push);
    if (!scope?.startsWith("thread:")) return;
    const watch = this.watches.get(key(machine, scope.slice("thread:".length)));
    if (watch) this.bump(watch);
  }

  /** The machine's connection changed state; every watch there reads again, and a question seen before may be gone. */
  onStatus(machine: string, status: string): void {
    if (this.statuses.get(machine) === status) return;
    this.statuses.set(machine, status);
    for (const watch of this.of(machine)) this.bump(watch, status === "connected" ? undefined : null);
  }

  close(): void {
    for (const watch of this.watches.values()) {
      this.clear(watch.expiry);
      this.clear(watch.flush);
    }
    this.watches.clear();
  }

  private of(machine: string): Watch[] {
    return [...this.watches.values()].filter((watch) => watch.machine === machine);
  }

  /** `asking` null clears the question, undefined leaves it. */
  private bump(watch: Watch, asking?: Watch["asking"] | null): void {
    watch.revision += 1;
    if (asking === null) delete watch.asking;
    else if (asking) watch.asking = asking;
    if (watch.flush !== undefined) return;
    // Never at once: the machine's connection applies an index push after it handed it here.
    const wait = Math.max(0, (watch.lastFlush ?? -Infinity) + THREAD_WATCH_THROTTLE_MS - this.now());
    watch.flush = this.timer(() => {
      watch.flush = undefined;
      watch.lastFlush = this.now();
      if (this.watches.get(key(watch.machine, watch.sessionId)) === watch) this.options.publish(watch.machine, watch.sessionId);
    }, wait);
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private timer(callback: () => void, ms: number): unknown {
    if (this.options.setTimer) return this.options.setTimer(callback, ms);
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  }

  private clear(handle: unknown): void {
    if (handle === undefined) return;
    if (this.options.clearTimer) this.options.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

/** The index entry of one thread changed: its title, its message count, its cost. */
function threadShellScope(event: HostPushEvent): string | undefined {
  if (event.type !== "host-update" || event.update.type !== "thread-shell") return undefined;
  const sessionId = (event.update as { update?: { sessionId?: unknown } }).update?.sessionId;
  return typeof sessionId === "string" ? `thread:${sessionId}` : undefined;
}
