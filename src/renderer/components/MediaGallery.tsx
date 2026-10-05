import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AttachmentLightbox } from "../deferred-surfaces";
import type { AttachmentImage } from "./MessageImages";

type Entry = { element: HTMLElement; images: readonly AttachmentImage[] };
type Selection = { images: readonly AttachmentImage[]; index: number };
const GalleryContext = createContext<{
  register(entry: Entry): () => void;
  open(element: HTMLElement, index: number): void;
} | undefined>(undefined);

/** Loaded inline media share one gallery, in document order, within this message. */
export function MediaGallery({ children }: { children: ReactNode }) {
  const entries = useRef(new Set<Entry>());
  const [selection, setSelection] = useState<Selection>();
  const gallery = useMemo(() => ({
    register(entry: Entry) {
      entries.current.add(entry);
      return () => { entries.current.delete(entry); };
    },
    open(element: HTMLElement, index: number) {
      const ordered = [...entries.current].filter((entry) => entry.element.isConnected).sort((a, b) =>
        a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
      const images: AttachmentImage[] = [];
      let selected = 0;
      for (const entry of ordered) {
        if (entry.element === element) selected = images.length + index;
        for (const image of entry.images) images.push({ ...image, key: `${images.length}:${image.key}` });
      }
      if (images.length) setSelection({ images, index: selected });
    },
  }), []);
  return <GalleryContext.Provider value={gallery}>{children}{selection ? <AttachmentLightbox images={selection.images} index={selection.index} origin="from this message" onClose={() => setSelection(undefined)} /> : null}</GalleryContext.Provider>;
}

/** Standalone attachments retain their own gallery outside a Markdown message. */
export function useMediaGallery(images: readonly AttachmentImage[], enabled = true) {
  const gallery = useContext(GalleryContext);
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (enabled && gallery && ref.current) return gallery.register({ element: ref.current, images });
  }, [enabled, gallery, images]);
  return { ref, open: gallery && enabled ? (index: number) => { if (ref.current) gallery.open(ref.current, index); } : undefined };
}
