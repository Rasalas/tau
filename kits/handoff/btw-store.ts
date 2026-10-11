import type { BtwChat, BtwGone } from "./protocol.js";

/** The side questions this window knows, by id; a tab draws one and follows its changes. */
export class BtwStore {
  private chats = new Map<string, BtwChat>();
  private gone = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Changes whenever any question does; `useSyncExternalStore` reads it. */
  getVersion = (): number => this.version;

  chat(id: string): BtwChat | undefined {
    return this.chats.get(id);
  }

  isGone(id: string): boolean {
    return this.gone.has(id);
  }

  /** A question the host pushed or answered; a closed one is remembered as gone. */
  apply(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const value = payload as Partial<BtwChat> & Partial<BtwGone>;
    if (typeof value.id !== "string") return;
    if (value.gone === true) {
      this.chats.delete(value.id);
      this.gone.add(value.id);
    } else if (typeof value.question === "string" && typeof value.threadId === "string") {
      this.gone.delete(value.id);
      this.chats.set(value.id, value as BtwChat);
    } else return;
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }

  markGone(id: string): void {
    this.apply({ id, gone: true });
  }

  clear(): void {
    this.chats.clear();
    this.gone.clear();
    this.listeners.clear();
  }
}
