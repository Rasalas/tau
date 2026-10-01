import type { HostClient } from "../../src/workbench/host-client";
import type { HostEvent } from "../../src/shared/contracts";
import type { UsageLimitsSummary } from "../../kits/usage/protocol";
import { ThreadBoard, usageSnapshot, type ThreadsSnapshot, type UsageSnapshot } from "./widgets";

export interface MobileActivity {
  version: 1;
  hostId: string;
  threadId: string;
  title: string;
  state: "running" | "completed" | "needs-input";
  updatedAt: number;
  expiresAt: number;
}
export interface ActivityToken { hostId: string; threadId: string; token: string; topic: string; relay?: { handle: string; keyId: string; key: string } }
export interface ActivityPort {
  tokens?(listener: (token: ActivityToken) => void): Promise<() => void>;
  /** One card per thread (Android). */
  update?(activity: MobileActivity): Promise<void>;
  /** The Threads widget and the one Live Activity for all of a host's threads (iOS). */
  threads?(snapshot: ThreadsSnapshot): Promise<void>;
  usage(snapshot: UsageSnapshot): Promise<void>;
  clear(hostId: string): Promise<void>;
}

/** Threads are written this long after the last change, so a burst of events is one write. */
const THREADS_DEBOUNCE_MS = 400;

/** Each host has its own source, lifetime and cleanup. Serialized writes cannot resurrect a revoked host. */
export function followActivities(hostId: string, client: Pick<HostClient, "onHostEvent" | "bootstrap" | "invokeHostExtension">, port: ActivityPort, now = Date.now, machine = ""): { stop(): void; revoke(): Promise<void> } {
  const titles = new Map<string, string>();
  const board = new ThreadBoard(now);
  const states = new Map<string, MobileActivity["state"]>();
  let active = true;
  let writes = Promise.resolve();
  const enqueue = (write: () => Promise<void>) => { writes = writes.then(async () => { if (active) await write(); }).catch(() => undefined); };
  const publish = (threadId: string, state: MobileActivity["state"]) => {
    states.set(threadId, state);
    const at = now();
    if (port.update) enqueue(() => port.update!({ version: 1, hostId, threadId, title: titles.get(threadId) ?? "Agent work", state, updatedAt: at, expiresAt: at + (state === "running" ? 8 * 60 * 60_000 : 15 * 60_000) }));
  };
  let threadsTimer: ReturnType<typeof setTimeout> | undefined;
  const writeThreads = () => {
    clearTimeout(threadsTimer); threadsTimer = undefined;
    if (!port.threads) return;
    const snapshot: ThreadsSnapshot = { version: 1, hostId, machine: machine.slice(0, 60), updatedAt: now(), threads: board.threads() };
    enqueue(() => port.threads!(snapshot));
  };
  const threadsChanged = () => { if (port.threads && !threadsTimer) threadsTimer = setTimeout(writeThreads, THREADS_DEBOUNCE_MS); };
  const event = (update: HostEvent) => {
    if (board.apply(update)) threadsChanged();
    if (update.type === "thread-index") { for (const session of update.threadIndex.sessions) titles.set(session.id, session.title); }
    else if (update.type === "agent-status") publish(update.sessionId, update.running ? "running" : states.get(update.sessionId) === "needs-input" ? "needs-input" : "completed");
    else if (update.type === "extension-ui-prompt") publish(update.sessionId, "needs-input");
    else if (update.type === "extension-ui-resolved" && states.has(update.sessionId)) publish(update.sessionId, "running");
    else if (update.type === "error" && update.sessionId) publish(update.sessionId, "needs-input");
  };
  const off = client.onHostEvent(event);
  void client.invokeHostExtension("tau.push", "activity-enable").catch(() => undefined);
  let offTokens: (() => void) | undefined;
  void port.tokens?.((token) => {
    if (!active || token.hostId !== hostId) return;
    void client.invokeHostExtension("tau.push", "activity-register", { hostId: token.hostId, threadId: token.threadId, topic: token.topic, ...(token.relay ? { relay: token.relay } : { token: token.token }) }).catch(() => undefined);
  }).then((release) => { if (!active) release(); else offTokens = release; });
  void client.bootstrap().then((bootstrap) => {
    if (!active) return;
    for (const session of bootstrap.threadIndex.sessions) titles.set(session.id, session.title);
    for (const id of Object.keys(bootstrap.threadIndex.runs ?? {})) publish(id, "running");
    board.index(bootstrap.threadIndex);
    threadsChanged();
  }).catch(() => undefined);
  async function refreshUsage() {
    try {
      const result = await client.invokeHostExtension("tau.usage", "limits") as UsageLimitsSummary;
      if (!active) return;
      const snapshot = usageSnapshot(hostId, machine, result, now());
      enqueue(() => port.usage(snapshot));
    } catch { /* Missing or refused kit leaves the last snapshot, which the widget fades. */ }
  }
  void refreshUsage();
  // The same beat keeps the Live Activity from reading as stale while the app follows the host.
  const timer = setInterval(() => { void refreshUsage(); writeThreads(); }, 120_000);
  const stop = () => { active = false; off(); offTokens?.(); clearInterval(timer); clearTimeout(threadsTimer); };
  return { stop, revoke: async () => { stop(); await writes; await port.clear(hostId); } };
}
