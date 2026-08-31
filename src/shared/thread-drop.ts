import {
  IMAGE_MIME_TYPES,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  SUPPORTED_IMAGE_TYPES_LABEL,
} from "./prompt-attachment-limits.js";

export type ThreadDropState = "idle" | "valid" | "mixed" | "unsupported" | "unavailable";

export interface ThreadDropFeedback {
  title: string;
  description: string;
  dropEffect: "copy" | "none";
}

export const THREAD_DROP_FEEDBACK: Readonly<Record<ThreadDropState, ThreadDropFeedback>> = {
  idle: { title: "", description: "", dropEffect: "none" },
  valid: {
    title: "Drop images anywhere in the thread",
    description: `${SUPPORTED_IMAGE_TYPES_LABEL} · up to ${MAX_ATTACHMENTS} images · ${MAX_IMAGE_BYTES / 1024 / 1024} MB each`,
    dropEffect: "copy",
  },
  mixed: {
    title: "Drop supported images",
    description: "Supported images will be attached; other files will be skipped.",
    dropEffect: "copy",
  },
  unsupported: {
    title: "That file type is not supported",
    description: `Use ${SUPPORTED_IMAGE_TYPES_LABEL} images.`,
    dropEffect: "none",
  },
  unavailable: {
    title: "Image attachments unavailable",
    description: "The active runtime does not accept image input.",
    dropEffect: "none",
  },
};

export interface ThreadDropItem {
  kind: string;
  mimeType: string;
  /** Available from DataTransfer.files during dragover; absent means unknown. */
  size?: number;
}

/** Classify only file drag items; string items must not make a file drag invalid. */
export function classifyThreadDrop(
  hasFilesSignal: boolean,
  items: readonly ThreadDropItem[],
  supportsImageInput: boolean,
  existingCount = 0,
  existingBytes = 0,
): ThreadDropState {
  if (!hasFilesSignal) return "idle";
  if (!supportsImageInput) return "unavailable";
  const fileItems = items.filter((item) => item.kind === "file");
  if (fileItems.length === 0) return "valid";
  let acceptedCount = existingCount;
  let totalBytes = existingBytes;
  const accepted = fileItems.filter((item) => {
    const mimeType = item.mimeType.toLowerCase();
    if (!IMAGE_MIME_TYPES.has(mimeType)) return false;
    if (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_IMAGE_BYTES)) return false;
    if (acceptedCount >= MAX_ATTACHMENTS) return false;
    if (item.size !== undefined && totalBytes + item.size > MAX_TOTAL_IMAGE_BYTES) return false;
    acceptedCount += 1;
    if (item.size !== undefined) totalBytes += item.size;
    return true;
  });
  const supported = accepted.length > 0;
  const unsupported = accepted.length < fileItems.length;
  if (supported && unsupported) return "mixed";
  return supported ? "valid" : "unsupported";
}

export const IMAGE_INPUT_UNAVAILABLE_MESSAGE = "Image attachments are unavailable for the active runtime.";
