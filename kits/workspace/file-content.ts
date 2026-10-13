import { lstat, mkdtemp, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { TextDecoder } from "node:util";
import { readBoundedImagePreview, type UiFileContent, type UiFileStat, type UiFileWriteResult } from "tau/host-extension";

/** Source files past this ceiling are cut; the viewer is a reader, not an editor. */
export const MAX_FILE_CONTENT_BYTES = 1024 * 1024;
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

export async function readBoundedFileContent(path: string): Promise<UiFileContent> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Not a file.");
  const name = basename(path);
  const base = { path, name, size: info.size, mtimeMs: info.mtimeMs };

  if (IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) {
    const preview = await readBoundedImagePreview(path);
    return preview ? { ...base, kind: "image", dataUrl: preview.dataUrl } : { ...base, kind: "binary" };
  }

  const handle = await open(path, "r");
  try {
    const truncated = info.size > MAX_FILE_CONTENT_BYTES;
    const buffer = Buffer.alloc(Math.min(info.size, MAX_FILE_CONTENT_BYTES));
    const read = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, read.bytesRead);
    if (bytes.includes(0)) return { ...base, kind: "binary" };
    let text: string;
    try {
      // Streaming leaves an incomplete sequence at the preview cut pending; the BOM stays in the text.
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, { stream: truncated });
    } catch {
      return { ...base, kind: "binary" };
    }
    return { ...base, kind: "text", text, language: languageForFile(name), ...(truncated ? { truncated } : {}) };
  } finally {
    await handle.close();
  }
}

export async function statFile(path: string): Promise<UiFileStat> {
  try {
    const info = await stat(path);
    return info.isFile() ? { exists: true, size: info.size, mtimeMs: info.mtimeMs } : { exists: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

/**
 * Replaces the file atomically, preserving its mode, owner and any symlink to it.
 * `expectedMtimeMs` is when the editor last saw the file; a later write conflicts.
 * `null` means the editor expects no file there.
 */
export async function writeTextFile(path: string, text: string, expectedMtimeMs: number | null | undefined): Promise<UiFileWriteResult> {
  if (expectedMtimeMs !== undefined) {
    const current = await statFile(path);
    const changed = expectedMtimeMs === null ? current.exists : !current.exists || current.mtimeMs !== expectedMtimeMs;
    if (changed) return { status: "conflict", ...(current.exists ? { size: current.size, mtimeMs: current.mtimeMs } : {}) };
  }
  let target: string;
  try { target = await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const entry = await lstat(path).catch((missing: NodeJS.ErrnoException) => {
      if (missing.code !== "ENOENT") throw missing;
      return undefined;
    });
    if (entry?.isSymbolicLink()) throw new Error("Cannot save through a dangling symbolic link.", { cause: error });
    target = path;
  }
  const previous = await stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (previous && !previous.isFile()) throw new Error("Not a file.");
  const directory = await mkdtemp(join(dirname(target), ".tau-save-"));
  try {
    const temporary = join(directory, "content");
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(text, "utf8");
      if (previous) {
        const created = await handle.stat();
        if (created.uid !== previous.uid || created.gid !== previous.gid) await handle.chown(previous.uid, previous.gid);
        await handle.chmod(previous.mode & 0o7777);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (expectedMtimeMs !== undefined) {
      const current = await statFile(path);
      const changed = expectedMtimeMs === null ? current.exists : !current.exists || current.mtimeMs !== expectedMtimeMs;
      if (changed) return { status: "conflict", ...(current.exists ? { size: current.size, mtimeMs: current.mtimeMs } : {}) };
    }
    await rename(temporary, target);
    const written = await stat(target);
    return { status: "written", size: written.size, mtimeMs: written.mtimeMs };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
