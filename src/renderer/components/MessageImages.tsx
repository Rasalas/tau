import { useMediaGallery } from "./MediaGallery";
import { Play } from "lucide-react";
import { MediaLinkContext } from "./media-link-context";
import { useContext, useEffect, useState } from "react";
import type { UiImagePreview, UiMessageImage } from "../../shared/contracts";
import type { HostClient } from "../../workbench/host-client";
import { useHostClient } from "../host-client-context";
import { usePlatform } from "../platform-context";
import { AttachmentLightbox, Menu } from "../deferred-surfaces";
import { localImagePaths } from "./MessageText";

export interface AttachmentImage {
  kind?: "image" | "video";
  key: string;
  src: string;
  alt: string;
  label?: string;
}

const imagePreviewCache = new Map<string, Promise<UiImagePreview | undefined>>();

function cachedImagePreview(client: HostClient, path: string): Promise<UiImagePreview | undefined> {
  const cached = imagePreviewCache.get(path);
  if (cached) return cached;
  if (imagePreviewCache.size >= 8) imagePreviewCache.delete(imagePreviewCache.keys().next().value as string);
  const request = client.readImagePreview(path).catch((error) => {
    imagePreviewCache.delete(path);
    throw error;
  });
  imagePreviewCache.set(path, request);
  return request;
}

export function MessageImageGallery({ images, origin = "from your message" }: { images: readonly AttachmentImage[]; origin?: string }) {
  const platform = usePlatform();
  const linked = useContext(MediaLinkContext);
  const [contextMenu, setContextMenu] = useState<{ image: AttachmentImage; x: number; y: number }>();
  const gallery = useMediaGallery(images, !linked);
  const [shown, setShown] = useState<number>();
  if (images.length === 0) return null;
  if (linked) return <>{images.map((image) => image.kind === "video" ? <video key={image.key} src={image.src} muted playsInline preload="metadata" aria-label={image.alt} /> : <img key={image.key} src={image.src} alt={image.alt} />)}</>;

  // The menu gives focus back to the button it was opened from.
  const openContextMenu = (button: HTMLButtonElement, image: AttachmentImage, x: number, y: number) => {
    button.focus();
    setContextMenu({ image, x, y });
  };
  return (
    <span ref={gallery.ref} className="message-images" data-image-count={images.length} data-origin={origin === "from your message" ? "user" : "conversation"}>
      {images.map((image, index) => (
        <button
          className="message-image-button"
          data-kind={image.kind || "image"}
          key={image.key}
          type="button"
          aria-label={`Open ${image.kind === "video" ? "video" : "image"} ${index + 1}`}
          aria-haspopup="menu"
          onClick={() => gallery.open ? gallery.open(index) : setShown(index)}
          onContextMenu={(event) => {
            if (image.kind === "video") return;
            event.preventDefault();
            event.stopPropagation();
            openContextMenu(event.currentTarget, image, event.clientX, event.clientY);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && event.key !== "Apps" && !(event.key === "F10" && event.shiftKey)) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            openContextMenu(event.currentTarget, image, rect.right, rect.bottom);
          }}
        >
          {image.kind === "video" ? <><video src={image.src} preload="metadata" muted playsInline aria-label={image.alt} /><span className="media-preview-play"><Play size={22} fill="currentColor" /></span></> : <img src={image.src} alt={image.alt} />}
        </button>
      ))}
      {contextMenu ? <Menu
        at={contextMenu}
        label="Image actions"
        items={[{ id: "copy", label: "Copy image" }]}
        onSelect={() => { void platform.clipboard.writeImage?.(contextMenu.image.src)?.catch(() => undefined); }}
        onClose={() => setContextMenu(undefined)}
      /> : null}
      {shown !== undefined && images[shown] ? <AttachmentLightbox images={images} index={shown} origin={origin} onClose={() => setShown(undefined)} /> : null}
    </span>
  );
}

export function PersistedMessageImages({ images, text = "" }: { images: readonly UiMessageImage[]; text?: string }) {
  // Pi keeps no file names; the composer wrote them into the text, one per image, in order.
  const names = text.match(/\S+\.(?:png|jpe?g|gif|webp)\b/giu) ?? [];
  return <MessageImageGallery images={images.map((image, index) => ({
    key: `${index}-${image.mimeType}-${image.data.slice(0, 16)}`,
    src: `data:${image.mimeType};base64,${image.data}`,
    alt: "Attached image",
    ...(names.length === images.length ? { label: names[index] } : {}),
  }))} />;
}

export function MessageImages({ text }: { text: string }) {
  const client = useHostClient();
  const [previews, setPreviews] = useState<UiImagePreview[]>([]);
  useEffect(() => {
    const paths = localImagePaths(text);
    if (paths.length === 0 || !client) {
      setPreviews([]);
      return;
    }
    let active = true;
    void Promise.all(paths.map((path) => cachedImagePreview(client, path)))
      .then((images) => { if (active) setPreviews(images.filter((image): image is UiImagePreview => Boolean(image))); })
      .catch(() => { if (active) setPreviews([]); });
    return () => { active = false; };
  }, [client, text]);
  if (previews.length === 0) return null;
  return <MessageImageGallery images={previews.map((image) => ({ key: image.name, src: image.dataUrl, alt: image.name }))} />;
}
