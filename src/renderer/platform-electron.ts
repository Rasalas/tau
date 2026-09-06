import type { TauDesktopApi } from "../shared/contracts";
import type { ClientStorage } from "../workbench/client-storage";
import { createHostClient, type HostClient } from "../workbench/host-client";
import { HostConnection, type HostTransport } from "../workbench/host-connection";
import type { Platform } from "../workbench/platform";

/**
 * Electron's answer to `Platform` and to the host protocol's transport. This is
 * the one renderer module besides `main.tsx` that knows the workbench runs in a
 * Chromium window over an Electron preload bridge.
 */

/** The Electron preload bridge as a transport; it is in-process and never drops. */
export function createElectronHostTransport(api: TauDesktopApi): HostTransport {
  return {
    platform: api.platform,
    request: (method, params) => api.request(method, params),
    onPush: (listener) => api.onHostEvent(listener),
  };
}

/** Electron IPC as one transport of the protocol; `main.tsx` builds this one. */
export function createElectronHostClient(api: TauDesktopApi): { client: HostClient; connection: HostConnection } {
  const connection = new HostConnection(createElectronHostTransport(api));
  return { client: createHostClient(connection), connection };
}

export function createLocalStorageAdapter(): ClientStorage {
  return {
    get: (key) => localStorage.getItem(key),
    set: (key, value) => localStorage.setItem(key, value),
    remove: (key) => localStorage.removeItem(key),
    keys: (prefix) => {
      const result: string[] = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key && (!prefix || key.startsWith(prefix))) result.push(key);
      }
      return result;
    },
  };
}

export interface ElectronPlatformPorts {
  /** Absent in the browser preview, where there is no host at all. */
  client?: HostClient;
  storage: ClientStorage;
  /** Who opens a path in the user's editor; the registered document source, when there is one. */
  openInEditor(path: string): void;
  /** Whether the host's files are files of this machine (`local-files`). */
  hasLocalFiles(): boolean;
}

/**
 * In Electron the clipboard is the host's, because the host is this machine.
 * The main process turns a window-open request into `shell.openExternal`, so
 * `window.open` is how the renderer reaches the browser.
 */
export function createElectronPlatform(ports: ElectronPlatformPorts): Platform {
  const files = { openInEditor: ports.openInEditor };
  return {
    clipboard: {
      writeText: async (text) => { await ports.client?.copyText(text); },
      writeImage: async (dataUrl) => { await ports.client?.copyImage(dataUrl); },
    },
    openExternal: (url) => { window.open(url, "_blank", "noopener,noreferrer"); },
    // A getter, not a field: the capability settles with the hello, which is
    // after the first render. A window pointed at a host on another machine
    // has no local files and so no `files` at all.
    get files() { return ports.hasLocalFiles() ? files : undefined; },
    storage: ports.storage,
    importModule: (url) => import(/* @vite-ignore */ url),
  };
}
