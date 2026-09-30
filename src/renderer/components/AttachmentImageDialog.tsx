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
  origin,
  children,
}: {
  images: readonly AttachmentImage[];
  origin?: string;
  children(open: (index: number) => void): ReactNode;
}) {
  const [previewIndex, setPreviewIndex] = useState<number>();
  return <>
    {children((index) => setPreviewIndex(index))}
    {previewIndex !== undefined && images[previewIndex] ? <AttachmentLightbox images={images} index={previewIndex} origin={origin} onClose={() => setPreviewIndex(undefined)} /> : null}
  </>;
}
