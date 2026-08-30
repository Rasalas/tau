import type { UiPromptAttachment } from "../shared/contracts.js";

const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface PromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

/** Validate the untrusted renderer payload before it reaches Pi's prompt API. */
export function promptImages(attachments: readonly UiPromptAttachment[] = []): PromptImage[] {
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(`Attach at most ${MAX_ATTACHMENTS} images.`);
  }
  let totalBytes = 0;
  return attachments.map((attachment) => {
    if (attachment.kind !== "image" || !IMAGE_MIME_TYPES.has(attachment.mimeType)) {
      throw new Error(`The attachment type ${attachment.mimeType || "unknown"} is not supported.`);
    }
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 1 || attachment.size > MAX_IMAGE_BYTES) {
      throw new Error(`Each image attachment must be 10 MB or smaller.`);
    }
    totalBytes += attachment.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Image attachments must total 24 MB or less.");
    if (!attachment.data || attachment.data.length > Math.ceil(attachment.size / 3) * 4 + 8) {
      throw new Error(`The attachment ${attachment.name || "image"} has an invalid payload.`);
    }
    return { type: "image", data: attachment.data, mimeType: attachment.mimeType };
  });
}
