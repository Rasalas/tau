import type { UiPromptAttachment } from "../shared/contracts.js";
import {
  attachmentPolicyMessage,
  selectAttachmentCandidates,
} from "../shared/prompt-attachment-limits.js";

export interface PromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

/** Validate the untrusted renderer payload before it reaches Pi's prompt API. */
export function promptImages(attachments: readonly UiPromptAttachment[] = []): PromptImage[] {
  const candidates = attachments.map((attachment) => attachment.kind === "image"
    ? { ...attachment, name: undefined }
    : { ...attachment, mimeType: "", name: undefined });
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
