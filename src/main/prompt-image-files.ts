import { createHash } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { UiPromptAttachment, UiPromptFileAttachment, UiPromptImageAttachment } from "../shared/contracts.js";
import { promptImages } from "./prompt-attachments.js";
import type { ThreadBackendPromptInput, ThreadRuntimeBackend } from "./runtime-types.js";

const EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };

/** One folder per thread; the id is the host's, so only its separators need care. */
export function promptImageFolder(root: string, threadId: string): string {
  return join(root, threadId.replace(/[^A-Za-z0-9_.-]+/gu, "-").replace(/^[.-]+/u, "").slice(0, 120) || "thread");
}

/** The image's bytes name the file, so the same image sent again reuses its copy. */
export function promptImageFileName(image: Pick<UiPromptImageAttachment, "name" | "mimeType">, bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const extension = EXTENSIONS[image.mimeType.toLowerCase()] ?? "";
  const named = image.name.replace(/^.*[\\/]/u, "").replace(/[^\p{L}\p{N}._ -]+/gu, "-").replace(/^[.\s-]+/u, "").slice(0, 80);
  const stem = (extname(named) ? named.slice(0, -extname(named).length) : named).trim() || "image";
  return `${digest}-${stem}${extension || extname(named)}`;
}

/**
 * Every image sent with a prompt is also kept as a file on the thread's
 * machine, so the agent can do more than look at it: commit it, attach it to
 * a pull request. The runtime gets each image as before and, after them, a
 * file attachment naming its copy, which it names to its model the way it
 * names any attached file. A thread purged for good takes its folder along.
 */
export class PromptImageFiles {
  constructor(private readonly root: string) {}

  /** The prompt's attachments with a file for each image; `discard` removes the copies this call made. */
  async withFiles(threadId: string, attachments: readonly UiPromptAttachment[] = []): Promise<{ attachments: UiPromptAttachment[]; discard(): Promise<void> }> {
    const images = attachments.filter((attachment): attachment is UiPromptImageAttachment => attachment.kind === "image");
    if (images.length === 0) return { attachments: [...attachments], discard: async () => undefined };
    // The same bounds the runtime applies; a copy is never larger than the image it was sent as.
    promptImages(images);
    const folder = promptImageFolder(this.root, threadId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const created: string[] = [];
    const files: UiPromptFileAttachment[] = [];
    try {
      for (const image of images) {
        const bytes = Buffer.from(image.data, "base64");
        const name = promptImageFileName(image, bytes);
        const path = join(folder, name);
        const existing = await stat(path).catch(() => undefined);
        if (existing?.size !== bytes.length) {
          await writeFile(path, bytes, { mode: 0o600 });
          created.push(path);
        }
        files.push({ kind: "file", name, mimeType: image.mimeType, path, size: bytes.length });
      }
    } catch (error) {
      await Promise.all(created.map((path) => rm(path, { force: true })));
      throw error;
    }
    return {
      attachments: [...attachments, ...files],
      discard: async () => { await Promise.all(created.map((path) => rm(path, { force: true }))); },
    };
  }

  /**
   * The backend with its `prompt` given the copies. A thread whose home is
   * another machine is left alone: that machine's host keeps them.
   */
  wrap(backend: ThreadRuntimeBackend): ThreadRuntimeBackend {
    if (backend.kind === "machine") return backend;
    const files = this;
    return new Proxy(backend, { get(target, key) {
      if (key === "prompt") return async (input: ThreadBackendPromptInput) => {
        const { attachments, discard } = await files.withFiles(target.threadId, input.attachments);
        if (attachments.length === (input.attachments?.length ?? 0)) return target.prompt(input);
        // A refused prompt leaves no copies behind; an admitted one keeps them for the thread.
        let admitted: boolean | undefined;
        try {
          return await target.prompt({
            ...input,
            attachments,
            onAdmitted: (accepted, error) => {
              admitted = accepted;
              if (!accepted) void discard();
              input.onAdmitted?.(accepted, error);
            },
          });
        } catch (error) {
          if (admitted === undefined) await discard();
          throw error;
        }
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }

  /** A thread gone for good takes its copies along. */
  async forget(threadId: string): Promise<void> {
    await rm(promptImageFolder(this.root, threadId), { recursive: true, force: true });
  }
}
