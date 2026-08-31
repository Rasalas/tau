import { useEffect, useState } from "react";
import type { UiImagePreview, UiMessageImage } from "../../shared/contracts";
import { AttachmentImageDialog, type AttachmentImage } from "./AttachmentImageDialog";

const LOCAL_IMAGE_PATH = /(\/(?:(?:\\ )|[^\s'"<>])+?\.(?:png|jpe?g|gif|webp))(?=\s|$|[),;])/giu;

export function localImagePaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(LOCAL_IMAGE_PATH)) {
    const path = match[1].replaceAll("\\ ", " ");
    if (!paths.includes(path)) paths.push(path);
    if (paths.length === 4) break;
  }
  return paths;
}

export function withoutLocalImagePaths(text: string): string {
  return text.replace(LOCAL_IMAGE_PATH, "").replace(/^[ \t]+|[ \t]+$/gmu, "").trim();
}

const imagePreviewCache = new Map<string, Promise<UiImagePreview | undefined>>();

function cachedImagePreview(path: string): Promise<UiImagePreview | undefined> {
  const cached = imagePreviewCache.get(path);
  if (cached) return cached;
  if (imagePreviewCache.size >= 8) imagePreviewCache.delete(imagePreviewCache.keys().next().value as string);
  const request = window.tau!.readImagePreview(path).catch((error) => {
    imagePreviewCache.delete(path);
    throw error;
  });
  imagePreviewCache.set(path, request);
  return request;
}

export function MessageImageGallery({ images }: { images: readonly AttachmentImage[] }) {
  if (images.length === 0) return null;
  return <AttachmentImageDialog images={images}>{(open) =>
    <div className="message-images">
      {images.map((image, index) => (
        <button
          className="message-image-button"
          key={image.key}
          type="button"
          aria-label={`Open image ${index + 1}`}
          onClick={() => open(index)}
        >
          <img src={image.src} alt={image.alt} />
        </button>
      ))}
    </div>
  }</AttachmentImageDialog>;
}

export function PersistedMessageImages({ images }: { images: readonly UiMessageImage[] }) {
  return <MessageImageGallery images={images.map((image, index) => ({
    key: `${index}-${image.mimeType}-${image.data.slice(0, 16)}`,
    src: `data:${image.mimeType};base64,${image.data}`,
    alt: "Attached image",
  }))} />;
}

export function MessageImages({ text }: { text: string }) {
  const [previews, setPreviews] = useState<UiImagePreview[]>([]);
  useEffect(() => {
    const paths = localImagePaths(text);
    if (paths.length === 0 || !window.tau) {
      setPreviews([]);
      return;
    }
    let active = true;
    void Promise.all(paths.map(cachedImagePreview))
      .then((images) => { if (active) setPreviews(images.filter((image): image is UiImagePreview => Boolean(image))); })
      .catch(() => { if (active) setPreviews([]); });
    return () => { active = false; };
  }, [text]);
  if (previews.length === 0) return null;
  return <MessageImageGallery images={previews.map((image) => ({ key: image.name, src: image.dataUrl, alt: image.name }))} />;
}
