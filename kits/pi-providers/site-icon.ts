// A provider's site icon, fetched by the host once per origin and kept in the kit's state folder.
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const MAX_ICON_BYTES = 128 * 1024;
export const MAX_PAGE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;
const MAX_CANDIDATES = 4;
/** A found icon is asked for again after a month, a missing one after a week; "Check again" asks now. */
const FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISSING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Resolves a host name to its addresses; injectable so a test never asks real DNS. */
export type Resolve = (hostname: string) => Promise<string[]>;

const systemResolve: Resolve = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

function ipv4Private(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

/** Loopback, link-local, private, shared (CGNAT, tailnets), multicast or unspecified. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return ipv4Private(address);
  if (family !== 6) return true;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(lower);
  if (mapped) return ipv4Private(mapped[1]!);
  return lower === "::" || lower === "::1" || /^f[cd]/u.test(lower) || /^fe[89ab]/u.test(lower) || lower.startsWith("ff");
}

const stripBrackets = (hostname: string) => hostname.replace(/^\[|\]$/gu, "");

/** Whether a provider lives on this machine or its network; only such a provider's icon may come from there. */
export async function isLocalProvider(baseUrl: string, resolve: Resolve = systemResolve): Promise<boolean> {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return false; }
  const hostname = stripBrackets(url.hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (isIP(hostname)) return isPrivateAddress(hostname);
  try { return (await resolve(hostname)).some(isPrivateAddress); } catch { return false; }
}

export type IconType = "image/png" | "image/x-icon" | "image/gif" | "image/jpeg" | "image/webp" | "image/svg+xml";

/** What the bytes are, whatever the server called them; `undefined` for anything but an image. */
export function sniffImage(bytes: Uint8Array): IconType | undefined {
  const at = (offset: number, ...values: number[]) => values.every((value, index) => bytes[offset + index] === value);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 1024)).replace(/^﻿/u, "");
  if (/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/iu.test(head)) return "image/svg+xml";
  return undefined;
}

/**
 * Whether an SVG draws only: no script, event handler, foreign content,
 * entity, style import or reference outside itself. One that does anything
 * else is refused rather than cleaned; the window also rasterizes what passes.
 */
export function isInertSvg(text: string): boolean {
  const refused = [
    /<script/iu, /<foreignObject/iu, /<!ENTITY/iu, /<!DOCTYPE/iu, /<iframe/iu, /<embed/iu, /<object/iu, /<\?xml-stylesheet/iu,
    /\son[a-z]+\s*=/iu, /javascript:/iu, /@import/iu,
    /href\s*=\s*(?:"(?!#)|'(?!#)|(?!["'#]))/iu,
    /url\(\s*(?:"(?!#)|'(?!#)|(?!["'#]))/iu,
  ];
  return !refused.some((pattern) => pattern.test(text));
}

/** Icon addresses an HTML page names, preferring a scalable or large one, then `apple-touch-icon`. */
export function linkedIcons(html: string, page: URL): URL[] {
  const attribute = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "iu").exec(tag)?.[2]?.trim();
  const ranked: Array<{ url: URL; rank: number }> = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/giu)) {
    const rel = attribute(tag, "rel")?.toLowerCase().split(/\s+/u) ?? [];
    const href = attribute(tag, "href");
    if (!href || !(rel.includes("icon") || rel.includes("apple-touch-icon"))) continue;
    let url: URL;
    try { url = new URL(href, page); } catch { continue; }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const sizes = Number(/(\d+)x\d+/u.exec(attribute(tag, "sizes") ?? "")?.[1] ?? 0);
    const svg = /svg/iu.test(attribute(tag, "type") ?? "") || /\.svg$/iu.test(url.pathname);
    ranked.push({ url, rank: svg ? 0 : sizes >= 32 ? 1 : rel.includes("icon") ? 2 : 3 });
  }
  return ranked.sort((left, right) => left.rank - right.rank).map((entry) => entry.url);
}

export interface FetchOptions {
  resolve?: Resolve;
  /** Whether private addresses may answer: only for a provider that is itself local. */
  allowPrivate: boolean;
  signal?: AbortSignal;
}

class Refused extends Error {}

/** One GET that follows up to three redirects, each checked again, and stops at `limit` bytes. */
async function get(url: URL, limit: number, options: FetchOptions): Promise<{ url: URL; type: string; body: Uint8Array } | undefined> {
  const resolve = options.resolve ?? systemResolve;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== "http:" && current.protocol !== "https:") throw new Refused(`not http(s): ${current.protocol}`);
    if (hop > 0 && url.protocol === "https:" && current.protocol === "http:") throw new Refused("redirect to plain http");
    // An address written as such never reaches `lookup`.
    const literal = stripBrackets(current.hostname);
    if (isIP(literal) && !options.allowPrivate && isPrivateAddress(literal)) throw new Refused(`${literal} is a private address`);
    // The address is checked where the socket connects, so a name cannot resolve one way here and another there.
    const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
      const done = callback as (error: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;
      const written = isIP(stripBrackets(hostname)) ? [stripBrackets(hostname)] : undefined;
      (written ? Promise.resolve(written) : resolve(hostname)).then((addresses) => {
        const allowed = addresses.filter((address) => options.allowPrivate || !isPrivateAddress(address));
        if (allowed.length === 0) return done(new Refused(`${hostname} resolves to a private address`), "");
        if (lookupOptions.all) return done(null, allowed.map((address) => ({ address, family: isIP(address) })));
        return done(null, allowed[0]!, isIP(allowed[0]!));
      }, (error: unknown) => done(error instanceof Error ? error : new Error(String(error)), ""));
    };
    const response = await send(current, lookup, options.signal);
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      current = new URL(response.headers.location, current);
      continue;
    }
    if (status !== 200) { response.resume(); return undefined; }
    const declared = Number(response.headers["content-length"] ?? 0);
    if (declared > limit) { response.destroy(); return undefined; }
    const body = await readLimited(response, limit);
    return body ? { url: current, type: String(response.headers["content-type"] ?? "").toLowerCase(), body } : undefined;
  }
  throw new Refused("too many redirects");
}

function send(url: URL, lookup: LookupFunction, signal: AbortSignal | undefined): Promise<IncomingMessage> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const options: RequestOptions = {
    method: "GET",
    lookup,
    timeout: REQUEST_TIMEOUT_MS,
    // A plain request: no cookie, no referrer, a generic agent, nothing about the user.
    headers: { accept: "image/*,text/html;q=0.8", "user-agent": "Tau", "accept-encoding": "identity" },
    // The whole request, not only an idle socket, ends after the timeout.
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  return new Promise((resolvePromise, rejectPromise) => {
    const outgoing = request(url, options, resolvePromise);
    outgoing.once("timeout", () => outgoing.destroy(new Error(`${url.origin} did not answer in time`)));
    outgoing.once("error", rejectPromise);
    outgoing.end();
  });
}

function readLimited(response: IncomingMessage, limit: number): Promise<Uint8Array | undefined> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { response.destroy(); resolvePromise(undefined); return; }
      chunks.push(chunk);
    });
    response.once("end", () => resolvePromise(Buffer.concat(chunks)));
    response.once("error", rejectPromise);
    response.once("aborted", () => rejectPromise(new Error("the answer was cut off")));
  });
}

/** An image response as a data URL, typed by its bytes; SVG only when it draws and nothing more. */
function asIcon(body: Uint8Array): string | undefined {
  const type = sniffImage(body);
  if (!type) return undefined;
  if (type === "image/svg+xml" && !isInertSvg(new TextDecoder().decode(body))) return undefined;
  return `data:${type};base64,${Buffer.from(body).toString("base64")}`;
}

/**
 * The icon of the site a provider's API lives on. Only the origin is asked,
 * never the API's path or query (which may carry a key): its home page for the
 * icons it links, then `/favicon.ico`; then the same for the parent domain
 * (`api.example.com` → `example.com`).
 */
export async function fetchSiteIcon(baseUrl: string, options: FetchOptions): Promise<string | undefined> {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Refused(`not http(s): ${url.protocol}`);
  const origins = [url.origin];
  const labels = url.hostname.split(".");
  if (!isIP(url.hostname) && labels.length > 2) origins.push(`${url.protocol}//${labels.slice(1).join(".")}`);
  for (const origin of origins) {
    const home = new URL("/", origin);
    const candidates: URL[] = [];
    try {
      const page = await get(home, MAX_PAGE_BYTES, options);
      if (page && /html/u.test(page.type)) candidates.push(...linkedIcons(new TextDecoder().decode(page.body), page.url));
    } catch (error) {
      if (error instanceof Refused) throw error;
    }
    candidates.push(new URL("/favicon.ico", origin));
    for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
      try {
        const answer = await get(candidate, MAX_ICON_BYTES, options);
        const icon = answer ? asIcon(answer.body) : undefined;
        if (icon) return icon;
      } catch (error) {
        if (error instanceof Refused) throw error;
      }
    }
  }
  return undefined;
}

interface CacheEntry { image?: string; checkedAt: number }

/**
 * Site icons by origin, on disk in the kit's state folder: two providers on
 * one site cost one fetch, and a client asking again gets the answer kept.
 */
export class SiteIconCache {
  private entries: Record<string, CacheEntry> | undefined;
  private readonly pending = new Map<string, Promise<string | undefined>>();

  constructor(private readonly file: string, private readonly fetchIcon: (baseUrl: string, allowPrivate: boolean) => Promise<string | undefined>, private readonly now: () => number = Date.now) {}

  private async load(): Promise<Record<string, CacheEntry>> {
    if (this.entries) return this.entries;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      this.entries = parsed && typeof parsed === "object" ? parsed as Record<string, CacheEntry> : {};
    } catch {
      this.entries = {};
    }
    return this.entries;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.entries ?? {})}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }

  /** The icon for `baseUrl`'s origin: kept, or fetched when there is none, it is stale, or `fresh` asks. */
  async icon(baseUrl: string, { fresh = false, local }: { fresh?: boolean; local: boolean }): Promise<string | undefined> {
    const origin = new URL(baseUrl).origin;
    const entries = await this.load();
    const kept = entries[origin];
    if (kept && !fresh && this.now() - kept.checkedAt < (kept.image ? FOUND_TTL_MS : MISSING_TTL_MS)) return kept.image;
    const running = this.pending.get(origin);
    if (running) return running;
    const job = (async () => {
      const image = await this.fetchIcon(origin, local).catch(() => undefined);
      entries[origin] = { ...(image ? { image } : {}), checkedAt: this.now() };
      await this.save().catch(() => undefined);
      return image;
    })().finally(() => this.pending.delete(origin));
    this.pending.set(origin, job);
    return job;
  }
}
