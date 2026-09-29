import { decodeHostUpdateStatus, HOST_UPDATE_METHODS, type HostUpdateSettings, type HostUpdateStatus } from "../shared/host-updates";
import { errorMessage } from "./error-message";
import type { HostClient } from "./host-client";

/** The connected host's own Tau as a page follows it (K103). */
export interface HostUpdateView {
  status?: HostUpdateStatus;
  /** Why the host reports none: an older Tau, or a host inside the window's process. */
  unavailable?: string;
}

export interface HostUpdateStore {
  getSnapshot(): HostUpdateView;
  subscribe(listener: () => void): () => void;
  check(): Promise<HostUpdateStatus>;
  install(): Promise<HostUpdateStatus>;
  setSettings(settings: HostUpdateSettings): Promise<HostUpdateStatus>;
}

const stores = new WeakMap<HostClient, HostUpdateStore>();

/**
 * One per client, asked for nothing until something reads it: the status at
 * first read and after every hello (a host that restarted into its update
 * says hello again), then the host's `update-status` pushes.
 */
export function hostUpdateStore(client: HostClient): HostUpdateStore {
  const known = stores.get(client);
  if (known) return known;
  let view: HostUpdateView = {};
  let started = false;
  const listeners = new Set<() => void>();
  const set = (next: HostUpdateView) => {
    view = next;
    for (const listener of [...listeners]) listener();
  };
  const refresh = () => {
    if (!client.hostUpdate) {
      set({ unavailable: "This client cannot ask its host about updates." });
      return;
    }
    client.hostUpdate("status").then(
      (status) => set({ status }),
      (error: unknown) => set({ unavailable: errorMessage(error) }),
    );
  };
  const start = () => {
    if (started) return;
    started = true;
    // A stand-in client may leave these out.
    client.onHostEvent?.((event) => {
      if (event.type !== HOST_UPDATE_METHODS.status) return;
      const status = decodeHostUpdateStatus(event.status);
      if (status) set({ status });
    });
    client.onVersions?.(refresh);
    refresh();
  };
  const act = async (run: () => Promise<HostUpdateStatus> | undefined): Promise<HostUpdateStatus> => {
    const pending = run();
    if (!pending) throw new Error("This host cannot update itself from here.");
    const status = await pending;
    set({ status });
    return status;
  };
  const store: HostUpdateStore = {
    getSnapshot: () => view,
    subscribe(listener) {
      start();
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    check: () => act(() => client.hostUpdate?.("check")),
    install: () => act(() => client.hostUpdate?.("install")),
    setSettings: (settings) => act(() => client.setHostUpdateSettings?.(settings)),
  };
  stores.set(client, store);
  return store;
}
