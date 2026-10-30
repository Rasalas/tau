import type { HostExtensionClient } from "tau";
import type { MessageIndexStatus } from "./protocol.js";

export const unavailableIndex = (): MessageIndexStatus => ({ enabled: true, state: "unavailable", done: 0, total: 0, threads: 0, bytes: 0, revision: 0 });
export function messageIndexNotice(status: MessageIndexStatus): string | undefined {
  if (status.state === "ready") return undefined;
  if (!status.enabled) return "Searching recent message text only. Turn on the message index in Settings → Threads.";
  if (status.state === "indexing") return `Indexing messages · ${status.done} of ${status.total} threads. Some results may be missing.`;
  return "Message index unavailable. Searching recent message text only.";
}
export function indexStatusText(status: MessageIndexStatus): string {
  if (status.state === "indexing") return `Indexing · ${status.done} of ${status.total} threads`;
  if (status.state === "error") return `Couldn't build the index: ${status.error ?? "Unknown error"}`;
  if (!status.enabled) return "Message index off";
  if (status.state === "unavailable") return status.error ? `Couldn't build the index: ${status.error}` : "Message index unavailable. Searching recent message text only.";
  return `Up to date · ${status.threads} threads · ${Math.round(status.bytes / 1_000_000)} MB`;
}
function isStatus(raw: unknown): raw is MessageIndexStatus {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as MessageIndexStatus;
  return typeof value.enabled === "boolean" && ["ready", "indexing", "disabled", "error", "unavailable"].includes(value.state)
    && [value.done, value.total, value.bytes, value.threads, value.revision].every(number => Number.isFinite(number) && number >= 0);
}

/** Shared by Settings and palette sources. Progress announcements are coalesced to 5 s. */
export class MessageIndexFeed {
  private value = unavailableIndex();
  private listeners = new Set<() => void>();
  private statusListeners = new Set<() => void>();
  private announced = this.value;
  private announcedAt = Number.NEGATIVE_INFINITY;
  private timer?: ReturnType<typeof setTimeout>;
  private request = 0;
  private disposed = false;
  private retired = new Set<string>();
  loaded = false;
  private readonly drop: () => void;
  constructor(private readonly host: HostExtensionClient) {
    this.drop = host.onEvent("index-status", raw => { this.request++; this.accept(raw); });
  }
  snapshot = (): MessageIndexStatus => this.value;
  notice = (): string | undefined => messageIndexNotice(this.announced);
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  subscribeStatus = (listener: () => void): (() => void) => { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener); }; };
  accept(raw: unknown): void {
    if (this.disposed || !isStatus(raw)) return;
    if (raw.activation && this.retired.has(raw.activation)) return;
    if (this.loaded && raw.activation === this.value.activation && raw.revision < this.value.revision) return;
    if (this.loaded && raw.activation && raw.activation !== this.value.activation && this.value.activation) this.retired.add(this.value.activation);
    this.loaded = true;
    this.value = raw;
    this.listeners.forEach(listener => listener());
    const announce = () => {
      this.timer = undefined;
      if (this.disposed) return;
      this.announced = this.value;
      this.announcedAt = Date.now();
      this.statusListeners.forEach(listener => listener());
    };
    const remaining = 5_000 - (Date.now() - this.announcedAt);
    if (remaining <= 0) { if (this.timer) clearTimeout(this.timer); announce(); }
    else this.timer ??= setTimeout(announce, remaining);
  }
  async load(): Promise<void> {
    const request = ++this.request;
    try {
      const answer = await this.host.invoke("index-status", {});
      if (request === this.request) {
        if (isStatus(answer)) this.accept(answer);
        else this.unavailable();
      }
    } catch { if (request === this.request) this.unavailable(); }
  }
  unavailable(): void {
    if (this.disposed) return;
    this.accept({ ...unavailableIndex(), activation: this.value.activation, revision: this.value.revision });
  }
  async configure(enabled: boolean): Promise<void> { this.accept(await this.host.invoke("index-configure", { enabled })); }
  async rebuild(): Promise<void> { this.accept(await this.host.invoke("index-rebuild", {})); }
  dispose(): void { this.disposed = true; this.drop(); if (this.timer) clearTimeout(this.timer); this.listeners.clear(); this.statusListeners.clear(); }
}
