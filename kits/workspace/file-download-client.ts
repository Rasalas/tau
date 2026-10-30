import type { BrowserResourceResponse } from "tau";
import { FILE_DOWNLOAD_MAX_BYTES, type WorkspaceHostClient } from "./protocol.js";

/** Reads only after a click, through this connection's resource resolver. */
export async function downloadWorkspaceFile(
  host: Pick<WorkspaceHostClient, "publishFileDownload" | "releaseFileDownload">,
  resourceUrl: ((path: string) => string) | undefined,
  path: string,
  from: { workspace: string },
  signal: AbortSignal,
  readResource?: (path: string) => Promise<BrowserResourceResponse>,
): Promise<{ blob: Blob; name: string }> {
  signal.throwIfAborted();
  if (!resourceUrl && !readResource) throw new Error("This client does not support file downloads. Open Tau in a supported browser or desktop window.");
  const workspace = from.workspace;
  if (!workspace) throw new Error("This file's originating workspace is unavailable.");
  const resource = await host.publishFileDownload(path, workspace).catch((error: unknown) => {
    const code = (error as { code?: string } | null)?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "unknown-command" || code === "unknown-method" || /has no command|unknown command/iu.test(message)) {
      throw new Error("This machine does not support file downloads. Update Tau on it and try again.");
    }
    throw error;
  });
  if (!resource || typeof resource.path !== "string" || !/^\/resources\/[0-9a-f]{64}$/u.test(resource.path)) {
    throw new Error("This machine did not return a valid file download. Update Tau on it and try again.");
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    void host.releaseFileDownload(resource.path, workspace).catch(() => undefined);
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => { release(); void reader?.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(resource.size) || resource.size < 0 || resource.size > FILE_DOWNLOAD_MAX_BYTES || typeof resource.name !== "string") {
      throw new Error("This file exceeds the 10 MiB download limit or has invalid download metadata.");
    }
    if (readResource) {
      const answer = await readResource(resource.path);
      signal.throwIfAborted();
      if (answer.status !== 200 || typeof answer.body !== "string" || answer.body.length > Math.ceil(FILE_DOWNLOAD_MAX_BYTES / 3) * 4
        || answer.body.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(answer.body)) throw new Error("The file download was refused or incomplete. Try downloading it again.");
      const binary = atob(answer.body);
      if (binary.length !== resource.size || binary.length > FILE_DOWNLOAD_MAX_BYTES) throw new Error("The file download was incomplete. Try downloading it again.");
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return { blob: new Blob([bytes], { type: "application/octet-stream" }), name: resource.name };
    }
    const url = resourceUrl!(resource.path);
    if (/^tau-resource:/u.test(url) || /^https:\/\/tau-resources\.localhost\//u.test(url)) {
      throw new Error("This app cannot save this file. Open Tau in a browser or desktop window to download it.");
    }
    const transferSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const response = await fetch(url, { signal: transferSignal, cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    if (response.status !== 200) { await response.body?.cancel(); throw new Error("The file could not be transferred. It may have changed or the connection was lost. Try downloading it again."); }
    reader = response.body?.getReader();
    if (!reader) throw new Error("This client cannot read a file download. Open Tau in a supported browser or desktop window.");
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > resource.size || size > FILE_DOWNLOAD_MAX_BYTES) throw new Error("The file exceeded the download limit during transfer. Try downloading it again.");
      chunks.push(new Uint8Array(part.value));
    }
    signal.throwIfAborted();
    if (size !== resource.size) throw new Error("The file download was incomplete. Try downloading it again.");
    // Bytes never become an authored document in the workbench.
    return { blob: new Blob(chunks, { type: "application/octet-stream" }), name: resource.name };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof Error && error.name === "TimeoutError") throw new Error("The file download timed out. Try downloading it again.", { cause: error });
    if (error instanceof TypeError) throw new Error("The file could not be transferred on this connection. Open Tau directly on the file's machine and try again.", { cause: error });
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader?.cancel().catch(() => undefined);
    release();
  }
}
