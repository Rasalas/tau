import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { NativeService } from "./discovery";
import type { SecureStore } from "./hosts";
import type { TextScalePort } from "./text-scale";
import { trackedBridge, type NativeSocketEvent, type NativeSocketRequest, type SocketBridge } from "./native-socket";

export interface DeviceInfo {
  /** What the system calls the device ("iPhone", "Pixel 9"). */
  name: string;
  model: string;
  platform: "ios" | "android";
  virtual: boolean;
}

/** The app's own plugin (`plugins/tau-native`): Keychain/Keystore, pinned sockets, QR scanner, Bonjour. */
interface TauNativePlugin {
  secureGet(options: { key: string }): Promise<{ value?: string }>;
  secureSet(options: { key: string; value: string }): Promise<void>;
  secureRemove(options: { key: string }): Promise<void>;
  socketOpen(options: NativeSocketRequest): Promise<void>;
  socketSend(options: { id: string; data: string }): Promise<void>;
  socketClose(options: { id: string; code?: number; reason?: string }): Promise<void>;
  /** Rejects with code `cancelled`, `camera-denied` or `no-camera`. */
  scanQr(): Promise<{ text: string }>;
  discoveryStart(options: { type: string }): Promise<void>;
  discoveryStop(): Promise<void>;
  deviceInfo(): Promise<DeviceInfo>;
  pushAvailable(): Promise<{ available: boolean }>;
  /** Android only: the system's font scale (1 by default). */
  textScale(): Promise<{ scale: number }>;
  addListener(event: "socket", listener: (event: NativeSocketEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: "discovery", listener: (event: { services: NativeService[]; error?: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "textScale", listener: (event: { scale: number }) => void): Promise<PluginListenerHandle>;
}

const TauNative = registerPlugin<TauNativePlugin>("TauNative");

export const secureStore: SecureStore = {
  get: async (key) => (await TauNative.secureGet({ key })).value ?? undefined,
  set: async (key, value) => { await TauNative.secureSet({ key, value }); },
  remove: async (key) => { await TauNative.secureRemove({ key }); },
};

/** One plugin listener for every socket, routed by id; installed before the first socket opens. */
export async function createSocketBridge(): Promise<SocketBridge> {
  const listeners = new Map<string, (event: NativeSocketEvent) => void>();
  await TauNative.addListener("socket", (event) => listeners.get(event.id)?.(event));
  const bridge = trackedBridge({
    open: (request) => TauNative.socketOpen(request),
    send: (id, data) => TauNative.socketSend({ id, data }),
    close: (id, code, reason) => TauNative.socketClose({ id, ...(code !== undefined ? { code } : {}), ...(reason ? { reason } : {}) }),
    subscribe: (id, listener) => {
      listeners.set(id, listener);
      return () => { listeners.delete(id); };
    },
  }, sessionStorage);
  window.addEventListener("pagehide", bridge.closeAll);
  return bridge;
}

export type ScanResult = { text: string } | { error: "cancelled" | "camera-denied" | "no-camera" | "failed"; message?: string };

export async function scanQrCode(): Promise<ScanResult> {
  try {
    return { text: (await TauNative.scanQr()).text };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "cancelled" || code === "camera-denied" || code === "no-camera") return { error: code };
    return { error: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/** Browses for hosts until the returned function is called. */
export function browseHosts(type: string, listener: (services: NativeService[], error?: string) => void): () => void {
  let stopped = false;
  let handle: PluginListenerHandle | undefined;
  void TauNative.addListener("discovery", (event) => { if (!stopped) listener(event.services, event.error); }).then((next) => {
    if (stopped) void next.remove();
    else handle = next;
  });
  void TauNative.discoveryStart({ type }).catch((error: unknown) => listener([], error instanceof Error ? error.message : String(error)));
  return () => {
    stopped = true;
    void handle?.remove();
    void TauNative.discoveryStop().catch(() => undefined);
  };
}

export function deviceInfo(): Promise<DeviceInfo> {
  return TauNative.deviceInfo();
}

/** Whether this build can receive pushes: always on iOS, on Android only with a Firebase project built in. */
export async function pushAvailable(): Promise<boolean> {
  return (await TauNative.pushAvailable().catch(() => ({ available: false }))).available;
}

export const textScalePort: TextScalePort = {
  read: async () => (await TauNative.textScale()).scale,
  listen: async (listener) => {
    const handle = await TauNative.addListener("textScale", (event) => listener(event.scale));
    return () => { void handle.remove(); };
  },
};
