import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { UiImagePreview, UiMessageImage } from "../../shared/contracts";
import { AttachmentImageDialog, type AttachmentImage } from "./AttachmentImageDialog";
import { localImagePaths } from "./MessageText";

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

function MessageImageGallery({ images }: { images: readonly AttachmentImage[] }) {
  const [contextMenu, setContextMenu] = useState<{ image: AttachmentImage; x: number; y: number }>();
  const contextTriggerRef = useRef<HTMLButtonElement>(null);
  if (images.length === 0) return null;

  const closeContextMenu = () => {
    contextTriggerRef.current?.focus();
    setContextMenu(undefined);
  };
  const openContextMenu = (button: HTMLButtonElement, image: AttachmentImage, x: number, y: number) => {
    contextTriggerRef.current = button;
    button.focus();
    setContextMenu({ image, x, y });
  };
  return <AttachmentImageDialog images={images}>{(open) =>
    <div className="message-images" data-image-count={images.length}>
      {images.map((image, index) => (
        <button
          className="message-image-button"
          key={image.key}
          type="button"
          aria-label={`Open image ${index + 1}`}
          aria-haspopup="menu"
          onClick={() => open(index)}
          onContextMenu={(event) => {
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
          <img src={image.src} alt={image.alt} />
        </button>
      ))}
      {contextMenu ? <ImageContextMenu
        key={`${contextMenu.image.key}-${contextMenu.x}-${contextMenu.y}`}
        x={contextMenu.x}
        y={contextMenu.y}
        onClose={closeContextMenu}
        onCopy={async () => {
          try {
            await window.tau?.copyImage(contextMenu.image.src);
          } finally {
            closeContextMenu();
          }
        }}
      /> : null}
    </div>
  }</AttachmentImageDialog>;
}

function ImageContextMenu({
  x,
  y,
  onClose,
  onCopy,
}: {
  x: number;
  y: number;
  onClose(): void;
  onCopy(): Promise<void>;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const menuItemRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ x, y });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const margin = 8;
    setPosition({
      x: Math.max(margin, Math.min(x, window.innerWidth - menu.offsetWidth - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - menu.offsetHeight - margin)),
    });
  }, [x, y]);

  useLayoutEffect(() => {
    menuItemRef.current?.focus();
  }, [x, y]);

  useEffect(() => {
    const closeFromOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", closeFromOutside);
    document.addEventListener("click", closeFromOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeFromOutside);
      document.removeEventListener("click", closeFromOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="message-image-context-menu"
      role="menu"
      aria-label="Image actions"
      style={{ left: position.x, top: position.y }}
    >
      <button
        ref={menuItemRef}
        type="button"
        role="menuitem"
        onClick={() => { void onCopy().catch(() => undefined); }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          void onCopy().catch(() => undefined);
        }}
      >
        Copy image
      </button>
    </div>,
    document.body,
  );
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
