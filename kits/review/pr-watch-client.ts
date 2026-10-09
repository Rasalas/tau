import { errorMessage, type HostExtensionClient } from "tau";
import type { PullRequestWatch, WatchState } from "./pr-watch-protocol.js";
/** A host without the watch commands answers nothing; the rail and the strip read a list all the same. */
const listOf = (watches: unknown): PullRequestWatch[] => Array.isArray(watches) ? watches as PullRequestWatch[] : [];
export class PullRequestWatchFeed {
  private value: WatchState & { error?: string } = { watches: [], canManage: false };
  private listeners = new Set<() => void>();
  private stop?: () => void;
  private revision = 0;
  constructor(readonly host: HostExtensionClient) {}
  get = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) { this.stop = this.host.onEvent("pr-watches", (watches) => { this.revision++; this.value = { ...this.value, watches: listOf(watches) }; this.publish(); }); void this.read(); }
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { this.stop?.(); this.stop = undefined; } };
  };
  private publish() { for (const listener of this.listeners) listener(); }
  async read() { const revision = this.revision; try { const value = await this.host.invoke("watch-list") as WatchState | undefined; this.value = { ...value, watches: revision === this.revision ? listOf(value?.watches) : this.value.watches }; this.publish(); } catch (error) { this.value = { ...this.value, error: errorMessage(error) }; this.publish(); } }
  async change(command: "watch-start" | "watch-stop", threadId: string, url: string) { await this.host.invoke(command, { threadId, url }); await this.read(); }
}
