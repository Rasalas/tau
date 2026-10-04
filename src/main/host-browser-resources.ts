import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildVisualizationDocument, VISUALIZATION_CSP } from "../shared/inline-visualization.js";
import { currentCaller } from "./host-invocation.js";

export type HostBrowserResourceHandler = (request: Request) => Promise<Response>;
export interface HostBrowserResources {
  /** A bearer capability for one resource, valid for ten minutes. Mint inside a client command. */
  publish(handler: HostBrowserResourceHandler): string;
  /** Immutable HTML with scripts in an opaque sandbox, without filesystem or network access. */
  publishVisualization(fragment: string, theme?: "light" | "dark"): string;
  /** Only the publishing extension and connection can release it. */
  release(path: string): void;
}
export const BIND_BROWSER_RESOURCES = Symbol("bind-browser-resources");
export const REMOVE_BROWSER_RESOURCES = Symbol("remove-browser-resources");
const PATH = /^\/resources\/([0-9a-f]{64})$/u;
const LIFETIME_MS = 10 * 60_000;
const MAX_RESOURCES = 1024;
const HEADERS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'", "referrer-policy": "no-referrer" };
interface Entry { visualization?: boolean; extension: string; connection: string; expires: number; handler: HostBrowserResourceHandler; active: Set<AbortController> }

/** Browser resource capabilities, scoped to a client connection and an extension's lifetime. */
export class HostBrowserResourceStore {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now) {}
  readonly services: HostBrowserResources & { [BIND_BROWSER_RESOURCES](extension: string): HostBrowserResources; [REMOVE_BROWSER_RESOURCES](extension: string): void } = {
    [REMOVE_BROWSER_RESOURCES]: (extension) => this.removeExtension(extension),
    publish: () => { throw new Error("Resources must belong to an extension."); },
    publishVisualization: () => { throw new Error("Resources must belong to an extension."); },
    release: () => undefined,
    [BIND_BROWSER_RESOURCES]: (extension) => ({
      publishVisualization: (fragment, theme = "light") => {
        if (typeof fragment !== "string" || Buffer.byteLength(fragment, "utf8") > 1024 * 1024) throw new Error("Visualization fragment is too large.");
        const html = buildVisualizationDocument(fragment, theme);
        const path = this.services[BIND_BROWSER_RESOURCES](extension).publish(async () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
        this.entries.get(PATH.exec(path)![1])!.visualization = true;
        return path;
      },
      publish: (handler) => {
        const connection = currentCaller();
        if (!connection) throw new Error("Publish a browser resource inside a client command.");
        this.prune();
        if (this.entries.size >= MAX_RESOURCES) throw new Error("Too many browser resources are open.");
        const token = randomBytes(32).toString("hex");
        this.entries.set(token, { extension, connection, expires: this.now() + LIFETIME_MS, handler, active: new Set() });
        return `/resources/${token}`;
      },
      release: (path) => {
        const token = PATH.exec(path)?.[1];
        const entry = token && this.entries.get(token);
        if (token && entry && entry.extension === extension && entry.connection === currentCaller()) this.remove(token);
      },
    }),
  };
  private remove(token: string): void {
    const entry = this.entries.get(token);
    this.entries.delete(token);
    for (const controller of entry?.active ?? []) controller.abort();
  }
  private prune(): void { for (const [token, entry] of this.entries) if (entry.expires <= this.now()) this.remove(token); }
  detach(connection: string): void { for (const [token, entry] of this.entries) if (entry.connection === connection) this.remove(token); }
  removeExtension(extension: string): void { for (const [token, entry] of this.entries) if (entry.extension === extension) this.remove(token); }
  close(): void { for (const token of this.entries.keys()) this.remove(token); }

  /** A capability, not the host token, authorizes GET/HEAD. Never logs its path or handler errors. */
  async respond(request: Request): Promise<Response> {
    this.prune();
    const parsed = new URL(request.url);
    const token = !parsed.search ? PATH.exec(parsed.pathname)?.[1] : undefined;
    const entry = token && this.entries.get(token);
    if (!entry) return new Response(null, { status: 404, headers: HEADERS });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { ...HEADERS, allow: "GET, HEAD" } });
    const controller = new AbortController();
    entry.active.add(controller);
    const signal = AbortSignal.any([controller.signal, request.signal]);
    try {
      const upstream = await entry.handler(new Request(request, { signal }));
      if (signal.aborted || !this.entries.has(token!)) {
        await upstream.body?.cancel();
        entry.active.delete(controller);
        return new Response(null, { status: 404, headers: HEADERS });
      }
      const headers = new Headers(upstream.headers);
      for (const [name, value] of Object.entries(HEADERS)) headers.set(name, value);
      if (entry.visualization) headers.set("content-security-policy", VISUALIZATION_CSP);
      // Never turn an extension's response into a cookie setter or permissive CORS endpoint.
      headers.delete("set-cookie");
      headers.delete("access-control-allow-origin");
      if (request.method === "HEAD" || !upstream.body) {
        await upstream.body?.cancel();
        entry.active.delete(controller);
        return new Response(null, { status: upstream.status, headers });
      }
      const reader = upstream.body.getReader();
      const abort = () => { void reader.cancel().catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      const finish = () => { signal.removeEventListener("abort", abort); entry.active.delete(controller); reader.releaseLock(); };
      const body = new ReadableStream<Uint8Array>({
        async pull(target) {
          try {
            const part = await reader.read();
            if (signal.aborted) { finish(); target.error(new Error("Resource revoked.")); }
            else if (part.done) { finish(); target.close(); }
            else target.enqueue(part.value);
          } catch (error) { finish(); target.error(error); }
        },
        async cancel(reason) { controller.abort(); try { await reader.cancel(reason); } finally { finish(); } },
      });
      return new Response(body, { status: upstream.status, headers });
    } catch {
      entry.active.delete(controller);
      return new Response(null, { status: 502, headers: HEADERS });
    }
  }

  /** The socket listener's HTTP half; backpressure and disconnects reach the upstream fetch. */
  async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableFinished) controller.abort(); };
    response.on("close", disconnect);
    try {
      const headers = new Headers();
      for (const name of ["range", "if-range"]) { const value = request.headers[name]; if (typeof value === "string") headers.set(name, value); }
      const result = await this.respond(new Request(`http://resource.invalid${request.url}`, { method: request.method, headers, signal: controller.signal }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) await pipeline(Readable.fromWeb(result.body as never), response);
      else response.end();
    } catch { if (!response.headersSent) response.writeHead(502, HEADERS); response.end(); }
    finally { response.off("close", disconnect); }
  }
}
