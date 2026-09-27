import { useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { tooltipProps } from "../components/ui/Tooltip";
import "./pairing.css";

/** The X at a dialog's top right. Put it last, so the dialog's first field still gets focus. */
export function DialogClose({ onClose, label = "Close" }: { onClose(): void; label?: string }) {
  return (
    <button type="button" className="tau-icon-button dialog-close" aria-label={label} {...tooltipProps(label)} onClick={onClose}>
      <X size={16} />
    </button>
  );
}

/** A dialog field's value, also readable in the keystroke that wrote it: a text field commits on Enter just before the dialog submits. */
export function useFieldValue<T>(initial: T): readonly [T, (next: T) => void, { readonly current: T }] {
  const [value, setValue] = useState(initial);
  const latest = useRef(initial);
  return [value, (next: T) => { latest.current = next; setValue(next); }, latest] as const;
}

/** Enter in a dialog's text field submits it, as a form would. */
export function submitOnEnter(submit: () => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement) || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };
}
