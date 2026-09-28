import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Check } from "lucide-react";
import { Popover } from "./ui/Dialog";
import { focusableElements, openedByKeyboard } from "./ui/focus";

// A chunk of its own (deferred-surfaces): nothing here is drawn until the composer's "…" opens.

/** The composer menu ("…") a control is drawn in; picking an entry closes it. */
export const ComposerMenuContext = createContext<{ close(): void }>({ close() {} });

/** A heading and its entries in the composer menu, as T3 Code groups Mode and Access. */
export function ComposerMenuSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="composer-menu-section" role="group" aria-label={heading}>
      <div className="menu-heading" aria-hidden="true">{heading}</div>
      {children}
    </div>
  );
}

/**
 * One entry of the composer menu. With `selected` set (true or false) it is
 * one choice of its section; without, an action.
 */
export function ComposerMenuItem({ icon, label, detail, selected, disabled, disabledReason, trailing, keepOpen, onSelect }: {
  icon?: ReactNode;
  label: string;
  /** A second line: what the choice costs or does. */
  detail?: string;
  selected?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  /** Drawn at the end, such as a count. */
  trailing?: ReactNode;
  /** The menu stays open after the pick. */
  keepOpen?: boolean;
  onSelect(): void;
}) {
  const menu = useContext(ComposerMenuContext);
  const radio = selected !== undefined;
  return (
    <button
      type="button"
      className="composer-menu-item"
      {...(radio ? { role: "radio", "aria-checked": selected } : {})}
      disabled={disabled}
      {...(disabled && disabledReason ? { "data-tooltip": disabledReason, "data-tooltip-side": "right" } : {})}
      onClick={() => {
        onSelect();
        if (!keepOpen) menu.close();
      }}
    >
      {icon ? <span className="composer-menu-icon" aria-hidden="true">{icon}</span> : null}
      <span className="composer-menu-label">
        <em>{label}</em>
        {detail ? <small>{detail}</small> : null}
      </span>
      {trailing}
      {radio ? <Check size={13} className="composer-menu-check" aria-hidden="true" style={{ visibility: selected ? "visible" : "hidden" }} /> : null}
    </button>
  );
}

/** The composer's "…" menu: the blocks the row had no room for, then the menu controls. */
export function ComposerMenuPopover({ anchor, children, onClose }: { anchor: RefObject<HTMLButtonElement | null>; children: ReactNode; onClose(): void }) {
  const list = useRef<HTMLDivElement>(null);
  const [byKeyboard] = useState(openedByKeyboard);
  const context = useMemo(() => ({ close: onClose }), [onClose]);
  useLayoutEffect(() => {
    if (byKeyboard && list.current) focusableElements(list.current)[0]?.focus({ preventScroll: true });
  }, [byKeyboard]);
  // Arrows walk the entries, as in every other menu.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const entries = list.current ? focusableElements(list.current) : [];
    if (entries.length === 0) return;
    event.preventDefault();
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    entries[(at + step + entries.length) % entries.length]?.focus({ preventScroll: true });
  };
  return (
    <Popover anchor={anchor} side="top" align="start" label="More composer controls" className="composer-overflow" onClose={onClose}>
      <ComposerMenuContext.Provider value={context}>
        <div ref={list} className="composer-menu" onKeyDown={onKeyDown}>
          {children}
        </div>
      </ComposerMenuContext.Provider>
    </Popover>
  );
}
