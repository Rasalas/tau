import { X } from "lucide-react";
import type { PendingAttachment } from "../../workbench/composer-scope-store";
import { allocateAttachmentId } from "../../workbench/composer-scope-store";
import { AttachmentImageDialog } from "./AttachmentImageDialog";

export function readImage(file: File): Promise<PendingAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.onload = () => {
      const previewUrl = typeof reader.result === "string" ? reader.result : "";
      const separator = previewUrl.indexOf(",");
      if (separator < 0) {
        reject(new Error(`${file.name} could not be decoded.`));
        return;
      }
      resolve({
        id: allocateAttachmentId(),
        kind: "image",
        name: file.name,
        mimeType: file.type,
        data: previewUrl.slice(separator + 1),
        size: file.size,
        previewUrl,
      });
    };
    reader.readAsDataURL(file);
  });
}

export interface ComposerAttachmentsListProps {
  attachments: readonly PendingAttachment[];
  onPreview(id: number): void;
  onRemove(id: number): void;
}

export function ComposerAttachmentsList({
  attachments,
  onPreview,
  onRemove,
}: ComposerAttachmentsListProps) {
  if (attachments.length === 0) return null;
  return (
    <div className="composer-attachments" aria-label="Attached files">
      {attachments.map((attachment) => (
        <div className="composer-attachment" key={attachment.id}>
          <button
            className="attachment-preview-button"
            aria-label={`Preview ${attachment.name}`}
            onClick={() => onPreview(attachment.id)}
          >
            <img src={attachment.previewUrl} alt="" />
          </button>
          <button
            className="attachment-remove"
            aria-label={`Remove ${attachment.name}`}
            onClick={() => onRemove(attachment.id)}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

export { AttachmentImageDialog };
