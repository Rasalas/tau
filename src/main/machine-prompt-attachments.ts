import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { UiPromptAttachment, UiPromptImageAttachment } from "../shared/contracts.js";
import { MAX_ATTACHMENTS, MAX_FILE_ATTACHMENT_BYTES } from "../shared/prompt-attachment-limits.js";
import type { HostCommandCall, HostExtensionServices, HostMachineServices } from "./host-extensions.js";
import { HostCommandError } from "./host-extension-errors.js";
import { decodeUiPromptAttachments } from "./ipc-input.js";
import { promptImages } from "./prompt-attachments.js";

/** Files cross as authenticated blobs, never as paths on the sender's disk. */
export type TransferredPromptAttachment = UiPromptImageAttachment | {
  kind: "file"; name: string; mimeType: string; size: number; blob: string;
};

export function decodePromptAttachments(value: unknown): UiPromptAttachment[] {
  const attachments = decodeUiPromptAttachments("machine-prompt", "attachments", value) ?? [];
  if (attachments.length > MAX_ATTACHMENTS) throw new HostCommandError(`Attach at most ${MAX_ATTACHMENTS} files.`);
  promptImages(attachments);
  return attachments;
}

export function decodeTransferredPromptAttachments(value: unknown): TransferredPromptAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) throw new HostCommandError("attachments must be a bounded array.");
  const attachments: TransferredPromptAttachment[] = value.map((item) => {
    if (!item || typeof item !== "object") throw new HostCommandError("Invalid attachment.");
    if (item.kind === "image") return decodePromptAttachments([item])[0] as UiPromptImageAttachment;
    if (item.kind !== "file" || typeof item.blob !== "string" || !item.blob || "path" in item ||
        typeof item.name !== "string" || typeof item.mimeType !== "string" ||
        !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE_ATTACHMENT_BYTES) {
      throw new HostCommandError("A transferred file needs a blob, name, mimeType and size, not a sender path.");
    }
    return { kind: "file", name: item.name, mimeType: item.mimeType, size: item.size, blob: item.blob };
  });
  promptImages(attachments.filter((item): item is UiPromptImageAttachment => item.kind === "image"));
  return attachments;
}

/** Uses the machine connection's bounded, checksummed upload. Images already carry bytes. */
export async function transferPromptAttachments(machines: HostMachineServices, machine: string, value: unknown): Promise<TransferredPromptAttachment[]> {
  const attachments = decodePromptAttachments(value);
  const result: TransferredPromptAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "image") { result.push(attachment); continue; }
    if (!isAbsolute(attachment.path)) throw new HostCommandError("An attachment needs an absolute path on this host.");
    const info = await stat(attachment.path);
    if (!info.isFile() || info.size > MAX_FILE_ATTACHMENT_BYTES) throw new HostCommandError("File attachments must be files of 50 MB or smaller.");
    const blob = await machines.upload(machine, createReadStream(attachment.path, { end: MAX_FILE_ATTACHMENT_BYTES }), { size: info.size });
    if (blob.size > MAX_FILE_ATTACHMENT_BYTES) throw new HostCommandError("The file grew beyond the 50 MB attachment limit during upload.");
    result.push({ kind: "file", name: attachment.name, mimeType: attachment.mimeType, size: blob.size, blob: blob.id });
  }
  return result;
}

/** Retains files after admission; a rejected prompt removes its copies. Blob ownership is checked by core. */
export async function withReceivedPromptAttachments<T>(
  services: Pick<HostExtensionServices, "stateDir" | "blobs">,
  value: unknown,
  caller: HostCommandCall,
  use: (attachments: UiPromptAttachment[]) => Promise<T>,
): Promise<T> {
  const input = decodeTransferredPromptAttachments(value);
  const folder = join(services.stateDir, "attachments", randomUUID());
  const attachments: UiPromptAttachment[] = [];
  try {
    for (const item of input) {
      if (item.kind === "image") { attachments.push(item); continue; }
      if (!services.blobs) throw new HostCommandError("This host cannot receive attachment files; update Tau here.");
      await services.blobs.take(item.blob, async (blob) => {
        if (blob.size !== item.size || blob.size > MAX_FILE_ATTACHMENT_BYTES) throw new HostCommandError("The attachment size does not match its blob.");
        await mkdir(folder, { recursive: true, mode: 0o700 });
        // Both separators and Windows-reserved filename characters are removed on every platform.
        const name = Array.from(item.name, (char) => char.charCodeAt(0) < 32 ? "_" : char).join("").replace(/[\\/<>:"|?*]/gu, "_").replace(/[. ]+$/u, "").slice(0, 100) || "attachment";
        const path = join(folder, `${randomUUID()}-${name}`);
        await copyFile(blob.path, path);
        attachments.push({ kind: "file", name: item.name, mimeType: item.mimeType, size: blob.size, path });
      }, { caller });
    }
    return await use(attachments);
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}
