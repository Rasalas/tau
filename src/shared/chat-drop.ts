import {
  IMAGE_MIME_TYPES,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_TYPES_LABEL,
} from "./prompt-attachment-limits.js";

export type ChatDropState = "idle" | "valid" | "mixed" | "unsupported" | "unavailable";

export interface ChatDropFeedback {
  title: string;
  description: string;
  dropEffect: "copy" | "none";
}

export const CHAT_DROP_FEEDBACK: Readonly<Record<ChatDropState, ChatDropFeedback>> = {
  idle: { title: "", description: "", dropEffect: "none" },
  valid: {
    title: "Drop images anywhere in chat",
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

export interface ChatDropItem {
  kind: string;
  mimeType: string;
}

/** Classify only file drag items; string items must not make a file drag invalid. */
export function classifyChatDrop(
  hasFilesSignal: boolean,
  items: readonly ChatDropItem[],
  supportsImageInput: boolean,
): ChatDropState {
  if (!hasFilesSignal) return "idle";
  if (!supportsImageInput) return "unavailable";
  const fileItems = items.filter((item) => item.kind === "file");
  if (fileItems.length === 0) return "valid";
  const supported = fileItems.some((item) => IMAGE_MIME_TYPES.has(item.mimeType.toLowerCase()));
  const unsupported = fileItems.some((item) => !item.mimeType || !IMAGE_MIME_TYPES.has(item.mimeType.toLowerCase()));
  if (supported && unsupported) return "mixed";
  return supported ? "valid" : "unsupported";
}

export const IMAGE_INPUT_UNAVAILABLE_MESSAGE = "Image attachments are unavailable for the active runtime.";
