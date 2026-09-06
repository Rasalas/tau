import type { Platform } from "../workbench/platform";
import type { ClientPlatformPorts } from "../renderer/client-platform";

/**
 * What a browser tab can offer the workbench. Less than Electron, and the
 * difference is the point: the clipboard is the page's own (and only while the
 * page has focus), there is no editor to open a path in — the host's files are
 * on the host — and a module is evaluated under whatever the page's CSP allows.
 */
export function createWebPlatform(ports: ClientPlatformPorts): Platform {
  return {
    clipboard: {
      writeText: async (text) => {
        // Not every browser and not every context grants this; failing loudly
        // here is better than a copy that silently did nothing.
        if (!navigator.clipboard) throw new Error("This browser will not let the page write to the clipboard.");
        await navigator.clipboard.writeText(text);
      },
    },
    openExternal: (url) => { window.open(url, "_blank", "noopener,noreferrer"); },
    // No `files`: a tab has no editor, and on a remote host the paths are not
    // even this machine's. Everything that needs one asks and gets nothing.
    storage: ports.storage,
    importModule: (url) => import(/* @vite-ignore */ url),
  };
}
