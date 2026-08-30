import { useEffect, type ReactNode } from "react";

export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  /** Small pill after the label, e.g. "Default". */
  badge?: string;
  /** Secondary line explaining the cost or effect of the choice. */
  description?: string;
  selected?: boolean;
  disabled?: boolean;
}

export interface MenuSection {
  heading?: string;
  items: MenuItem[];
}

/**
 * Popover list anchored to its trigger. The scrim sits under the menu and
 * closes it, so a click outside never also activates what is underneath.
 */
export function Menu({
  placement = "below",
  align,
  items,
  sections,
  heading,
  footer,
  onSelect,
  onClose,
}: {
  placement?: "below" | "above";
  align?: "right";
  items?: MenuItem[];
  sections?: MenuSection[];
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

  const groups = sections ?? [{ heading, items: items ?? [] }];

  return (
    <>
      <button className="menu-scrim" aria-label="Close menu" onClick={onClose} />
      <div className={`menu ${placement} ${align ?? ""}`} role="menu">
        {groups.map((group, index) => (
          <div className="menu-section" key={group.heading ?? index}>
            {index > 0 ? <hr /> : null}
            {group.heading ? <div className="menu-heading">{group.heading}</div> : null}
            {group.items.map((item) => (
              <button
                key={item.id}
                role="menuitem"
                className={item.selected ? "selected" : ""}
                disabled={item.disabled}
                title={item.disabled ? item.description : undefined}
                onClick={() => { onSelect(item.id); onClose(); }}
              >
                <span>
                  <em>
                    {item.label}
                    {item.badge ? <b>{item.badge}</b> : null}
                  </em>
                  {item.description ? <small>{item.description}</small> : null}
                </span>
                {item.hint ? <small className="menu-hint">{item.hint}</small> : null}
              </button>
            ))}
          </div>
        ))}
        {footer}
      </div>
    </>
  );
}
