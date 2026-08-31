import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type ReactNode } from "react";

export interface AttachmentImage {
  key: string;
  src: string;
  alt: string;
  label?: string;
}

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

/** Owns image-preview state and the accessible, viewport-level dialog. */
export function AttachmentImageDialog({
  images,
  children,
  portal = true,
}: {
  images: readonly AttachmentImage[];
  children(open: (index: number) => void): ReactNode;
  /** Composer keeps its established in-flow preview; message previews need a viewport portal. */
  portal?: boolean;
}) {
  const [previewIndex, setPreviewIndex] = useState<number>();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const preview = previewIndex === undefined ? undefined : images[previewIndex];

  useEffect(() => {
    if (!preview) return;
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const closeOnEscapeAndTrapFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreviewIndex(undefined);
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
      previouslyFocused.current?.focus();
      previouslyFocused.current = null;
    };
  }, [Boolean(preview)]);

  const dialog = preview ? (
      <div
        ref={dialogRef}
        className="attachment-lightbox"
        role="dialog"
        aria-modal="true"
        aria-label={preview.label ?? "Image preview"}
        onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewIndex(undefined); }}
        onClick={(event) => { if (event.target === event.currentTarget) setPreviewIndex(undefined); }}
      >
        <figure onClick={(event) => event.stopPropagation()}>
          <button ref={closeButtonRef} type="button" aria-label="Close preview" onClick={() => setPreviewIndex(undefined)}><X size={18} /></button>
          <img src={preview.src} alt={preview.alt} />
          {preview.label ? <figcaption>{preview.label}</figcaption> : null}
        </figure>
      </div>
    ) : null;

  return <>
    {children((index) => setPreviewIndex(index))}
    {portal && dialog ? createPortal(dialog, document.body) : dialog}
  </>;
}
