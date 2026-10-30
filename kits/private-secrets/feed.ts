import { errorMessage, type HostExtensionClient } from "tau";
import type { SecretFilesState } from "./protocol.js";

export class SecretFilesFeed {
  private value: { state?: SecretFilesState; error?: string } = {};
  private listeners = new Set<() => void>();
  private stop?: () => void;
  private revision = 0;
  constructor(readonly host: HostExtensionClient) {}
  get = () => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.stop = this.host.onEvent("changed", () => { void this.read(); });
      void this.read();
    }
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { this.stop?.(); this.stop = undefined; this.revision++; } };
  };
  read = async (): Promise<void> => {
    const revision = ++this.revision;
    try {
      const state = await this.host.invoke("state") as SecretFilesState;
      if (revision !== this.revision) return;
      this.value = { state };
    } catch (error) {
      if (revision !== this.revision) return;
      this.value = { ...this.value, error: errorMessage(error) };
    }
    for (const listener of this.listeners) listener();
  };
  async invoke(command: string, input: unknown): Promise<void> { await this.host.invoke(command, input); await this.read(); }
}
