import type { HostEvent } from "../shared/contracts";
import type { EnvironmentPairInput, EnvironmentPairResult, EnvironmentTarget, UiEnvironments } from "../shared/environments";
import type { HostClient } from "./host-client";

/**
 * The machines this window knows (ADR 0025), as a page reads them: a list
 * that follows the window's own process, and the few things it can ask of
 * it. Absent in a client without a window process (a browser, a phone), and
 * `getSnapshot` stays undefined where the window keeps no list.
 */
export interface PlatformEnvironments {
  getSnapshot(): UiEnvironments | undefined;
  subscribe(listener: () => void): () => void;
  /** A pairing link, QR text or address; resolves once the other machine's owner decided. */
  pair(input: EnvironmentPairInput): Promise<EnvironmentPairResult>;
  cancelPairing(): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Tries to reach a machine now instead of at its next attempt. */
  retry(id: string): Promise<void>;
  /**
   * Shows another machine in this window: the page loads again there and
   * opens `target`. For the machine already shown, open the target directly.
   */
  open(id: string, target?: EnvironmentTarget): Promise<void>;
  /** What this page was sent to show, once; undefined when it was simply opened. */
  takeArrival(): Promise<EnvironmentTarget | undefined>;
}

export function createPlatformEnvironments(client: HostClient): PlatformEnvironments {
  let snapshot: UiEnvironments | undefined;
  let requested = false;
  const listeners = new Set<() => void>();
  const set = (next: UiEnvironments) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  // Nothing is asked or listened to until something reads the list.
  const load = () => {
    if (requested) return;
    requested = true;
    client.onHostEvent((event: HostEvent) => {
      if (event.type === "environments") set(event.environments);
    });
    // A window without a list refuses; the page then simply shows no other machines.
    void client.listEnvironments().then((list) => { if (!snapshot) set(list); }, () => undefined);
  };
  return {
    getSnapshot: () => {
      load();
      return snapshot;
    },
    subscribe: (listener) => {
      load();
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    pair: (input) => client.pairEnvironment(input),
    cancelPairing: () => client.cancelEnvironmentPairing(),
    rename: async (id, name) => { await client.renameEnvironment(id, name); },
    remove: async (id) => { await client.removeEnvironment(id); },
    retry: (id) => client.retryEnvironment(id),
    open: (id, target) => client.openEnvironment(id, target),
    takeArrival: () => client.takeEnvironmentArrival(),
  };
}
