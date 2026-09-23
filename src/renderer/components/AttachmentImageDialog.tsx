import { useState, type ReactNode } from "react";
import { AttachmentLightbox } from "../deferred-surfaces";

export interface AttachmentImage {
  key: string;
  src: string;
  alt: string;
  label?: string;
}

/** Owns image-preview state; the dialog itself loads with its own chunk. */
export function AttachmentImageDialog({
  images,
  children,
}: {
  images: readonly AttachmentImage[];
  children(open: (index: number) => void): ReactNode;
}) {
  const [previewIndex, setPreviewIndex] = useState<number>();
  const preview = previewIndex === undefined ? undefined : images[previewIndex];
  return <>
    {children((index) => setPreviewIndex(index))}
    {preview ? <AttachmentLightbox preview={preview} onClose={() => setPreviewIndex(undefined)} /> : null}
  </>;
}
