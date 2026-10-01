import type { HostClient } from "../../src/workbench/host-client";
import type { HostEvent } from "../../src/shared/contracts";
import type { UsageLimitsSummary } from "../../kits/usage/protocol";
import { WIDGET_SNAPSHOT_VERSION, widgetAccounts, widgetThreads, type WidgetAccount, type WidgetSnapshot, type WidgetThread } from "./widget-snapshot";

export interface MobileActivity {
  version: 1;
  hostId: string;
  threadId: string;
  title: string;
  state: "running" | "completed" | "needs-input";
  updatedAt: number;
  expiresAt: number;
}
export { widgetAccounts, type WidgetAccount } from "./widget-snapshot";
export interface ActivityToken { hostId: string; threadId: string; token: string; topic: string; relay?: { handle: string; keyId: string; key: string } }
export interface ActivityPort {
  tokens?(listener: (token: ActivityToken) => void): Promise<() => void>;
  update(activity: MobileActivity): Promise<void>;
  usage(snapshot: { hostId: string; accounts: WidgetAccount[]; updatedAt: number; expiresAt: number }): Promise<void>;
  clear(hostId: string): Promise<void>;
  /** The host's widget snapshot, debounced; `usage` stays for the iOS widgets until they read this. */
  snapshot?(value: WidgetSnapshot): Promise<void>;
}

/** How long the app gathers changes before it hands the widgets a new snapshot. */
export const SNAPSHOT_DEBOUNCE_MS = 1_000;

export interface FollowOptions {
  now?: () => number;
  /** The host's name on this phone, for the widgets. */
  machine?: string;
}

/** Each host has its own source, lifetime and cleanup. Serialized writes cannot resurrect a revoked host. */
export function followActivities(hostId: string, client: Pick<HostClient, "onHostEvent" | "bootstrap" | "invokeHostExtension">, port: ActivityPort, { now = Date.now, machine = "" }: FollowOptions = {}): { stop(): void; revoke(): Promise<void> } {
  const titles = new Map<string, string>();
  const projects = new Map<string, string>();
  const states = new Map<string, MobileActivity["state"]>();
  const threads = new Map<string, WidgetThread>();
  const failed = new Set<string>();
  let accounts: WidgetAccount[] | undefined;
  let active = true;
  let writes = Promise.resolve();
  let pending: ReturnType<typeof setTimeout> | undefined;
  const enqueue = (write: () => Promise<void>) => { writes = writes.then(async () => { if (active) await write(); }).catch(() => undefined); };
  const snapshot = () => {
    if (!port.snapshot || pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      const at = now();
      const value: WidgetSnapshot = { version: WIDGET_SNAPSHOT_VERSION, hostId, machine, updatedAt: at, ...(accounts ? { accounts } : {}), threads: widgetThreads(threads.values(), at) };
      enqueue(() => port.snapshot!(value));
    }, SNAPSHOT_DEBOUNCE_MS);
  };
  const track = (threadId: string, state: WidgetThread["state"], since: number, detail?: string) => {
    const at = now();
    const kept = threads.get(threadId);
    const project = projects.get(threadId);
    threads.set(threadId, { id: threadId, title: titles.get(threadId) ?? kept?.title ?? "Agent work", ...(project ? { project } : {}), state, since: kept?.state === state ? kept.since : since, updatedAt: at, ...(detail ? { detail } : {}) });
    snapshot();
  };
  const publish = (threadId: string, state: MobileActivity["state"]) => {
    states.set(threadId, state);
    const at = now();
    enqueue(() => port.update({ version: 1, hostId, threadId, title: titles.get(threadId) ?? "Agent work", state, updatedAt: at, expiresAt: at + (state === "running" ? 8 * 60 * 60_000 : 15 * 60_000) }));
  };
  const index = (sessions: ReadonlyArray<{ id: string; title: string; projectName: string }>) => {
    for (const session of sessions) {
      titles.set(session.id, session.title);
      projects.set(session.id, session.projectName);
      const kept = threads.get(session.id);
      if (kept && (kept.title !== session.title || kept.project !== session.projectName)) threads.set(session.id, { ...kept, title: session.title, project: session.projectName });
    }
    snapshot();
  };
  const event = (update: HostEvent) => {
    if (update.type === "thread-index") index(update.threadIndex.sessions);
    else if (update.type === "agent-status") {
      const asking = states.get(update.sessionId) === "needs-input" && threads.get(update.sessionId)?.state === "question";
      publish(update.sessionId, update.running ? "running" : states.get(update.sessionId) === "needs-input" ? "needs-input" : "completed");
      if (update.running) { failed.delete(update.sessionId); track(update.sessionId, "running", update.startedAt ?? now()); }
      else if (!asking) track(update.sessionId, failed.has(update.sessionId) ? "failed" : "done", now());
    } else if (update.type === "extension-ui-prompt") {
      publish(update.sessionId, "needs-input");
      track(update.sessionId, "question", now(), update.prompt.title);
    } else if (update.type === "extension-ui-resolved" && states.has(update.sessionId)) {
      publish(update.sessionId, "running");
      track(update.sessionId, "running", now());
    } else if (update.type === "error" && update.sessionId) {
      publish(update.sessionId, "needs-input");
      failed.add(update.sessionId);
      const kept = threads.get(update.sessionId);
      if (kept && kept.state !== "running") track(update.sessionId, "failed", now());
    }
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
    index(bootstrap.threadIndex.sessions);
    const runs = bootstrap.threadIndex.runs ?? {};
    for (const [id, startedAt] of Object.entries(runs)) { publish(id, "running"); track(id, "running", startedAt); }
    // The latest finished threads, so the list is not empty right after the app opens.
    const at = now();
    for (const session of bootstrap.threadIndex.sessions) {
      if (runs[session.id] === undefined && !threads.has(session.id) && at - session.modifiedAt <= 3 * 60 * 60_000 && session.messageCount > 0) {
        threads.set(session.id, { id: session.id, title: session.title, project: session.projectName, state: session.turnError ? "failed" : "done", since: session.modifiedAt, updatedAt: at });
      }
    }
    snapshot();
  }).catch(() => undefined);
  async function refreshUsage() {
    try {
      const result = await client.invokeHostExtension("tau.usage", "limits") as UsageLimitsSummary;
      if (!active) return;
      const at = now();
      const fresh = widgetAccounts(result.accounts, at);
      accounts = widgetAccounts(result.accounts, at, true);
      enqueue(() => port.usage({ hostId, accounts: fresh, updatedAt: at, expiresAt: Math.min(at + 15 * 60_000, ...fresh.map((account) => account.checkedAt + 15 * 60_000)) }));
      snapshot();
    } catch { /* Missing or refused kit leaves the last snapshot to expire. */ }
  }
  void refreshUsage();
  const timer = setInterval(() => { void refreshUsage(); }, 120_000);
  const stop = () => { active = false; off(); offTokens?.(); clearInterval(timer); if (pending) clearTimeout(pending); pending = undefined; };
  return { stop, revoke: async () => { stop(); await writes; await port.clear(hostId); } };
}
