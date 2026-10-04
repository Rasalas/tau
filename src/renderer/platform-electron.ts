import type { TauDesktopApi } from "../shared/contracts";
import { createHostClient, type HostClient } from "../workbench/host-client";
import { HostConnection, type HostTransport } from "../workbench/host-connection";
import type { Platform, PlatformAttention } from "../workbench/platform";
import { createPlatformEnvironments } from "../workbench/environments";
import type { ClientPlatformPorts } from "./client-platform";

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

/**
 * In Electron clipboard commands are answered by the window's own process,
 * even while a thread runs on another machine.
 * The main process turns a window-open request into `shell.openExternal`, so
 * `window.open` is how the renderer reaches the browser.
 */
export function createElectronPlatform(ports: ClientPlatformPorts): Platform {
  const client = ports.client;
  const files = {
    openInEditor: ports.openInEditor,
    ...(client ? { shareFile: (path: string) => client.shareFile(path) } : {}),
  };
  return {
    clipboard: {
      writeText: async (text) => {
        if (client) { await client.copyText(text); return; }
        if (!globalThis.navigator?.clipboard) throw new Error("This client cannot write to the clipboard.");
        await navigator.clipboard.writeText(text);
      },
      ...(client ? { writeImage: async (dataUrl: string) => { await client.copyImage(dataUrl); } } : {}),
    },
    openExternal: (url) => { window.open(url, "_blank", "noopener,noreferrer"); },
    // A getter, not a field: the capability settles with the hello, which is
    // after the first render. A window pointed at a host on another machine
    // has no local files and so no `files` at all.
    get files() { return ports.hasLocalFiles() ? files : undefined; },
    storage: ports.storage,
    importModule: (url) => import(/* @vite-ignore */ url),
    // The window's own process draws both: the page itself holds no permission to.
    ...(ports.client ? { attention: electronAttention(ports.client) } : {}),
    // Drawn by the window's process: `Menu.popup`.
    ...(client ? { contextMenu: { show: (entries, point) => client.showContextMenu(entries, point) } } : {}),
    // The window's process keeps the list; a host in this process refuses it and the list stays empty.
    ...(client ? { environments: createPlatformEnvironments(client, environmentOptions()) } : {}),
  };
}

/** The page's address names the machine it shows when that is not the window's own (ADR 0025). */
function environmentOptions(): { shownElsewhere?: string } {
  const shown = new URLSearchParams(globalThis.location?.search ?? "").get("environment");
  return shown ? { shownElsewhere: shown } : {};
}

function electronAttention(client: HostClient): PlatformAttention {
  return {
    notify: (notification) => client.showNotification(notification).catch(() => "unavailable" as const),
    setBadge: (count) => { void client.setBadge(count).catch(() => undefined); },
  };
}
