import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, extname, sep } from "node:path";
import { Readable } from "node:stream";
import type { UiSharedFile } from "../shared/contracts.js";

/** What the page may be handed a URL for: documents and media a browser draws itself. */
const SHAREABLE_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
};

const TOKEN_PATH = /^\/([0-9a-f]{32})(?:\/[^/]*)?$/u;
const MAX_SHARED = 256;

export function shareableType(path: string): string | undefined {
  return SHAREABLE_TYPES[extname(path).toLowerCase()];
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

interface SharedEntry {
  path: string;
  mimeType: string;
}

/**
 * Files of the open workspace the page may load by URL — a PDF in a frame,
 * an image, a video — served over `tau-ext://files/<token>/<name>` by the
 * window's process, which reads them from this machine's disk. A token names
 * one file; nothing outside the workspace, and nothing but a type a browser
 * draws itself, is ever given one.
 */
export class SharedFileStore {
  private readonly entries = new Map<string, SharedEntry>();

  /** `root` is the workspace the host has open now, or nothing before it said. */
  constructor(private readonly root: () => string | undefined) {}

  async share(path: string): Promise<UiSharedFile> {
    const root = this.root();
    if (!root) throw new Error("No workspace is open.");
    const mimeType = shareableType(path);
    if (!mimeType) throw new Error("Only PDFs, images, audio and video can be shown this way.");
    // Symlinks resolve first, so a link inside the workspace cannot point out of it.
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(path)]);
    if (!within(realRoot, realTarget)) throw new Error("Path is outside the workspace.");
    const info = await stat(realTarget);
    if (!info.isFile()) throw new Error("Not a file.");
    const existing = [...this.entries].find(([, entry]) => entry.path === realTarget);
    const token = existing?.[0] ?? randomBytes(16).toString("hex");
    this.entries.delete(token);
    this.entries.set(token, { path: realTarget, mimeType });
    // Oldest first: a Map keeps insertion order, and a re-share moved its entry to the end.
    while (this.entries.size > MAX_SHARED) this.entries.delete(this.entries.keys().next().value as string);
    const name = basename(path);
    return { url: `tau-ext://files/${token}/${encodeURIComponent(name)}`, name, size: info.size, mimeType };
  }

  clear(): void {
    this.entries.clear();
  }

  /** Answers one request; a `Range` header gets the bytes a media element asks for. */
  async respond(url: string, rangeHeader?: string | null): Promise<Response> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return notFound(); }
    const match = parsed.host === "files" ? TOKEN_PATH.exec(parsed.pathname) : null;
    const entry = match ? this.entries.get(match[1]!) : undefined;
    if (!entry) return notFound();
    let size: number;
    try { size = (await stat(entry.path)).size; } catch { return notFound(); }
    const headers: Record<string, string> = {
      "Content-Type": entry.mimeType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    // An SVG opened as a document runs no script and reaches nothing.
    if (entry.mimeType === "image/svg+xml") headers["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
    const range = parseRange(rangeHeader, size);
    if (range === "invalid") {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    if (!range) {
      return new Response(size === 0 ? null : body(entry.path, 0, size - 1), { status: 200, headers: { ...headers, "Content-Length": String(size) } });
    }
    return new Response(body(entry.path, range.start, range.end), {
      status: 206,
      headers: { ...headers, "Content-Length": String(range.end - range.start + 1), "Content-Range": `bytes ${range.start}-${range.end}/${size}` },
    });
  }
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

function body(path: string, start: number, end: number): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>;
}

/** One `bytes=` range, the only kind a media element or the PDF viewer sends. */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | "invalid" | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  if (size === 0) return "invalid";
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || end < start) return "invalid";
  return { start, end };
}
