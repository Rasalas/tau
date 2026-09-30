import type { HostClient } from "../../src/workbench/host-client";
import type { HostEvent } from "../../src/shared/contracts";
import type { UsageLimitAccount, UsageLimitsSummary } from "../../kits/usage/protocol";
import { groupAccounts } from "../../kits/usage/accounts";

export interface MobileActivity {
  version: 1;
  hostId: string;
  threadId: string;
  title: string;
  state: "running" | "completed" | "needs-input";
  updatedAt: number;
  expiresAt: number;
}
export interface WidgetAccount { poolKey?: string; label: string; windows: Array<{ label: string; usedPercent: number; resetsAt?: number }>; checkedAt: number }
export interface ActivityToken { hostId: string; threadId: string; token: string; topic: string }
export interface ActivityPort {
  tokens?(listener: (token: ActivityToken) => void): Promise<() => void>;
  update(activity: MobileActivity): Promise<void>;
  usage(snapshot: { hostId: string; accounts: WidgetAccount[]; updatedAt: number; expiresAt: number }): Promise<void>;
  clear(hostId: string): Promise<void>;
}

/** Keep account identity inside the app. Widgets receive display fields only, never tokens or account ids. */
export function widgetAccounts(accounts: readonly UsageLimitAccount[], now: number): WidgetAccount[] {
  return groupAccounts(accounts.filter((account) => !account.unavailable && account.windows.length > 0 && Number.isFinite(account.checkedAt) && now - account.checkedAt < 15 * 60_000 && account.checkedAt <= now + 60_000)).map((group) => ({
    ...(group.shown.identity ? { poolKey: `${group.shown.identity.provider}:${group.shown.identity.key}` } : {}),
    label: group.label.slice(0, 100), checkedAt: group.shown.checkedAt,
    windows: group.shown.windows.filter((window) => Number.isFinite(window.usedPercent)).map((window) => ({ label: window.label.slice(0, 50), usedPercent: Math.max(0, Math.min(100, window.usedPercent)), ...(Number.isFinite(window.resetsAt) ? { resetsAt: window.resetsAt } : {}) })),
  }));
}

/** Each host has its own source, lifetime and cleanup. Serialized writes cannot resurrect a revoked host. */
export function followActivities(hostId: string, client: Pick<HostClient, "onHostEvent" | "bootstrap" | "invokeHostExtension">, port: ActivityPort, now = Date.now): { stop(): void; revoke(): Promise<void> } {
  const titles = new Map<string, string>();
  const states = new Map<string, MobileActivity["state"]>();
  let active = true;
  let writes = Promise.resolve();
  const enqueue = (write: () => Promise<void>) => { writes = writes.then(async () => { if (active) await write(); }).catch(() => undefined); };
  const publish = (threadId: string, state: MobileActivity["state"]) => {
    states.set(threadId, state);
    const at = now();
    enqueue(() => port.update({ version: 1, hostId, threadId, title: titles.get(threadId) ?? "Agent work", state, updatedAt: at, expiresAt: at + (state === "running" ? 8 * 60 * 60_000 : 15 * 60_000) }));
  };
  const event = (update: HostEvent) => {
    if (update.type === "thread-index") { for (const session of update.threadIndex.sessions) titles.set(session.id, session.title); }
    else if (update.type === "agent-status") publish(update.sessionId, update.running ? "running" : states.get(update.sessionId) === "needs-input" ? "needs-input" : "completed");
    else if (update.type === "extension-ui-prompt") publish(update.sessionId, "needs-input");
    else if (update.type === "extension-ui-resolved" && states.has(update.sessionId)) publish(update.sessionId, "running");
    else if (update.type === "error" && update.sessionId) publish(update.sessionId, "needs-input");
  };
  const off = client.onHostEvent(event);
  let offTokens: (() => void) | undefined;
  void port.tokens?.((token) => {
    if (!active || token.hostId !== hostId) return;
    void client.invokeHostExtension("tau.push", "activity-register", token).catch(() => undefined);
  }).then((off) => { if (!active) off(); else offTokens = off; });
  void client.bootstrap().then((bootstrap) => { if (active) { for (const session of bootstrap.threadIndex.sessions) titles.set(session.id, session.title); for (const id of Object.keys(bootstrap.threadIndex.runs ?? {})) publish(id, "running"); } }).catch(() => undefined);
  async function refreshUsage() {
    try {
      const result = await client.invokeHostExtension("tau.usage", "limits") as UsageLimitsSummary;
      if (!active) return;
      const at = now();
      const accounts = widgetAccounts(result.accounts, at);
      enqueue(() => port.usage({ hostId, accounts, updatedAt: at, expiresAt: Math.min(at + 15 * 60_000, ...accounts.map((account) => account.checkedAt + 15 * 60_000)) }));
    } catch { /* Missing or refused kit leaves the last snapshot to expire. */ }
  }
  void refreshUsage();
  const timer = setInterval(() => { void refreshUsage(); }, 120_000);
  const stop = () => { active = false; off(); offTokens?.(); clearInterval(timer); };
  return { stop, revoke: async () => { stop(); await writes; await port.clear(hostId); } };
}
