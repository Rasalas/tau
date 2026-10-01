import type { HostClient } from "../../src/workbench/host-client";
import type { UsageLimitsSummary } from "../../kits/usage/protocol";
import { ThreadBoard, widgetSnapshot, widgetUsage, type WidgetAccount, type WidgetSnapshot } from "./widgets";

export interface ActivityToken { hostId: string; threadId: string; token: string; topic: string; relay?: { handle: string; keyId: string; key: string } }
export interface ActivityPort {
  /** iOS: the Live Activity's push tokens. */
  tokens?(listener: (token: ActivityToken) => void): Promise<() => void>;
  /** The host's one snapshot for the widgets, the Live Activity (iOS) and the ongoing notification (Android). */
  snapshot(value: WidgetSnapshot): Promise<void>;
  clear(hostId: string): Promise<void>;
}

/** The snapshot is written this long after the last change, so a burst of events is one write. */
export const SNAPSHOT_DEBOUNCE_MS = 500;

/** Each host has its own source, lifetime and cleanup. Serialized writes cannot resurrect a revoked host. */
export function followActivities(hostId: string, client: Pick<HostClient, "onHostEvent" | "bootstrap" | "invokeHostExtension">, port: ActivityPort, now = Date.now, machine = ""): { stop(): void; revoke(): Promise<void> } {
  const board = new ThreadBoard(now);
  let accounts: WidgetAccount[] | undefined;
  let active = true;
  let writes = Promise.resolve();
  let pending: ReturnType<typeof setTimeout> | undefined;
  const enqueue = (write: () => Promise<void>) => { writes = writes.then(async () => { if (active) await write(); }).catch(() => undefined); };
  const write = () => {
    clearTimeout(pending); pending = undefined;
    const value = widgetSnapshot(hostId, machine, now(), accounts, board.threads());
    enqueue(() => port.snapshot(value));
  };
  const changed = () => { if (!pending) pending = setTimeout(write, SNAPSHOT_DEBOUNCE_MS); };
  const off = client.onHostEvent((update) => { if (board.apply(update)) changed(); });
  void client.invokeHostExtension("tau.push", "activity-enable").catch(() => undefined);
  let offTokens: (() => void) | undefined;
  void port.tokens?.((token) => {
    if (!active || token.hostId !== hostId) return;
    void client.invokeHostExtension("tau.push", "activity-register", { hostId: token.hostId, threadId: token.threadId, topic: token.topic, ...(token.relay ? { relay: token.relay } : { token: token.token }) }).catch(() => undefined);
  }).then((release) => { if (!active) release(); else offTokens = release; });
  void client.bootstrap().then((bootstrap) => {
    if (!active) return;
    board.index(bootstrap.threadIndex);
    changed();
  }).catch(() => undefined);
  async function refreshUsage() {
    try {
      const result = await client.invokeHostExtension("tau.usage", "limits") as UsageLimitsSummary;
      if (!active) return;
      accounts = widgetUsage(result, now());
      changed();
    } catch { /* Missing or refused kit leaves the last accounts, which the widget fades. */ }
  }
  void refreshUsage();
  // The same beat keeps the Live Activity from reading as stale while the app follows the host.
  const timer = setInterval(() => { void refreshUsage(); write(); }, 120_000);
  const stop = () => { active = false; off(); offTokens?.(); clearInterval(timer); clearTimeout(pending); };
  return { stop, revoke: async () => { stop(); await writes; await port.clear(hostId); } };
}
