import type { HostWakeSource } from "../workbench/host-link";

interface NetworkInformationLike {
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

/**
 * A page's wakes for the socket transport: visibility, a bfcache or lifecycle
 * resume, `online`/`offline` and a network change. A native shell around the
 * web client passes its own app-state and network events instead.
 */
export function browserWakeSource(): HostWakeSource {
  return (listener) => {
    const foreground = () => { if (document.visibilityState === "visible") listener("foreground"); };
    const online = () => listener("online");
    const offline = () => listener("offline");
    const changed = () => listener("network-change");
    // Chromium and Android only; elsewhere `online` is the whole signal.
    const connection = (navigator as { connection?: NetworkInformationLike }).connection;
    document.addEventListener("visibilitychange", foreground);
    document.addEventListener("resume", foreground);
    window.addEventListener("pageshow", foreground);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    connection?.addEventListener("change", changed);
    if (navigator.onLine === false) listener("offline");
    return () => {
      document.removeEventListener("visibilitychange", foreground);
      document.removeEventListener("resume", foreground);
      window.removeEventListener("pageshow", foreground);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      connection?.removeEventListener("change", changed);
    };
  };
}
