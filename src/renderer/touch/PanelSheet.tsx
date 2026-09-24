import { useRef } from "react";
import { X } from "lucide-react";
import { PanelSlot } from "../components/PanelHosts";
import { useFocusReturn } from "../components/ui/focus";
import { useSheetDrag } from "./sheet-drag";

/**
 * A panel that claims `compact`, drawn over the thread on a compact layout.
 * The panel keeps its one host element, so closing the sheet and opening it
 * again finds the panel as it was left. A pull down closes it once the
 * panel's own scroll is at the top.
 */
export function PanelSheet({ label, host, onClose }: { label: string; host: HTMLElement; onClose(): void }) {
  const surface = useRef<HTMLElement>(null);
  useFocusReturn(true, surface);
  useSheetDrag(surface, onClose);
  return <section ref={surface} className="touch-panel-sheet" role="dialog" aria-label={label} tabIndex={-1}>
    <header className="touch-sheet-header">
      <span className="touch-sheet-grip" aria-hidden="true" />
      <strong>{label}</strong>
      <button type="button" className="touch-icon-button" aria-label={`Close ${label}`} onClick={onClose}><X size={18} /></button>
    </header>
    <PanelSlot host={host} />
  </section>;
}
