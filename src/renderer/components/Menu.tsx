import { useEffect, type ReactNode } from "react";

export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  selected?: boolean;
}

/**
 * Popover list anchored to its trigger. The scrim sits under the menu and
 * closes it, so a click outside never also activates what is underneath.
 */
export function Menu({
  placement = "below",
  align,
  items,
  heading,
  footer,
  onSelect,
  onClose,
}: {
  placement?: "below" | "above";
  align?: "right";
  items: MenuItem[];
  heading?: string;
  footer?: ReactNode;
  onSelect(id: string): void;
  onClose(): void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <>
      <button className="menu-scrim" aria-label="Close menu" onClick={onClose} />
      <div className={`menu ${placement} ${align ?? ""}`} role="menu">
        {heading ? <div className="menu-heading">{heading}</div> : null}
        {items.map((item) => (
          <button
            key={item.id}
            role="menuitem"
            className={item.selected ? "selected" : ""}
            onClick={() => { onSelect(item.id); onClose(); }}
          >
            <span>{item.label}</span>
            {item.hint ? <small>{item.hint}</small> : null}
          </button>
        ))}
        {footer}
      </div>
    </>
  );
}
