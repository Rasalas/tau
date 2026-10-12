import type { HostWakeSource } from "../shared/host-link.js";

/** Native lifecycle for every connection in this window process. */
class HostPowerState {
  private asleep = false;
  private readonly listeners = new Set<Parameters<HostWakeSource>[0]>();
  readonly subscribe: HostWakeSource = (listener) => {
    this.listeners.add(listener);
    if (this.asleep) listener("suspend");
    return () => { this.listeners.delete(listener); };
  };
  change(state: "suspend" | "resume"): void {
    this.asleep = state === "suspend";
    for (const listener of this.listeners) listener(state);
  }
}

export const hostPowerState = new HostPowerState();
