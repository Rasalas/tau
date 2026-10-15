import { tmpdir } from "node:os";
import { HTML_PAGE_LIMITS } from "./protocol.js";
import { PageError, inlineLocalImages, readOrigins, readPageFile } from "./document.js";
import type { PageStore } from "./store.js";

export interface ShowInput {
  title?: unknown;
  html?: unknown;
  path?: unknown;
  origins?: unknown;
  height?: unknown;
}

export interface ShownPage { id: string; title: string; notes: string[] }

/** Documents are served whole, and a framed one may be 5 MiB at most (core's limit); images count toward it. */
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/**
 * Checks what the agent handed over, embeds its local images and keeps the
 * page for the thread. Every refusal is a `PageError` whose text tells the
 * agent what to change.
 */
export async function showPage(store: PageStore, thread: { sessionId: string; cwd: string }, input: ShowInput): Promise<ShownPage> {
  const title = typeof input.title === "string" ? input.title.replace(/\s+/gu, " ").trim().slice(0, HTML_PAGE_LIMITS.titleLength) : "";
  if (!title) throw new PageError("show_html_page needs a title.");
  const hasHtml = typeof input.html === "string" && input.html.trim() !== "";
  const hasPath = typeof input.path === "string" && input.path.trim() !== "";
  if (hasHtml === hasPath) throw new PageError("Give either html (the document) or path (an HTML file), not both and not neither.");
  const origins = readOrigins(input.origins);

  // macOS's per-user tmpdir() differs from /tmp, where agents also write pages.
  // Both roots still go through the document reader's canonical path checks.
  const roots = [thread.cwd, tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])].filter((root) => root !== "");
  let html: string;
  let baseDir = thread.cwd || process.cwd();
  if (hasPath) {
    const file = await readPageFile((input.path as string).trim(), { cwd: baseDir, roots });
    html = file.html;
    baseDir = file.baseDir;
  } else {
    html = input.html as string;
    if (Buffer.byteLength(html, "utf8") > HTML_PAGE_LIMITS.htmlBytes) throw new PageError(`The page is larger than ${HTML_PAGE_LIMITS.htmlBytes / 1024} KiB. Write it to a file and pass path, or shrink it.`);
  }

  const inlined = await inlineLocalImages(html, { baseDir, roots });
  if (Buffer.byteLength(inlined.html, "utf8") > MAX_DOCUMENT_BYTES) throw new PageError("The page with its images is larger than 5 MiB. Use smaller images.");

  const height = typeof input.height === "number" && Number.isFinite(input.height) ? Math.round(Math.min(2000, Math.max(80, input.height))) : HTML_PAGE_LIMITS.defaultMaxHeight;
  const id = await store.add(thread.sessionId, { meta: { title, maxHeight: height, origins }, html: inlined.html });
  const notes = inlined.skipped.length > 0 ? [`Could not embed: ${inlined.skipped.join(", ")}.`] : [];
  return { id, title, notes };
}
