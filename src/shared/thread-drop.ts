import {
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  selectAttachmentCandidates,
  SUPPORTED_IMAGE_TYPES_LABEL,
} from "./prompt-attachment-limits.js";

export type ThreadDropState = "idle" | "valid" | "mixed" | "unsupported" | "unavailable" | "unknown";

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
  unknown: {
    title: "Drop will be checked before attaching",
    description: "The file metadata is unavailable until the drop is released.",
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
  if (fileItems.length === 0) return items.length === 0 ? "valid" : "unknown";
  const existing = Array.from({ length: existingCount }, (_, index) => ({
    mimeType: "image/png",
    size: index === 0 ? existingBytes : 0,
  }));
  const policy = selectAttachmentCandidates(fileItems, existing);
  const supported = policy.accepted.length > 0;
  const unknown = policy.rejected.some(({ reason }) => reason === "unknown-size");
  const unsupported = policy.rejected.some(({ reason }) => reason !== "unknown-size");
  if (unknown) return "unknown";
  if (supported && unsupported) return "mixed";
  return supported ? "valid" : "unsupported";
}

export const IMAGE_INPUT_UNAVAILABLE_MESSAGE = "Image attachments are unavailable for the active runtime.";
