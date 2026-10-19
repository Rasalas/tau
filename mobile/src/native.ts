import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { NativeService } from "./discovery";
import type { SecureStore } from "./hosts";
import type { TextScalePort } from "./text-scale";
import { trackedBridge, type NativeSocketEvent, type NativeSocketRequest, type SocketBridge } from "./native-socket";
import { createBrowserResourceBridge, type BrowserResourceBridge, type BrowserResourceRequest, type BrowserResourceResponse } from "./browser-resources";

export interface DeviceInfo {
  /** What the system calls the device ("iPhone", "Pixel 9"). */
  name: string;
  model: string;
  platform: "ios" | "android";
  virtual: boolean;
}

/** The app's own plugin (`plugins/tau-native`): Keychain/Keystore, pinned sockets, QR scanner, Bonjour. */
interface TauNativePlugin {
  activityRemoteStatus(options: { hostId: string }): Promise<import("./activity-start").RemoteActivityStatus>;
  activityRemoteConfigure(options: Parameters<import("./activity-start").RemoteActivityNative["configure"]>[0]): Promise<void>;
  activityRemoteDisable(options: { hostId: string }): Promise<void>;
  activityKey(options: { hostId: string; keyId: string; key: string }): Promise<void>;
  activityTokens(): Promise<{ tokens: import("./activities").ActivityToken[] }>;
  /** One snapshot per host: iOS stores it in the App Group and follows it with the host's Live Activity; Android keeps it for its widgets and notification. */
  widgetSnapshot(options: import("./widgets").WidgetSnapshot): Promise<void>;
  activityClear(options: { hostId: string }): Promise<void>;
  dictationLanguages(): ReturnType<import("../../src/renderer/dictation").DictationPort["languages"]>;
  dictationDownload(options: { language: string }): Promise<void>;
  dictationStart(options: { language: string; id: string }): Promise<void>;
  dictationFinish(): Promise<{ text: string }>;
  dictationCancel(): Promise<void>;
  secureGet(options: { key: string }): Promise<{ value?: string }>;
  secureSet(options: { key: string; value: string }): Promise<void>;
  secureRemove(options: { key: string }): Promise<void>;
  socketOpen(options: NativeSocketRequest): Promise<void>;
  socketSend(options: { id: string; data: string }): Promise<void>;
  socketClose(options: { id: string; code?: number; reason?: string }): Promise<void>;
  resourceRespond(options: BrowserResourceResponse & { id: string }): Promise<void>;
  resourceClose(options: { connectionId: string }): Promise<void>;
  /** Rejects with code `cancelled`, `camera-denied` or `no-camera`. */
  scanQr(): Promise<{ text: string }>;
  discoveryStart(options: { type: string }): Promise<void>;
  discoveryStop(): Promise<void>;
  deviceInfo(): Promise<DeviceInfo>;
  pushAvailable(): Promise<{ available: boolean }>;
  /** Android only: reads a host resource through the workbench's connection and opens it in an app chosen by the user. */
  openDocument(options: { url: string; name: string; mimeType: string }): Promise<void>;
  /** Android only: the system's font scale (1 by default). */
  textScale(): Promise<{ scale: number }>;
  addListener(event: "activityToken", listener: (event: import("./activities").ActivityToken) => void): Promise<PluginListenerHandle>;
  addListener(event: "socket", listener: (event: NativeSocketEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: "browserResource", listener: (event: BrowserResourceRequest) => void): Promise<PluginListenerHandle>;
  addListener(event: "discovery", listener: (event: { services: NativeService[]; error?: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "dictation", listener: (event: import("../../src/renderer/dictation").DictationUpdate & { id: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "textScale", listener: (event: { scale: number }) => void): Promise<PluginListenerHandle>;
}

const TauNative = registerPlugin<TauNativePlugin>("TauNative");

export async function createNativeBrowserResources(platform: "ios" | "android"): Promise<BrowserResourceBridge> {
  const resources = await createBrowserResourceBridge({
    listen: async (listener) => { const handle = await TauNative.addListener("browserResource", listener); return () => { void handle.remove(); }; },
    respond: (response) => TauNative.resourceRespond(response),
    close: (connectionId) => TauNative.resourceClose({ connectionId }),
  }, platform);
  window.addEventListener("pagehide", resources.close, { once: true });
  return resources;
}

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

export const openNativeDocument = (document: { url: string; name: string; mimeType: string }) => TauNative.openDocument(document);

let dictationId = "";
export const nativeDictation: import("../../src/renderer/dictation").DictationPort = {
  languages: () => TauNative.dictationLanguages(),
  download: (language) => TauNative.dictationDownload({ language }),
  start: (language) => {
    dictationId = crypto.randomUUID();
    return TauNative.dictationStart({ language, id: dictationId });
  },
  finish: async () => (await TauNative.dictationFinish()).text,
  cancel: () => { dictationId = ""; return TauNative.dictationCancel().catch(() => undefined); },
  listen: async (listener) => {
    const handle = await TauNative.addListener("dictation", (event) => { if (dictationId && event.id === dictationId) listener(event); });
    return () => { void handle.remove(); };
  },
};

export const nativeActivities: import("./activities").ActivityPort = {
  tokens: async (listener) => { const handle = await TauNative.addListener("activityToken", listener); for (const token of (await TauNative.activityTokens()).tokens) listener(token); return () => { void handle.remove(); }; },
  snapshot: (value) => TauNative.widgetSnapshot(value),
  clear: (hostId) => TauNative.activityClear({ hostId }),
};

export function installActivityKey(options: { hostId: string; keyId: string; key: string }): Promise<void> { return TauNative.activityKey(options); }

export const nativeRemoteActivities: import("./activity-start").RemoteActivityNative = {
  status: (hostId) => TauNative.activityRemoteStatus({ hostId }),
  configure: (options) => TauNative.activityRemoteConfigure(options),
  disable: (hostId) => TauNative.activityRemoteDisable({ hostId }),
};
