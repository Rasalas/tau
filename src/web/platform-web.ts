import type { Platform, PlatformAttention } from "../workbench/platform";
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
    attention: webAttention(),
  };
}

/**
 * The page's own Notification API, which asks the user once, and a count
 * drawn into the tab's icon — plus the app badge of an installed web app.
 */
export function webAttention(): PlatformAttention {
  const granted = () => typeof Notification !== "undefined" && Notification.permission === "granted";
  const requestPermission = async () => {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "default") await Notification.requestPermission().catch(() => undefined);
    return granted();
  };
  return {
    requestPermission,
    notify: async (notification) => {
      if (!await requestPermission()) return "unavailable";
      return new Promise((resolve) => {
        let shown: Notification;
        try {
          shown = new Notification(notification.title, { body: notification.body ?? "", silent: true, ...(notification.tag ? { tag: notification.tag } : {}) });
        } catch {
          // Some browsers expose the API and still refuse to show one from a page.
          resolve("unavailable");
          return;
        }
        shown.onclick = () => { window.focus(); shown.close(); resolve("clicked"); };
        shown.onclose = () => resolve("dismissed");
        shown.onerror = () => resolve("unavailable");
      });
    },
    setBadge: (count) => {
      drawIconBadge(count);
      const badging = navigator as Navigator & { setAppBadge?(count: number): Promise<void>; clearAppBadge?(): Promise<void> };
      void (count > 0 ? badging.setAppBadge?.(count) : badging.clearAppBadge?.())?.catch(() => undefined);
    },
  };
}

let pageIcon: HTMLImageElement | undefined;
let badgeCount = 0;
// The page's own icon links step aside while a badge shows: browsers differ in which icon they pick.
let pageIconLinks: HTMLLinkElement[] = [];

/** The page's own favicon, loaded once; the count is drawn again when it arrives. */
function loadPageIcon(): HTMLImageElement | undefined {
  if (pageIcon) return pageIcon;
  const href = document.head.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]')?.href;
  if (!href) return undefined;
  pageIcon = new Image();
  pageIcon.onload = () => { if (badgeCount > 0) drawIconBadge(badgeCount); };
  pageIcon.src = href;
  return pageIcon;
}

/** The count in a red dot on Tau's favicon, or on its own until the favicon has loaded. */
function drawIconBadge(count: number): void {
  badgeCount = count;
  let link = document.head.querySelector<HTMLLinkElement>("link[data-tau-badge]");
  if (count <= 0) {
    link?.remove();
    document.head.append(...pageIconLinks);
    pageIconLinks = [];
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return;
  const icon = loadPageIcon();
  const onIcon = Boolean(icon?.complete && icon.naturalWidth);
  if (onIcon) context.drawImage(icon!, 0, 0, 64, 64);
  const [x, y, radius] = onIcon ? [42, 22, 22] : [32, 32, 30];
  context.fillStyle = "#d9433a";
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#fff";
  context.font = `600 ${Math.round(radius * (count > 9 ? 1 : 1.33))}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(count > 9 ? "9+" : String(count), x, y + radius / 10);
  if (!link) {
    link = Object.assign(document.createElement("link"), { rel: "icon", type: "image/png" });
    link.dataset.tauBadge = "";
    pageIconLinks = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')];
    for (const own of pageIconLinks) own.remove();
    document.head.append(link);
  }
  link.href = canvas.toDataURL("image/png");
}
