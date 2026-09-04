import { createHash } from "node:crypto";
import { protocol } from "electron";

export const TAU_EXT_SCHEME = "tau-ext";
const BUNDLE_PATH = /^\/bundles\/([a-z0-9][a-z0-9.-]*)\/([0-9a-f]{16,64})\.js$/u;

/**
 * Compiled desktop bundles the renderer may import, keyed by extension id and
 * content hash. Nothing else is reachable over `tau-ext:`, so the CSP can name
 * the scheme instead of allowing every blob the renderer can build for itself.
 */
export class DesktopBundleStore {
  private readonly bundles = new Map<string, string>();

  /** Stores one bundle and returns the URL the renderer imports it from. */
  publish(extensionId: string, code: string): string {
    const id = safeId(extensionId);
    const hash = createHash("sha256").update(code).digest("hex").slice(0, 32);
    this.bundles.set(`${id}/${hash}`, code);
    return `${TAU_EXT_SCHEME}://bundles/${id}/${hash}.js`;
  }

  /** Everything a previous sync published; a reload replaces the whole set. */
  clear(): void {
    this.bundles.clear();
  }

  respond(url: string): Response {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return new Response("Not found", { status: 404 }); }
    if (parsed.host !== "bundles") return new Response("Not found", { status: 404 });
    const match = BUNDLE_PATH.exec(`/bundles${parsed.pathname}`);
    const code = match ? this.bundles.get(`${match[1]}/${match[2]}`) : undefined;
    if (code === undefined) return new Response("Not found", { status: 404 });
    return new Response(code, {
      status: 200,
      headers: {
        "Content-Type": "text/javascript",
        // The hash is the identity of the bundle, so a reload never serves a stale one.
        "Cache-Control": "no-store",
      },
    });
  }
}

/** An extension id that never escapes its path segment. */
function safeId(extensionId: string): string {
  const cleaned = extensionId.toLowerCase().replace(/[^a-z0-9.-]+/gu, "-").replace(/^[.-]+/u, "");
  return cleaned || "extension";
}

/** Must run before `app.whenReady`, like every privileged scheme. */
export function registerDesktopBundleScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: TAU_EXT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

export function serveDesktopBundles(store: DesktopBundleStore): void {
  protocol.handle(TAU_EXT_SCHEME, (request) => store.respond(request.url));
}
