import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { HostCommandError } from "tau/host-extension";
import { deviceReadPaths } from "../_filesystem/device-read-paths.js";
import { FILE_DOWNLOAD_MAX_BYTES } from "./protocol.js";

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const refusal = (message: string) => new HostCommandError(message);

/** A basename safe in a download attribute and in both Content-Disposition parameters. */
export function downloadName(path: string): string {
  const name = basename(path.replace(/\\/gu, "/"));
  return Array.from(name).slice(0, 180).map((char) => /[\p{C}<>:"/\\|?*]/u.test(char) ? "_" : char).join("").replace(/[. ]+$/u, "") || "download";
}

function disposition(name: string): string {
  const ascii = name.replace(/[^a-zA-Z0-9._ -]/gu, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** No bytes are read at publication. The capability reopens only its checked file on GET. */
export async function prepareFileDownload(project: string, path: string, fullAccess: boolean) {
  const root = await realpath(project);
  const asked = resolve(project, path);
  if (!path || !inside(resolve(project), asked)) throw refusal("Path must be inside the workspace.");
  const allowed = fullAccess ? undefined : await deviceReadPaths(root);
  const checkedPath = async () => {
    const canonical = await realpath(asked);
    if (!inside(root, canonical) || allowed && (!await allowed.resolve(asked) || !await allowed.resolve(canonical))) {
      throw refusal("This file is outside the readable workspace.");
    }
    return canonical;
  };
  const openChecked = async () => {
    const canonical = await checkedPath();
    const file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile()) throw refusal("Not a regular file.");
      if (info.size > FILE_DOWNLOAD_MAX_BYTES) throw refusal("Downloads are limited to 10 MiB on this connection. Open the file on its machine instead.");
      // Recheck the original name after opening, including a replaced symlink.
      if (canonical !== await checkedPath()) throw refusal("The file changed. Try downloading it again.");
      return { file, info, canonical };
    } catch (error) { await file.close(); throw error; }
  };
  const initial = await openChecked();
  await initial.file.close();
  const name = downloadName(path);
  const headers = {
    "content-type": "application/octet-stream",
    "content-disposition": disposition(name),
    "content-length": String(initial.info.size),
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  };
  const unchanged = (info: typeof initial.info) => info.dev === initial.info.dev && info.ino === initial.info.ino
    && info.size === initial.info.size && info.mtimeMs === initial.info.mtimeMs && info.ctimeMs === initial.info.ctimeMs;
  return {
    name, size: initial.info.size,
    async respond(request: Request): Promise<Response> {
      request.signal.throwIfAborted();
      const next = await openChecked();
      const { file } = next;
      let closing: Promise<void> | undefined;
      const close = () => { request.signal.removeEventListener("abort", abort); return closing ??= file.close(); };
      const abort = () => { void close().catch(() => undefined); };
      try {
        if (next.canonical !== initial.canonical || !unchanged(next.info)) throw refusal("The file changed. Try downloading it again.");
        if (request.method === "HEAD") { await close(); return new Response(null, { headers }); }
        request.signal.throwIfAborted();
        request.signal.addEventListener("abort", abort, { once: true });
        let offset = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(target) {
            try {
              request.signal.throwIfAborted();
              // One extra byte detects growth, without reading beyond the transport budget + 1.
              const chunk = Buffer.alloc(Math.min(64 * 1024, initial.info.size - offset + 1));
              const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
              request.signal.throwIfAborted();
              if (offset + bytesRead > initial.info.size) throw refusal("The file changed. Try downloading it again.");
              if (offset + bytesRead === initial.info.size) {
                const extra = await file.read(Buffer.alloc(1), 0, 1, initial.info.size);
                if (extra.bytesRead || !unchanged(await file.stat()) || next.canonical !== await checkedPath()) {
                  throw refusal("The file changed. Try downloading it again.");
                }
                request.signal.throwIfAborted();
                await close();
                if (bytesRead) target.enqueue(chunk.subarray(0, bytesRead));
                target.close();
              } else {
                if (!bytesRead) throw refusal("The file changed. Try downloading it again.");
                offset += bytesRead; target.enqueue(chunk.subarray(0, bytesRead));
              }
            } catch (error) { await close().catch(() => undefined); target.error(error); }
          },
          async cancel() { await close(); },
        });
        return new Response(body, { headers });
      } catch (error) { await close().catch(() => undefined); throw error; }
    },
  };
}
