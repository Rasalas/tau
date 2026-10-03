import { stripVTControlCharacters } from "node:util";
import { mkdir } from "node:fs/promises";
import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import type { SourceControl } from "./provider-registry.js";
import type { PullRequestRef } from "./protocol.js";
import { defaultCliRunner, type CliRunner } from "./request-cli.js";
import { requestMediaSource, requestMediaType } from "./request-media.js";

const MEDIA = /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml)|video\/(?:mp4|webm|quicktime|ogg))$/u;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const unavailable = () => new Response(null, { status: 502 });
const HEADERS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
interface Connection { api: URL; token: string }
interface MediaOptions {
  run?: CliRunner;
  fetch?: typeof fetch;
  now?(): number;
  cwd: string;
  findCommand(name: string): string | undefined;
}

/** Forge credentials and redirect/Range policy live here; core only serves resource capabilities. */
export function createRequestMediaResponder(options: MediaOptions) {
  const run = options.run ?? defaultCliRunner;
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const connections = new Map<string, { expires: number; value: Promise<Connection> }>();
  const execute = (name: string, args: string[], onStderr?: (text: string) => void) => {
    const command = options.findCommand(name);
    if (!command) throw new Error("Missing forge CLI.");
    return run(command, args, options.cwd, { maxBuffer: 32 * 1024, onStderr });
  };
  const connection = (host: string): Promise<Connection> => {
    const cached = connections.get(host);
    if (cached && cached.expires > now()) return cached.value;
    const value = (async () => {
      // `auth status` itself sends credentials. Reject HTTP before invoking it.
      const protocol = await execute("glab", ["config", "get", "api_protocol", "--host", host]);
      if (protocol.trim() !== "https") throw new Error("An HTTPS API is required.");
      let stderr = "";
      const stdout = await execute("glab", ["auth", "status", "--hostname", host, "--show-token"], (text) => { stderr = text; });
      const status = stripVTControlCharacters(`${stdout}\n${stderr}`);
      const endpoint = /REST API Endpoint:\s*(\S+)/u.exec(status)?.[1];
      const token = /Token found in [^\r\n]*?:\s*(\S+)/u.exec(status)?.[1];
      if (!endpoint || !token) throw new Error("Missing forge connection.");
      const api = new URL(endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
      if (api.protocol !== "https:" || api.username || api.password || api.search || api.hash || !api.pathname.endsWith("/api/v4/")) throw new Error("Invalid API endpoint.");
      return { api, token };
    })();
    if (connections.size >= 64) connections.delete(connections.keys().next().value!);
    connections.set(host, { value, expires: now() + 5 * 60_000 });
    void value.catch(() => { if (connections.get(host)?.value === value) connections.delete(host); });
    return value;
  };
  const fetchResponse = async (url: URL | string, request: Request, headers: Record<string, string>): Promise<Response> => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 15_000);
    timer.unref?.();
    try { return await fetcher(url, { method: request.method, headers, redirect: "manual", signal: AbortSignal.any([request.signal, deadline.signal]) }); }
    finally { clearTimeout(timer); }
  };
  return async (ref: PullRequestRef, source: string, request: Request): Promise<Response> => {
    const media = requestMediaSource(source, ref);
    if (!media || !["GET", "HEAD"].includes(request.method)) return unavailable();
    try {
      if (media.kind === "github") {
        const token = (await execute("gh", ["auth", "token", "--hostname", "github.com"])).trim();
        if (!token || /\s/u.test(token)) return unavailable();
        // Resolve the storage redirect on the host; only its short-lived URL reaches the client.
        const response = await fetchResponse(media.url, new Request(request, { method: "GET" }), { authorization: `token ${token}` });
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!REDIRECTS.has(response.status) || !location) return unavailable();
        const url = new URL(location, media.url);
        if (url.protocol !== "https:" || url.username || url.password) return unavailable();
        return new Response(null, { status: 302, headers: { ...HEADERS, location: url.toString() } });
      }
      const { api, token } = await connection(ref.host);
      const subfolder = api.pathname.replace(/\/api\/v4\/$/u, "").slice(1);
      const project = subfolder && media.project.startsWith(`${subfolder}/`) ? media.project.slice(subfolder.length + 1) : media.project;
      let url = new URL(`projects/${encodeURIComponent(project)}/uploads/${media.secret}/${encodeURIComponent(media.fileName)}`, api);
      let authenticated = true;
      for (let hop = 0; hop < 5; hop++) {
        const range = request.headers.get("range");
        const headers: Record<string, string> = { ...(authenticated ? { "private-token": token } : {}), "accept-encoding": "identity" };
        if (request.method === "GET" && range && /^bytes=(?:\d+-\d*|-\d+)$/u.test(range)) {
          headers.range = range;
          const ifRange = request.headers.get("if-range");
          if (ifRange) headers["if-range"] = ifRange;
        }
        const response = await fetchResponse(url, request, headers);
        if (REDIRECTS.has(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get("location");
          if (!location) return unavailable();
          const next = new URL(location, url);
          if (next.protocol !== "https:" || next.username || next.password) return unavailable();
          authenticated = authenticated && next.origin === url.origin;
          url = next;
          continue;
        }
        const output = new Headers(HEADERS);
        const contentRange = response.headers.get("content-range");
        if (response.status === 416) {
          await response.body?.cancel();
          if (contentRange && /^bytes \*\/\d+$/u.test(contentRange)) output.set("content-range", contentRange);
          return new Response(null, { status: 416, headers: output });
        }
        const upstream = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        const mimeType = upstream === "application/octet-stream" ? requestMediaType(media.fileName) : upstream;
        const encoding = response.headers.get("content-encoding");
        const encoded = encoding !== null && encoding !== "identity";
        if (![200, 206].includes(response.status) || !mimeType || !MEDIA.test(mimeType)
          || (response.status === 206 && (encoded || !contentRange || !/^bytes \d+-\d+\/\d+$/u.test(contentRange)))) {
          await response.body?.cancel();
          return unavailable();
        }
        output.set("content-type", mimeType);
        if (response.status === 206) output.set("content-range", contentRange!);
        if (response.headers.get("accept-ranges") === "bytes") output.set("accept-ranges", "bytes");
        for (const name of ["etag", "last-modified"]) { const value = response.headers.get(name); if (value) output.set(name, value); }
        const length = response.headers.get("content-length");
        if (!encoded && length && /^\d+$/u.test(length) && Number.isSafeInteger(Number(length))) output.set("content-length", length);
        if (request.method === "HEAD") await response.body?.cancel();
        return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers: output });
      }
      return unavailable();
    } catch { return unavailable(); } // Errors may contain tokens or signed storage URLs. Never expose them.
  };
}

export function registerRequestMedia(context: HostExtensionContext, sources: SourceControl): void {
  const respond = createRequestMediaResponder({ cwd: context.services.stateDir, findCommand: (name) => context.services.findCommand(name) });
  context.registerCommand("pr-media", (input) => {
    const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const target = typeof fields.url === "string" ? sources.forUrl(fields.url) : undefined;
    const resources = context.services.browserResources;
    if (!resources || !target || typeof fields.source !== "string" || fields.source.length > 4096) throw new HostCommandError("This host cannot serve this request upload.");
    const source = fields.source;
    const media = requestMediaSource(source, target.ref);
    if (!media) throw new HostCommandError("Name an upload of this request's forge.");
    return { path: resources.publish(async (request) => { await mkdir(context.services.stateDir, { recursive: true }); return respond(target.ref, source, request); }), mimeType: media.kind === "gitlab" ? requestMediaType(media.fileName) : undefined };
  }, { access: "read" });
  context.registerCommand("pr-media-release", (input) => {
    const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
    if (typeof fields.path === "string") context.services.browserResources?.release(fields.path);
  }, { access: "read" });
}
