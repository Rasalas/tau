import { createContext, useContext, type ReactNode } from "react";
import { Check } from "lucide-react";

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
