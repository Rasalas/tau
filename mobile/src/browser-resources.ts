import { BROWSER_RESOURCE_MAX_BYTES, BROWSER_RESOURCE_PATH, browserResourceUrl, type BrowserResourceResponse } from "../../src/shared/browser-resource";
export type { BrowserResourceResponse } from "../../src/shared/browser-resource";

export interface BrowserResourceRequest { id: string; connectionId: string; path: string }
export interface BrowserResourceNative {
  listen(listener: (request: BrowserResourceRequest) => void): Promise<() => void>;
  respond(response: BrowserResourceResponse & { id: string }): Promise<void>;
  close(connectionId: string): Promise<void>;
}
export interface BrowserResourceRoute { resourceUrl(path: string): string; close(): void }
export interface BrowserResourceBridge {
  open(read: (path: string) => Promise<BrowserResourceResponse>): BrowserResourceRoute;
  close(): void;
}

const MAX_PENDING = 16;
const MAX_BASE64 = Math.ceil(BROWSER_RESOURCE_MAX_BYTES / 3) * 4;
const EMPTY: BrowserResourceResponse = { status: 404, headers: {}, body: "" };

/** A native document gets its own response policy without a second network connection. */
export async function createBrowserResourceBridge(native: BrowserResourceNative, platform: "ios" | "android"): Promise<BrowserResourceBridge> {
  const readers = new Map<string, (path: string) => Promise<BrowserResourceResponse>>();
  const pending = new Map<string, { connectionId: string; timer: ReturnType<typeof setTimeout> }>();
  let closed = false;
  const respond = (id: string, response: BrowserResourceResponse) => { void native.respond({ id, ...response }).catch(() => undefined); };
  const stop = await native.listen((request) => {
    const reader = readers.get(request.connectionId);
    if (closed || !reader || !BROWSER_RESOURCE_PATH.test(request.path) || pending.size >= MAX_PENDING || pending.has(request.id)) { respond(request.id, EMPTY); return; }
    const timer = setTimeout(() => { if (pending.delete(request.id)) respond(request.id, { ...EMPTY, status: 504 }); }, 30_000);
    pending.set(request.id, { connectionId: request.connectionId, timer });
    void Promise.resolve().then(() => reader(request.path)).then((response) => {
      if (!pending.has(request.id)) return;
      // Keep unexpected/mismatched host versions from handing the native side unbounded data.
      if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status > 599
        || (response.status >= 300 && response.status < 400) || typeof response.body !== "string"
        || response.body.length > MAX_BASE64 || typeof response.headers !== "object" || response.headers === null) {
        respond(request.id, { ...EMPTY, status: 502 });
      } else respond(request.id, response);
    }, () => { if (pending.has(request.id)) respond(request.id, { ...EMPTY, status: 502 }); }).finally(() => {
      const entry = pending.get(request.id);
      if (entry) clearTimeout(entry.timer);
      pending.delete(request.id);
    });
  });
  const closeRoute = (connectionId: string): void => {
    if (!readers.delete(connectionId)) return;
    for (const [id, entry] of pending) {
      if (entry.connectionId !== connectionId) continue;
      clearTimeout(entry.timer);
      pending.delete(id);
    }
    void native.close(connectionId).catch(() => undefined);
  };
  return {
    open: (read) => {
      if (closed) throw new Error("Browser resource bridge is closed.");
      const connectionId = crypto.randomUUID();
      readers.set(connectionId, read);
      const origin = platform === "ios" ? "tau-resource://localhost" : "https://tau-resources.localhost";
      return {
        resourceUrl: (path) => {
          if (!readers.has(connectionId)) throw new Error("Browser resource connection is closed.");
          return browserResourceUrl(`${origin}/${connectionId}`, path);
        },
        close: () => closeRoute(connectionId),
      };
    },
    close: () => { closed = true; for (const id of readers.keys()) closeRoute(id); stop(); },
  };
}
