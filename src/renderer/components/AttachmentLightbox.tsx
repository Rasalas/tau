import { ArrowDownToLine, ChevronLeft, ChevronRight, Copy, X } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type TouchEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import { usePlatform } from "../platform-context";
import { useClientEnvironment } from "../client-environment";
import { useWorkspaceFileHistory } from "../touch/use-workspace-file-history";
import type { AttachmentImage } from "./MessageImages";
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
  const { profile } = useClientEnvironment();
  const close = useWorkspaceFileHistory("image-preview", onClose, profile === "compact");
  const [index, setIndex] = useState(start);
  const [zoom, setZoom] = useState(FIT);
  const [size, setSize] = useState<string>();
  const pinch = useRef<{ distance: number; scale: number } | undefined>(undefined);
  const image = images[index];
  if (!image) return null;
  const count = images.length;
  const name = image.label ?? image.alt;
  const go = (to: number) => {
    pinch.current = undefined;
    setIndex((to + count) % count);
    setZoom(FIT);
    setSize(undefined);
  };
  const touchDistance = (event: TouchEvent) => {
    const [a, b] = Array.from(event.touches);
    return a && b ? Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) : undefined;
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
    const x = box.width ? ((event.clientX - box.left) / box.width) * 100 : 50;
    const y = box.height ? ((event.clientY - box.top) / box.height) * 100 : 50;
    setZoom((current) => {
      const scale = Math.min(6, Math.max(1, current.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
      return current.scale === 1 ? { scale, x, y } : { ...current, scale };
    });
  };
  const nav = count > 1;

  return createPortal(
    <Dialog label={image.label ?? "Image preview"} className="attachment-lightbox" onClose={close}>
      <div className="lightbox-body" onKeyDown={onKeyDown}>
        <header className="lightbox-head">
          <strong>{name}</strong>
          <span>{[nav ? `${String(index + 1)} of ${String(count)}` : "", size, origin].filter(Boolean).join(" · ")}</span>
          {platform.clipboard.writeImage ? (
            <button type="button" className="lightbox-action" onClick={() => void platform.clipboard.writeImage?.(image.src)}><Copy size={12} />Copy</button>
          ) : null}
          <a className="lightbox-action" href={image.src} download={name}><ArrowDownToLine size={12} />Save</a>
          {zoom.scale > 1 ? <button type="button" className="lightbox-action" onClick={() => setZoom(FIT)}>Fit</button> : null}
          <button type="button" className="lightbox-close" aria-label="Close preview" autoFocus onClick={close}><X size={20} /></button>
        </header>
        <div className="lightbox-stage" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
          <img
            src={image.src}
            alt={image.alt}
            style={zoom.scale === 1 ? undefined : { transform: `scale(${String(zoom.scale)})`, transformOrigin: `${String(zoom.x)}% ${String(zoom.y)}%` }}
            onLoad={(event) => setSize(`${String(event.currentTarget.naturalWidth)}×${String(event.currentTarget.naturalHeight)}`)}
            onWheel={onWheel}
            onTouchStart={(event) => {
              const distance = touchDistance(event);
              if (distance) pinch.current = { distance, scale: zoom.scale };
            }}
            onTouchMove={(event) => {
              const distance = touchDistance(event);
              if (!distance || !pinch.current) return;
              const scale = Math.min(6, Math.max(1, pinch.current.scale * distance / pinch.current.distance));
              setZoom({ ...FIT, scale });
            }}
            onTouchEnd={() => { pinch.current = undefined; }}
            onTouchCancel={() => { pinch.current = undefined; }}
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
          <span>{profile === "compact" ? "Pinch to zoom · tap outside to close" : `${nav ? "← → · " : ""}scroll to zoom · ⎋ close`}</span>
        </footer>
      </div>
    </Dialog>,
    document.body,
  );
}
