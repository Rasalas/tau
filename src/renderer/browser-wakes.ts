import type { HostWakeSource } from "../workbench/host-link";

interface NetworkInformationLike {
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

/**
 * A page's wakes for the socket transport: visibility, a bfcache or lifecycle
 * resume, `online`/`offline` and a network change. Electron also supplies its
 * native resume signal; its window need not change visibility during sleep.
 */
export function browserWakeSource(onPowerState?: (listener: (state: "suspend" | "resume") => void) => () => void): HostWakeSource {
  return (listener) => {
    const foreground = () => { if (document.visibilityState === "visible") listener("foreground"); };
    const online = () => listener("online");
    const offline = () => listener("offline");
    const changed = () => listener("network-change");
    const suspend = () => listener("suspend");
    const resume = () => listener("resume");
    const stopPower = onPowerState?.(listener);
    // Chromium and Android only; elsewhere `online` is the whole signal.
    const connection = (navigator as { connection?: NetworkInformationLike }).connection;
    document.addEventListener("visibilitychange", foreground);
    document.addEventListener("freeze", suspend);
    document.addEventListener("resume", resume);
    window.addEventListener("pageshow", foreground);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    connection?.addEventListener("change", changed);
    if (navigator.onLine === false) listener("offline");
    return () => {
      stopPower?.();
      document.removeEventListener("visibilitychange", foreground);
      document.removeEventListener("freeze", suspend);
      document.removeEventListener("resume", resume);
      window.removeEventListener("pageshow", foreground);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      connection?.removeEventListener("change", changed);
    };
  };
}
