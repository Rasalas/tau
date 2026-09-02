import { open, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { UiFileContent } from "../shared/workspace-kit-types.js";
import { readBoundedImagePreview } from "./image-preview.js";

/** Source files past this ceiling are cut; the viewer is a reader, not an editor. */
export const MAX_FILE_CONTENT_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".json": "json", ".css": "css", ".md": "markdown", ".py": "python", ".rs": "rust", ".go": "go",
  ".sh": "bash", ".bash": "bash", ".zsh": "bash", ".sql": "sql",
  ".html": "xml", ".htm": "xml", ".xml": "xml", ".svg": "xml", ".yml": "yaml", ".yaml": "yaml",
  ".diff": "diff", ".patch": "diff",
};
const LANGUAGE_BY_NAME: Record<string, string> = { Dockerfile: "bash", Makefile: "bash", ".zshrc": "bash", ".bashrc": "bash" };

export function languageForFile(name: string): string | undefined {
  return LANGUAGE_BY_NAME[name] ?? LANGUAGE_BY_EXTENSION[extname(name).toLowerCase()];
}

function looksBinary(probe: Buffer): boolean {
  return probe.includes(0);
}

export async function readBoundedFileContent(path: string): Promise<UiFileContent> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Not a file.");
  const name = basename(path);
  const base = { path, name, size: info.size };

  if (IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) {
    const preview = await readBoundedImagePreview(path);
    return preview ? { ...base, kind: "image", dataUrl: preview.dataUrl } : { ...base, kind: "binary" };
  }

  const handle = await open(path, "r");
  try {
    const probe = Buffer.alloc(Math.min(BINARY_PROBE_BYTES, info.size));
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    if (looksBinary(probe.subarray(0, bytesRead))) return { ...base, kind: "binary" };

    const truncated = info.size > MAX_FILE_CONTENT_BYTES;
    const buffer = Buffer.alloc(Math.min(info.size, MAX_FILE_CONTENT_BYTES));
    const read = await handle.read(buffer, 0, buffer.length, 0);
    // Drop a partial multibyte sequence at the cut so the tail never shows a replacement glyph.
    const text = truncated
      ? buffer.subarray(0, read.bytesRead).toString("utf8").replace(/�+$/u, "")
      : buffer.subarray(0, read.bytesRead).toString("utf8");
    return { ...base, kind: "text", text, language: languageForFile(name), ...(truncated ? { truncated } : {}) };
  } finally {
    await handle.close();
  }
}
