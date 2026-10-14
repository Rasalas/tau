import type { PendingAttachment } from "../../workbench/composer-scope-store";
import { allocateAttachmentId } from "../../workbench/composer-scope-store";

const MAX_IMAGE_EDGE = 2000;

async function fitImage(file: File, dataUrl: string): Promise<Blob> {
  if (file.type !== "image/png" && file.type !== "image/jpeg") return file;
  if (file.type === "image/png") {
    // PNG dimensions live in its fixed header; fitting images need no bitmap allocation.
    const start = dataUrl.indexOf(",") + 1;
    const header = Uint8Array.from(atob(dataUrl.slice(start, start + 32)), (byte) => byte.charCodeAt(0));
    if (header.length < 24) return file;
    const view = new DataView(header.buffer);
    if (Math.max(view.getUint32(16), view.getUint32(20)) <= MAX_IMAGE_EDGE) return file;
  }
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const edge = Math.max(bitmap.width, bitmap.height);
    if (edge <= MAX_IMAGE_EDGE) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * MAX_IMAGE_EDGE / edge));
    canvas.height = Math.max(1, Math.round(bitmap.height * MAX_IMAGE_EDGE / edge));
    const context = canvas.getContext("2d");
    if (!context) throw new Error(`${file.name} could not be resized.`);
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error(`${file.name} could not be resized.`)), file.type);
    });
  } finally {
    bitmap.close();
  }
}

function readDataUrl(file: Blob, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${name} could not be read.`));
    reader.onload = () => {
      const previewUrl = typeof reader.result === "string" ? reader.result : "";
      const separator = previewUrl.indexOf(",");
      if (separator < 0) {
        reject(new Error(`${name} could not be decoded.`));
        return;
      }
      resolve(previewUrl);
    };
    reader.readAsDataURL(file);
  });
}

export async function readImage(file: File): Promise<PendingAttachment> {
  const originalUrl = await readDataUrl(file, file.name);
  const fitted = await fitImage(file, originalUrl);
  const previewUrl = fitted === file ? originalUrl : await readDataUrl(fitted, file.name);
  return {
    id: allocateAttachmentId(),
    kind: "image",
    name: file.name,
    mimeType: fitted.type,
    data: previewUrl.slice(previewUrl.indexOf(",") + 1),
    size: fitted.size,
    previewUrl,
  };
}

