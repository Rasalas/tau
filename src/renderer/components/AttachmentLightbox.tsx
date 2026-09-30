import { ChevronLeft, ChevronRight, Copy, Download, X } from "lucide-react";
import { useState, type KeyboardEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import { usePlatform } from "../platform-context";
import type { AttachmentImage } from "./AttachmentImageDialog";
import { Dialog } from "./ui/Dialog";
import "./attachment-lightbox.css";

const FIT = { scale: 1, x: 50, y: 50 };

/** Every image of a message or a draft, one at a time, always on a dark ground; focus returns where it was. */
export function AttachmentLightbox({ images, index: start, origin, onClose }: {
  images: readonly AttachmentImage[];
  index: number;
  /** Where the images come from, e.g. "from your message". */
  origin?: string;
  onClose(): void;
}) {
  const platform = usePlatform();
  const [index, setIndex] = useState(start);
  const [zoom, setZoom] = useState(FIT);
  const [size, setSize] = useState<string>();
  const image = images[index];
  if (!image) return null;
  const count = images.length;
  const name = image.label ?? image.alt;
  const go = (to: number) => {
    setIndex((to + count) % count);
    setZoom(FIT);
    setSize(undefined);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!step || count < 2) return;
    event.preventDefault();
    go(index + step);
  };
  // Zooms toward the pointer; back at 1 the picture fits again.
  const onWheel = (event: WheelEvent<HTMLImageElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(6, Math.max(1, zoom.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
    setZoom(zoom.scale === 1 ? { scale, x: ((event.clientX - box.left) / box.width) * 100, y: ((event.clientY - box.top) / box.height) * 100 } : { ...zoom, scale });
  };
  const save = () => {
    const link = document.createElement("a");
    link.href = image.src;
    link.download = name;
    link.click();
  };
  const nav = count > 1;

  return createPortal(
    <Dialog label={image.label ?? "Image preview"} className="attachment-lightbox" onClose={onClose}>
      <div className="lightbox-body" onKeyDown={onKeyDown}>
        <header className="lightbox-head">
          <strong>{name}</strong>
          <span>{[nav ? `${String(index + 1)} of ${String(count)}` : "", size, origin].filter(Boolean).join(" · ")}</span>
          {platform.clipboard.writeImage ? (
            <button type="button" className="lightbox-action" onClick={() => void platform.clipboard.writeImage?.(image.src)}><Copy size={12} />Copy</button>
          ) : null}
          <button type="button" className="lightbox-action" onClick={save}><Download size={12} />Save</button>
          <button type="button" className="lightbox-close" aria-label="Close preview" autoFocus onClick={onClose}><X size={13} /></button>
        </header>
        <div className="lightbox-stage">
          <img
            src={image.src}
            alt={image.alt}
            style={zoom.scale === 1 ? undefined : { transform: `scale(${String(zoom.scale)})`, transformOrigin: `${String(zoom.x)}% ${String(zoom.y)}%` }}
            onLoad={(event) => setSize(`${String(event.currentTarget.naturalWidth)}×${String(event.currentTarget.naturalHeight)}`)}
            onWheel={onWheel}
          />
          {nav ? <>
            <button type="button" className="lightbox-nav" aria-label="Previous image" onClick={() => go(index - 1)}><ChevronLeft size={18} /></button>
            <button type="button" className="lightbox-nav next" aria-label="Next image" onClick={() => go(index + 1)}><ChevronRight size={18} /></button>
          </> : null}
        </div>
        <footer className="lightbox-foot">
          {nav ? images.map((entry, position) => (
            <button key={entry.key} type="button" className="lightbox-thumb" aria-label={`Image ${String(position + 1)}`} aria-current={position === index || undefined} onClick={() => go(position)}>
              <img src={entry.src} alt="" />
            </button>
          )) : null}
          <span>{nav ? "← → · " : ""}scroll to zoom · ⎋ close</span>
        </footer>
      </div>
    </Dialog>,
    document.body,
  );
}
