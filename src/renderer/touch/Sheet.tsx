import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, X } from "lucide-react";
import { Dialog } from "../components/ui/Dialog";
import { useClientEnvironment } from "../client-environment";
import { useWorkspaceFileHistory } from "./use-workspace-file-history";
import { useSheetDrag } from "./sheet-drag";
import "./sheet.css";

/**
 * A modal sheet from the bottom edge of a compact client: grip, title and a
 * close button on top, then `children`, which scroll on their own. It closes
 * with its X, Escape, the scrim or a pull down on the surface, including buttons.
 */
export function Sheet({ title, className, onClose, children, headerActions, presentation = "sheet" }: {
  title: string;
  presentation?: "sheet" | "page";
  className?: string | undefined;
  onClose(): void;
  children: ReactNode;
  headerActions?: ReactNode;
}) {
  const { profile } = useClientEnvironment();
  const close = useWorkspaceFileHistory(title, onClose, profile === "compact");
  const content = <Dialog historyManaged label={title} className={`touch-sheet${presentation === "page" ? " mobile-page" : ""}${className ? ` ${className}` : ""}`} onClose={close}>
    <SheetBody headerActions={headerActions} page={presentation === "page"} title={title} onClose={close}>{children}</SheetBody>
  </Dialog>;
  return presentation === "page" ? createPortal(content, document.body) : content;
}

function SheetBody({ title, onClose, children, page, headerActions }: { headerActions?: ReactNode; page: boolean; title: string; onClose(): void; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  // The dialog's own surface is what a pull moves.
  const sheet = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { sheet.current = page ? null : body.current?.closest<HTMLElement>(".touch-sheet") ?? null; }, [page]);
  useSheetDrag(sheet, onClose);
  return <div ref={body} className="touch-sheet-body">
    <header className="touch-sheet-header">
      {page ? <button type="button" className="touch-icon-button" aria-label="Back" onClick={onClose}><ArrowLeft size={22} /></button> : <span className="touch-sheet-grip" aria-hidden="true" />}
      <strong>{title}</strong>
      {headerActions ? <div className="mobile-page-actions">{headerActions}</div> : null}
      {page ? null : <button type="button" className="touch-icon-button" aria-label="Close" onClick={onClose}><X size={18} /></button>}
    </header>
    <div className="touch-sheet-content">{children}</div>
  </div>;
}
