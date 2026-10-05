import { ArrowDownToLine, ChevronLeft, ChevronRight, Copy, Play, Maximize, Minus, Plus, X } from "lucide-react";
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
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [swipe, setSwipe] = useState(0);
  const gesture = useRef<{ x: number; y: number; px: number; py: number } | undefined>(undefined);
  const lastTap = useRef(0);
  const fit = () => { setZoom(FIT); setPan({ x: 0, y: 0 }); };
  const scaleBy = (factor: number) => setZoom((current) => ({ ...current, scale: Math.min(6, Math.max(1, current.scale * factor)) }));
  const pinch = useRef<{ distance: number; scale: number } | undefined>(undefined);
  const image = images[index];
  if (!image) return null;
  const video = image.kind === "video";
  const count = images.length;
  const name = image.label ?? image.alt;
  const go = (to: number) => {
    pinch.current = undefined;
    setIndex((to + count) % count);
    fit();
    setSwipe(0);
    setSize(undefined);
  };
  const touchDistance = (event: TouchEvent) => {
    const [a, b] = Array.from(event.touches);
    return a && b ? Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) : undefined;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement).tagName === "VIDEO") return;
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
    <Dialog label={image.label ?? (video ? "Video preview" : "Image preview")} className="attachment-lightbox" onClose={close}>
      <div className="lightbox-body" onKeyDown={onKeyDown}>
        <header className="lightbox-head">
          <strong>{name}</strong>
          <span>{[nav ? `${String(index + 1)} of ${String(count)}` : "", size, origin].filter(Boolean).join(" · ")}</span>
          {!video ? <div className="lightbox-zoom-controls">
            <button type="button" className="lightbox-action" aria-label="Zoom out" title="Zoom out" disabled={zoom.scale <= 1} onClick={() => scaleBy(1 / 1.25)}><Minus size={16} /></button>
            <span className="lightbox-zoom-value">{Math.round(zoom.scale * 100)}%</span>
            <button type="button" className="lightbox-action" aria-label="Zoom in" title="Zoom in" disabled={zoom.scale >= 6} onClick={() => scaleBy(1.25)}><Plus size={16} /></button>
          </div> : null}
          {!video && platform.clipboard.writeImage ? (
            <button type="button" className="lightbox-action lightbox-copy" aria-label="Copy image" title="Copy image" onClick={() => void platform.clipboard.writeImage?.(image.src)}><Copy size={16} /></button>
          ) : null}
          <a className="lightbox-action" aria-label="Save media" title="Save media" href={image.src} download={name}><ArrowDownToLine size={16} /></a>
          {zoom.scale > 1 ? <button type="button" className="lightbox-action" aria-label="Fit" title="Fit to window" onClick={fit}><Maximize size={16} /></button> : null}
          <button type="button" className="lightbox-close" aria-label="Close preview" autoFocus onClick={close}><X size={20} /></button>
        </header>
        <div className="lightbox-stage" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
          {video ? <video key={image.key} src={image.src} controls playsInline preload="metadata" aria-label={image.alt} /> : <img
            key={image.key}
            src={image.src}
            alt={image.alt}
            draggable={false}
            style={{ ...(zoom.scale > 1 ? { transform: `${pan.x || pan.y ? `translate(${pan.x}px, ${pan.y}px) ` : ""}scale(${zoom.scale})`, transformOrigin: `${zoom.x}% ${zoom.y}%`, cursor: "grab" } : swipe ? { transform: `translateY(${swipe}px)`, opacity: Math.max(.25, 1 - swipe / 400) } : {}) }}
            onDoubleClick={() => { if (profile === "compact") return; if (zoom.scale > 1) fit(); else setZoom({ ...FIT, scale: 2.5 }); }}
            onPointerDown={(event) => {
              if (event.pointerType !== "mouse" || zoom.scale <= 1) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              gesture.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y };
            }}
            onPointerMove={(event) => {
              if (event.pointerType !== "mouse" || !gesture.current || !event.buttons) return;
              setPan({ x: gesture.current.px + event.clientX - gesture.current.x, y: gesture.current.py + event.clientY - gesture.current.y });
            }}
            onPointerUp={(event) => { if (event.pointerType === "mouse") gesture.current = undefined; }}
            onLoad={(event) => setSize(`${String(event.currentTarget.naturalWidth)}×${String(event.currentTarget.naturalHeight)}`)}
            onWheel={onWheel}
            onTouchStart={(event) => {
              const distance = touchDistance(event);
              if (distance) { pinch.current = { distance, scale: zoom.scale }; gesture.current = undefined; }
              else if (event.touches[0]) { const touch = event.touches[0]; gesture.current = { x: touch.clientX, y: touch.clientY, px: pan.x, py: pan.y }; }
            }}
            onTouchMove={(event) => {
              const distance = touchDistance(event);
              if (!distance || !pinch.current) {
                const touch = event.touches[0], began = gesture.current;
                if (touch && began) {
                  if (zoom.scale > 1) setPan({ x: began.px + touch.clientX - began.x, y: began.py + touch.clientY - began.y });
                  else setSwipe(Math.max(0, touch.clientY - began.y));
                }
                return;
              }
              const scale = Math.min(6, Math.max(1, pinch.current.scale * distance / pinch.current.distance));
              setZoom({ ...FIT, scale });
            }}
            onTouchEnd={(event) => {
              const touch = event.changedTouches[0], began = gesture.current;
              if (touch && began && !pinch.current) {
                const dx = touch.clientX - began.x, dy = touch.clientY - began.y;
                if (zoom.scale === 1 && dy > 90 && dy > Math.abs(dx)) close();
                else if (zoom.scale === 1 && Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) && nav) go(index + (dx < 0 ? 1 : -1));
                else if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
                  const now = Date.now();
                  if (now - lastTap.current < 300) { if (zoom.scale > 1) fit(); else setZoom({ ...FIT, scale: 2.5 }); lastTap.current = 0; }
                  else lastTap.current = now;
                }
              }
              gesture.current = undefined; pinch.current = undefined; setSwipe(0);
            }}
            onTouchCancel={() => { pinch.current = undefined; gesture.current = undefined; setSwipe(0); }}
          />}
          {nav ? <>
            <button type="button" className="lightbox-nav" aria-label="Previous media" onClick={() => go(index - 1)}><ChevronLeft size={18} /></button>
            <button type="button" className="lightbox-nav next" aria-label="Next media" onClick={() => go(index + 1)}><ChevronRight size={18} /></button>
          </> : null}
        </div>
        <footer className="lightbox-foot">
          {nav ? images.map((entry, position) => (
            <button key={entry.key} type="button" className="lightbox-thumb" aria-label={`${entry.kind === "video" ? "Video" : "Image"} ${String(position + 1)}`} aria-current={position === index || undefined} onClick={() => go(position)}>
              {entry.kind === "video" ? <Play size={18} /> : <img src={entry.src} alt="" />}
            </button>
          )) : null}
          <span>{video ? (profile === "compact" ? "Tap outside to close" : "⎋ close") : profile === "compact" ? "Double-tap to zoom · swipe down to close" : `${nav ? "← → · " : ""}scroll to zoom · ⎋ close`}</span>
        </footer>
      </div>
    </Dialog>,
    document.body,
  );
}
