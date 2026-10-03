import { useLayoutEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Dialog } from "../components/ui/Dialog";
import { useSheetDrag } from "./sheet-drag";
import "./sheet.css";

/**
 * A modal sheet from the bottom edge of a compact client: grip, title and a
 * close button on top, then `children`, which scroll on their own. It closes
 * with its X, Escape, the scrim or a pull down on the surface, including buttons.
 */
export function Sheet({ title, className, onClose, children }: {
  title: string;
  className?: string | undefined;
  onClose(): void;
  children: ReactNode;
}) {
  return <Dialog label={title} className={`touch-sheet${className ? ` ${className}` : ""}`} onClose={onClose}>
    <SheetBody title={title} onClose={onClose}>{children}</SheetBody>
  </Dialog>;
}

function SheetBody({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  // The dialog's own surface is what a pull moves.
  const sheet = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { sheet.current = body.current?.closest<HTMLElement>(".touch-sheet") ?? null; }, []);
  useSheetDrag(sheet, onClose);
  return <div ref={body} className="touch-sheet-body">
    <header className="touch-sheet-header">
      <span className="touch-sheet-grip" aria-hidden="true" />
      <strong>{title}</strong>
      <button type="button" className="touch-icon-button" aria-label="Close" onClick={onClose}><X size={18} /></button>
    </header>
    <div className="touch-sheet-content">{children}</div>
  </div>;
}
