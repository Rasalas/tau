/** Shared bounds for image attachments accepted by the composer and host. */
export const MAX_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;
/** A `kind: "file"` prompt attachment; the host never reads more than this per file. */
export const MAX_FILE_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const SUPPORTED_IMAGE_TYPES_LABEL = "PNG, JPEG, GIF, or WebP";

export const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export interface AttachmentMetadata {
  name?: string;
  mimeType: string;
  size?: number;
}

export type AttachmentPolicyReason = "unsupported-type" | "invalid-size" | "unknown-size" | "total-size" | "too-many";

export interface AttachmentPolicyRejection<T extends AttachmentMetadata> {
  item: T;
  reason: AttachmentPolicyReason;
}

export interface AttachmentPolicyResult<T extends AttachmentMetadata> {
  accepted: T[];
  rejected: AttachmentPolicyRejection<T>[];
}

/** Select valid attachments without mutating input; callers can report rejections. */
export function selectAttachmentCandidates<T extends AttachmentMetadata>(
  items: readonly T[],
  existing: readonly AttachmentMetadata[] = [],
): AttachmentPolicyResult<T> {
  const accepted: T[] = [];
  const rejected: AttachmentPolicyRejection<T>[] = [];
  let totalBytes = existing.reduce((total, item) => total + (item.size ?? 0), 0);
  for (const item of items) {
    let reason: AttachmentPolicyReason | undefined;
    if (!IMAGE_MIME_TYPES.has(item.mimeType.toLowerCase())) reason = "unsupported-type";
    else if (item.size === undefined) reason = "unknown-size";
    else if (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_IMAGE_BYTES) reason = "invalid-size";
    else if (existing.length + accepted.length >= MAX_ATTACHMENTS) reason = "too-many";
    else if (totalBytes + item.size > MAX_TOTAL_IMAGE_BYTES) reason = "total-size";
    if (reason) rejected.push({ item, reason });
    else {
      accepted.push(item);
      totalBytes += item.size ?? 0;
    }
  }
  return { accepted, rejected };
}

export function attachmentPolicyMessage<T extends AttachmentMetadata>(rejection: AttachmentPolicyRejection<T>): string {
  switch (rejection.reason) {
    case "unsupported-type":
      return rejection.item.name
        ? `${rejection.item.name} is not a supported ${SUPPORTED_IMAGE_TYPES_LABEL} image.`
        : `The attachment type ${rejection.item.mimeType || "unknown"} is not supported.`;
    case "invalid-size":
      return rejection.item.name
        ? `${rejection.item.name} must be ${MAX_IMAGE_BYTES / 1024 / 1024} MB or smaller.`
        : `Each image attachment must be ${MAX_IMAGE_BYTES / 1024 / 1024} MB or smaller.`;
    case "unknown-size": return "The file size is unavailable until the drop is released.";
    case "total-size": return `Image attachments must total ${MAX_TOTAL_IMAGE_BYTES / 1024 / 1024} MB or less.`;
    case "too-many": return `Attach at most ${MAX_ATTACHMENTS} images.`;
  }
}
