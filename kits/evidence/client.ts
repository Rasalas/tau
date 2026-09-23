import type { HostExtensionClient } from "tau";
import type { EvidenceThread } from "./protocol.js";

const IMAGE_CACHE = 240;

/**
 * The desktop's view of the host's frames: one thread's list at a time as
 * the transcript asks, and the pictures themselves, cached a few hundred.
 */
export class EvidenceClient {
  private readonly threads = new Map<string, EvidenceThread>();

  private readonly loading = new Map<string, Promise<EvidenceThread | undefined>>();

  private readonly images = new Map<string, Promise<string | null>>();

  private readonly listeners = new Set<() => void>();

  private readonly changes = new Set<(threadId: string) => void>();

  private pausedThreads: Record<string, string> = {};

  private version = 0;

  constructor(private readonly host: HostExtensionClient) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): number => this.version;

  private emit(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  thread(threadId: string): EvidenceThread | undefined {
    return this.threads.get(threadId);
  }

  paused(): Record<string, string> {
    return this.pausedThreads;
  }

  setPaused(paused: Record<string, string>): void {
    this.pausedThreads = paused;
    this.emit();
  }

  load(threadId: string): Promise<EvidenceThread | undefined> {
    const pending = this.loading.get(threadId);
    if (pending) return pending;
    const request = (this.host.invoke("list", { threadId }) as Promise<EvidenceThread>)
      .then((thread) => {
        this.threads.set(threadId, thread);
        this.emit();
        return thread;
      }, () => undefined)
      .finally(() => { this.loading.delete(threadId); });
    this.loading.set(threadId, request);
    return request;
  }

  /** The host said a thread's frames changed: read it again if anyone looked at it. */
  changed(threadId: string): void {
    if (this.threads.has(threadId)) void this.load(threadId);
    for (const listener of [...this.changes]) listener(threadId);
  }

  onChanged(listener: (threadId: string) => void): () => void {
    this.changes.add(listener);
    return () => { this.changes.delete(listener); };
  }

  image(threadId: string, id: string, thumb = false): Promise<string | null> {
    const key = `${threadId}\n${id}\n${thumb ? "t" : "f"}`;
    const cached = this.images.get(key);
    if (cached) {
      this.images.delete(key);
      this.images.set(key, cached);
      return cached;
    }
    const request = (this.host.invoke("image", { threadId, id, thumb }) as Promise<string | null>).catch(() => null);
    this.images.set(key, request);
    while (this.images.size > IMAGE_CACHE) this.images.delete(this.images.keys().next().value!);
    return request;
  }

  async deleteTurn(threadId: string, turnId: string): Promise<void> {
    await this.host.invoke("delete-turn", { threadId, turnId });
    await this.load(threadId);
  }

  forget(threadId: string): void {
    this.threads.delete(threadId);
  }
}
