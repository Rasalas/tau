import { constants } from "node:fs";
import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { passiveKind, PREVIEW_MAX_BYTES, PREVIEW_TIMEOUT_MS, type PassivePreview } from "./passive-preview.js";
import { previewParser } from "./preview-parser.js";
import { parseNotebook, NOTEBOOK_MAX_BYTES, type NotebookPreview } from "./notebook.js";

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Authenticated command dispatch checks ADR 0037; this also refuses project escapes locally. */
export async function readPreviewBytes(project: string, relPath: string, maxBytes = PREVIEW_MAX_BYTES): Promise<Uint8Array | undefined> {
  if (!relPath || !within(project, resolve(project, relPath))) throw new Error("Path must be inside the workspace.");
  const [root, path] = await Promise.all([realpath(project), realpath(resolve(project, relPath))]);
  if (!within(root, path)) throw new Error("Path must be inside the workspace.");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Not a regular file.");
    if (stat.size > maxBytes) return undefined;
    // Read at most the budget + one byte even when a writer grows the file.
    const data = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return offset > maxBytes || offset > stat.size ? undefined : data.subarray(0, offset);
  } finally { await file.close(); }
}

export function runPreviewWorker<T>(program: string, workerData: unknown, workers = new Set<Worker>()): Promise<T> {
  return new Promise<T>((settle, reject) => {
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads'); parentPort.postMessage((${program})(workerData));`, {
      eval: true, workerData,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    workers.add(worker);
    let finished = false;
    const finish = (result?: T, error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer); workers.delete(worker);
      void worker.terminate().finally(() => { if (error) reject(error); else settle(result!); });
    };
    const timer = setTimeout(() => finish(undefined, new Error("Reading this file took too long. Open it in another app.")), PREVIEW_TIMEOUT_MS);
    worker.once("message", (result: T) => finish(result));
    worker.once("error", () => finish(undefined, new Error("Couldn't read this file. Open it in another app.")));
    worker.once("exit", () => finish(undefined, new Error("Couldn't read this file. Open it in another app.")));
  });
}

/** One disposable parser at a time per Files activation; a timeout kills only this read. */
export function createPreviewReader() {
  let disposed = false;
  let queue = Promise.resolve();
  function enqueue<T>(read: () => Promise<T>): Promise<T> {
    const pending = queue.then(() => {
      if (disposed) throw new Error("File reader closed.");
      return read();
    });
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
  const workers = new Set<Worker>();
  return {
    dispose() { disposed = true; for (const worker of workers) void worker.terminate(); workers.clear(); },
    async notebook(project: string, path: string): Promise<NotebookPreview> {
      if (!/\.ipynb$/iu.test(path)) throw new Error("Choose a notebook.");
      return enqueue(async () => {
      try {
        const bytes = await readPreviewBytes(project, path, NOTEBOOK_MAX_BYTES);
        if (!bytes) return { ok: false, error: "Notebook preview is limited to 10 MB. Switch to source or open it in an editor." };
        return await runPreviewWorker<NotebookPreview>(`(data) => (${parseNotebook.toString()})(new TextDecoder('utf-8', {fatal:true}).decode(data))`, bytes, workers);
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Couldn't read this notebook. Switch to source." }; }
      });
    },
    async read(project: string, path: string, table?: string): Promise<PassivePreview> {
      const kind = passiveKind(path);
      if (!kind) return { ok: false, reason: "unsupported", error: "Preview is unavailable. Open it in another app." };
      return enqueue(async () => {
      let temporary: string | undefined;
      try {
        const bytes = await readPreviewBytes(project, path);
        if (!bytes) return { ok: false, reason: "size", error: "This file is larger than 20 MB. Open it in another app." };
        let databasePath: string | undefined;
        if (kind === "database") {
          if (Buffer.from(bytes.subarray(0, 16)).toString("latin1") !== "SQLite format 3\0") return { ok: false, reason: "unsupported", error: "Binary file. This file is not a SQLite database. Open it in another app." };
          temporary = await mkdtemp(join(tmpdir(), "tau-file-preview-"));
          databasePath = join(temporary, "snapshot.sqlite");
          await writeFile(databasePath, bytes, { mode: 0o600, flag: "wx" });
        }
        return await runPreviewWorker<PassivePreview>(previewParser.toString(), { bytes, path, kind, databasePath, table }, workers);
      } catch (error) { return { ok: false, reason: "limit", error: error instanceof Error ? error.message : "Couldn't read this file. Open it in another app." }; }
      finally {
        if (temporary) await rm(temporary, { recursive: true, force: true });
      }
      });
    },
  };
}
