import { isAbsolute } from "node:path";
import type { UiPromptAttachment, UiPromptFileAttachment, UiPromptImageAttachment } from "../shared/contracts.js";
import {
  attachmentPolicyMessage,
  MAX_FILE_ATTACHMENT_BYTES,
  selectAttachmentCandidates,
} from "../shared/prompt-attachment-limits.js";

export interface PromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

const isImage = (attachment: UiPromptAttachment): attachment is UiPromptImageAttachment => attachment.kind === "image";
const isFile = (attachment: UiPromptAttachment): attachment is UiPromptFileAttachment => attachment.kind === "file";

/** Validate the untrusted renderer payload before it reaches Pi's prompt API. */
export function promptImages(attachments: readonly UiPromptAttachment[] = []): PromptImage[] {
  const candidates = attachments.filter(isImage).map((attachment) => ({ ...attachment, name: undefined }));
  const policy = selectAttachmentCandidates(candidates);
  const rejection = policy.rejected[0];
  if (rejection) throw new Error(attachmentPolicyMessage(rejection));
  return policy.accepted.map((attachment) => {
    if (!attachment.data || attachment.data.length > Math.ceil(attachment.size / 3) * 4 + 8) {
      throw new Error(`The attachment ${attachment.name || "image"} has an invalid payload.`);
    }
    return { type: "image", data: attachment.data, mimeType: attachment.mimeType };
  });
}

/** The file attachments of a prompt, checked for shape; the runtime reads them from disk. */
export function promptFiles(attachments: readonly UiPromptAttachment[] = []): UiPromptFileAttachment[] {
  const files = attachments.filter(isFile);
  for (const file of files) {
    if (!isAbsolute(file.path)) throw new Error(`The attachment ${file.name} does not name an absolute path.`);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_ATTACHMENT_BYTES) {
      throw new Error(`${file.name} must be ${MAX_FILE_ATTACHMENT_BYTES / 1024 / 1024} MB or smaller.`);
    }
  }
  return files;
}
