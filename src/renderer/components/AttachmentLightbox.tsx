import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef } from "react";
import type { AttachmentImage } from "./AttachmentImageDialog";

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

/** The accessible, viewport-level preview of one image; focus comes back where it was when it closes. */
export function AttachmentLightbox({ preview, onClose }: { preview: AttachmentImage; onClose(): void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const closeOnEscapeAndTrapFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (activeIndex < 0) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && activeIndex === 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeIndex === focusable.length - 1) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscapeAndTrapFocus);
    return () => {
      window.removeEventListener("keydown", closeOnEscapeAndTrapFocus);
      previouslyFocused?.focus();
    };
  }, []);

  return createPortal(
    <div
      ref={dialogRef}
      className="attachment-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={preview.label ?? "Image preview"}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <figure onClick={(event) => event.stopPropagation()}>
        <button ref={closeButtonRef} type="button" aria-label="Close preview" onClick={onClose}><X size={18} /></button>
        <img src={preview.src} alt={preview.alt} />
        {preview.label ? <figcaption>{preview.label}</figcaption> : null}
      </figure>
    </div>,
    document.body,
  );
}
