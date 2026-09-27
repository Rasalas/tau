import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { useKeepClear } from "../reserved-region";
import { useEscapeLayer } from "./ui/escape-layers";
import { openedByKeyboard, useFocusReturn } from "./ui/focus";
import { placeFloating, pointRect, viewportSize } from "./ui/floating";
import { firstEnabled, isTypeaheadKey, lastEnabled, stepEnabled, typeahead, type TypeaheadState } from "./ui/menu-navigation";

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  /** Small pill after the label, e.g. "Default". */
  badge?: string;
  /** Secondary line explaining the cost or effect of the choice. */
  description?: string;
  selected?: boolean;
  disabled?: boolean;
  /** Deletes or discards something; drawn in the danger colour. */
  destructive?: boolean;
  /** Opens beside the item; the item itself selects nothing. */
  submenu?: MenuSection[];
}

export interface MenuSection {
  heading?: string;
  items: MenuItem[];
}

const EDGE = 8;

interface LevelProps {
  groups: MenuSection[];
  onPick(id: string): void;
  onCloseAll(): void;
  /** A submenu gives focus back to its item on ArrowLeft. */
  onBack?(): void;
  /** Focus the first entry on mount; a submenu opened by hover leaves focus where it is. */
  focusFirst: boolean;
}

/**
 * One column of entries with the keyboard of a native menu: arrows, Home and
 * End, typeahead, ArrowRight into a submenu and ArrowLeft out of it. The
 * caller puts `onKeyDown` on the element that holds `entries`.
 */
function useMenuLevel({ groups, onPick, onCloseAll, onBack, focusFirst }: LevelProps) {
  const items = groups.flatMap((group) => group.items);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const typed = useRef<TypeaheadState | undefined>(undefined);
  const [open, setOpen] = useState<{ index: number; byKeyboard: boolean }>();
  const disabled = items.map((item) => Boolean(item.disabled));

  useLayoutEffect(() => {
    if (!focusFirst) return;
    const selected = items.findIndex((item) => item.selected && !item.disabled);
    buttons.current[selected >= 0 ? selected : firstEnabled(disabled)]?.focus({ preventScroll: true });
    // Only on mount: later renders must not pull focus back to the top.
  }, []);

  const focusAt = (index: number) => { if (index >= 0) buttons.current[index]?.focus({ preventScroll: true }); };
  const current = () => buttons.current.findIndex((button) => button === document.activeElement);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const index = current();
    const item = index >= 0 ? items[index] : undefined;
    let handled = true;
    if (event.key === "ArrowDown") focusAt(stepEnabled(disabled, index, 1));
    else if (event.key === "ArrowUp") focusAt(stepEnabled(disabled, index < 0 ? disabled.length : index, -1));
    else if (event.key === "Home") focusAt(firstEnabled(disabled));
    else if (event.key === "End") focusAt(lastEnabled(disabled));
    else if (event.key === "ArrowRight" && item?.submenu && !item.disabled) setOpen({ index, byKeyboard: true });
    else if (event.key === "ArrowLeft" && onBack) onBack();
    else if (event.key === "Tab") onCloseAll();
    else if (isTypeaheadKey(event)) {
      const next = typeahead(items.map((entry) => entry.label), disabled, index, typed.current, event.key, Date.now());
      typed.current = next.state;
      focusAt(next.index);
    } else handled = false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  };

  let flat = 0;
  const entries = (
    <>
      {groups.map((group, groupIndex) => (
        <div className="menu-section" key={group.heading ?? groupIndex} role="group" {...(group.heading ? { "aria-label": group.heading } : {})}>
          {groupIndex > 0 ? <hr /> : null}
          {group.heading ? <div className="menu-heading" aria-hidden="true">{group.heading}</div> : null}
          {group.items.map((item) => {
            const index = flat++;
            const expanded = open?.index === index;
            const button = (
              <button
                key={item.id}
                ref={(element) => { buttons.current[index] = element; }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={[item.selected ? "selected" : "", item.destructive ? "destructive" : "", expanded ? "expanded" : ""].filter(Boolean).join(" ")}
                disabled={item.disabled}
                {...(item.submenu ? { "aria-haspopup": "menu" as const, "aria-expanded": expanded } : {})}
                {...(item.disabled && item.description ? { "data-tooltip": item.description, "data-tooltip-side": "right" } : {})}
                onPointerEnter={() => {
                  if (item.disabled) return;
                  buttons.current[index]?.focus({ preventScroll: true });
                  setOpen(item.submenu ? { index, byKeyboard: false } : undefined);
                }}
                onClick={() => {
                  if (item.submenu) { setOpen({ index, byKeyboard: openedByKeyboard() }); return; }
                  onPick(item.id);
                }}
              >
                {item.icon}
                <span className="menu-label">
                  <em>
                    {item.label}
                    {item.badge ? <b>{item.badge}</b> : null}
                  </em>
                  {item.description ? <small>{item.description}</small> : null}
                </span>
                {item.hint ? <small className="menu-hint">{item.hint}</small> : null}
                {item.submenu ? <ChevronRight size={13} className="menu-submenu-mark" aria-hidden="true" /> : null}
              </button>
            );
            if (!item.submenu) return button;
            return (
              <div className="menu-sub-anchor" key={item.id}>
                {button}
                {expanded ? (
                  <Submenu
                    groups={item.submenu}
                    onPick={onPick}
                    onCloseAll={onCloseAll}
                    focusFirst={open.byKeyboard}
                    onBack={() => { setOpen(undefined); focusAt(index); }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
  return { onKeyDown, entries };
}

function Submenu(props: LevelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (rect.right > window.innerWidth - EDGE) setFlip(true);
    const below = rect.bottom - (window.innerHeight - EDGE);
    if (below > 0) element.style.setProperty("--menu-shift-y", `${-Math.min(below, Math.max(0, rect.top - EDGE))}px`);
  }, []);
  const level = useMenuLevel(props);
  return (
    <div ref={ref} className={`menu submenu${flip ? " flip" : ""}`} role="menu" aria-orientation="vertical" onKeyDown={level.onKeyDown}>
      {level.entries}
    </div>
  );
}

/**
 * Popover list anchored to its trigger, or to a point when `at` is given (a
 * right-click where no native menu is offered). The scrim sits under the menu
 * and closes it, so a click outside never also activates what is underneath.
 * Escape and Tab close it and give focus back to whatever had it before.
 *
 * The title bar spans the dock too, so a right-aligned menu from it drops over
 * the panel; `useKeepClear` slides such a menu back when the host has a native
 * view there, and the menu flips or shifts to stay inside the window.
 */
export function Menu({
  placement = "below",
  align,
  at,
  items,
  sections,
  heading,
  footer,
  label,
  onSelect,
  onClose,
}: {
  placement?: "below" | "above";
  align?: "left" | "right";
  /** Viewport coordinates to open at, drawn over the whole window instead of inside the trigger's anchor. */
  at?: { x: number; y: number };
  items?: MenuItem[];
  sections?: MenuSection[];
  heading?: string;
  footer?: ReactNode;
  /** The accessible name, when no heading names the menu. */
  label?: string;
  onSelect(id: string): void;
  onClose(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState(placement);
  const [point, setPoint] = useState(at);
  const [byKeyboard] = useState(openedByKeyboard);
  useFocusReturn(true, menu);

  useEscapeLayer(onClose);

  // Stays inside the window: a menu near an edge opens the other way or slides along it.
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    if (at) {
      const rect = element.getBoundingClientRect();
      const placed = placeFloating(pointRect(at.x, at.y), { width: rect.width, height: rect.height }, viewportSize(), { side: "bottom", align: "start", offset: 2 });
      setPoint({ x: placed.left, y: placed.top });
      return;
    }
    element.style.setProperty("--menu-shift-x", "0px");
    element.style.maxHeight = "";
    element.style.overflowY = "";
    const rect = element.getBoundingClientRect();
    const anchor = element.parentElement?.getBoundingClientRect();
    if (side === "below" && rect.bottom > window.innerHeight - EDGE && anchor && anchor.top > window.innerHeight - anchor.bottom) setSide("above");
    else if (side === "above" && rect.top < EDGE && anchor && window.innerHeight - anchor.bottom > anchor.top) setSide("below");
    // Taller than the room on its side (a phone): it scrolls rather than running off the screen.
    const room = side === "below" ? window.innerHeight - EDGE - rect.top : rect.bottom - EDGE;
    if (rect.height > room && room > 0) {
      element.style.maxHeight = `${Math.floor(room)}px`;
      element.style.overflowY = "auto";
    }
    const shift = rect.left < EDGE ? EDGE - rect.left : rect.right > window.innerWidth - EDGE ? window.innerWidth - EDGE - rect.right : 0;
    if (shift) element.style.setProperty("--menu-shift-x", `${Math.round(shift)}px`);
  }, [at, side]);

  useKeepClear(menu);

  const groups = sections ?? [{ heading, items: items ?? [] }];
  const pick = (id: string) => { onSelect(id); onClose(); };
  const level = useMenuLevel({ groups, onPick: pick, onCloseAll: onClose, focusFirst: byKeyboard });
  const body = (
    <>
      <button className="menu-scrim" tabIndex={-1} aria-label="Close menu" onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }} />
      <div
        className={at ? "menu at-point" : `menu ${side} ${align ?? ""}`}
        role="menu"
        aria-orientation="vertical"
        aria-label={label ?? heading ?? groups[0]?.heading}
        tabIndex={-1}
        ref={menu}
        style={at && point ? { left: point.x, top: point.y } : undefined}
        onKeyDown={level.onKeyDown}
      >
        {level.entries}
        {footer}
      </div>
    </>
  );
  useLayoutEffect(() => {
    // Opened by a click: the list itself takes focus so the arrows work at once.
    if (!byKeyboard && !menu.current?.contains(document.activeElement)) menu.current?.focus({ preventScroll: true });
  }, [byKeyboard]);
  return at ? createPortal(body, document.body) : body;
}
