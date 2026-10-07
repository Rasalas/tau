import { errorMessage, type HostExtensionClient } from "tau";
import type { ManagementState, SchedulingState, SecretRequest } from "./protocol.js";

export class SchedulingFeed {
  private value: { state?: ManagementState; error?: string } = {};
  private readonly listeners = new Set<() => void>();
  private stops: (() => void)[] = [];
  private revision = 0;
  constructor(readonly host: HostExtensionClient) {}
  get = () => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.stops = [
        this.host.onEvent("state", (payload) => this.merge(payload as SchedulingState)),
        this.host.onEvent("secret-requests", (payload) => this.merge({ secretRequests: payload as SecretRequest[] })),
        this.host.onEvent("webhook-endpoint", (payload) => this.merge({ webhookUrl: (payload as { url?: string }).url, webhookProblem: (payload as { problem?: string }).problem })),
      ];
      void this.read();
    }
    return () => { this.listeners.delete(listener); if (!this.listeners.size) for (const stop of this.stops.splice(0)) stop(); };
  };
  private publish(): void { for (const listener of this.listeners) listener(); }
  private merge(state: Partial<ManagementState>): void {
    this.revision++;
    if (!this.value.state) { void this.read(); return; }
    this.value = { state: { ...this.value.state, ...state } };
    this.publish();
  }
  async read(): Promise<void> {
    const revision = this.revision;
    try {
      const state = await this.host.invoke("manage") as ManagementState;
      if (revision !== this.revision) return;
      this.value = { state }; this.publish();
    } catch (error) { if (revision !== this.revision) return; this.value = { ...this.value, error: errorMessage(error) }; this.publish(); }
  }
  async invoke(command: string, input?: unknown): Promise<unknown> {
    const answer = await this.host.invoke(command, input);
    await this.read();
    return answer;
  }
}

export const needsDecision = (job: { status: string }) => ["held", "failed", "uncertain"].includes(job.status);
