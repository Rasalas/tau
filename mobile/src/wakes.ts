import type { HostWakeSource } from "../../src/workbench/host-link";

interface ListenerHandle { remove(): Promise<void> }

export interface NetworkStatus {
  connected: boolean;
  connectionType: string;
}

/** `@capacitor/app` as far as wakes go. */
export interface AppStateEvents {
  addListener(event: "appStateChange", listener: (state: { isActive: boolean }) => void): Promise<ListenerHandle>;
}

/** `@capacitor/network` as far as wakes go. */
export interface NetworkEvents {
  getStatus(): Promise<NetworkStatus>;
  addListener(event: "networkStatusChange", listener: (status: NetworkStatus) => void): Promise<ListenerHandle>;
}

/**
 * The app's wakes for the socket transport (F02): back in the foreground,
 * the network lost or back, or another path while connected (Wi-Fi to
 * cellular, one Wi-Fi to another). Each makes the transport probe the link or
 * reconnect at once, and a reconnect races the host's addresses again.
 */
export function nativeWakeSource(app: AppStateEvents, network: NetworkEvents): HostWakeSource {
  return (listener) => {
    let last: NetworkStatus | undefined;
    let stopped = false;
    const handles: ListenerHandle[] = [];
    const keep = (handle: ListenerHandle) => { if (stopped) void handle.remove(); else handles.push(handle); };
    const onNetwork = (status: NetworkStatus): void => {
      const previous = last;
      last = status;
      if (!status.connected) {
        if (previous?.connected !== false) listener("offline");
        return;
      }
      if (previous && !previous.connected) listener("online");
      // The system reports every path update; a probe is only a ping, so each one may ask.
      else if (previous) listener("network-change");
    };
    void app.addListener("appStateChange", ({ isActive }) => { if (isActive && !stopped) listener("foreground"); }).then(keep);
    void network.addListener("networkStatusChange", (status) => { if (!stopped) onNetwork(status); }).then(keep);
    void network.getStatus().then((status) => {
      if (stopped || last) return;
      last = status;
      if (!status.connected) listener("offline");
    }).catch(() => undefined);
    return () => {
      stopped = true;
      for (const handle of handles.splice(0)) void handle.remove();
    };
  };
}
