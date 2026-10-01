import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Check, Gauge, Zap } from "lucide-react";
import type { HostSnapshot, UiModel } from "../../shared/contracts";
import type { ComposerSpeedState } from "../extension-system";
import { DEFAULT_THINKING, THINKING_LABELS } from "../thinking-levels";
import { formatTokens } from "./model-offerings";
import { Popover } from "./ui/Dialog";
import { focusableElements, openedByKeyboard } from "./ui/focus";
import { useSheetDrag } from "../touch/sheet-drag";
import "./thinking-menu.css";

// A chunk of its own (deferred-surfaces): nothing here is drawn until the composer's "…" opens.

/** The composer menu ("…") a control is drawn in; picking an entry closes it. */
export const ComposerMenuContext = createContext<{ close(): void }>({ close() {} });

/** A heading and its entries in the composer menu, such as Mode or Access. */
export function ComposerMenuSection({ heading, aside, children }: { heading: string; aside?: string | undefined; children: ReactNode }) {
  return (
    <div className="composer-menu-section" role="group" aria-label={heading}>
      <div className="menu-heading" aria-hidden="true">{heading}{aside ? <span>{aside}</span> : null}</div>
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

/** The composer's "…" menu: the blocks the row had no room for, then the menu controls. The thinking chip's menu too. */
export function ComposerMenuPopover({ anchor, children, onClose, label = "More composer controls", className = "composer-overflow", footer }: {
  anchor: RefObject<HTMLElement | null>;
  children: ReactNode;
  onClose(): void;
  label?: string;
  className?: string;
  footer?: ReactNode;
}) {
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
    <Popover anchor={anchor} side="top" align="start" label={label} className={className} onClose={onClose}>
      <ComposerMenuContext.Provider value={context}>
        <div ref={list} className="composer-menu" onKeyDown={onKeyDown}>
          {children}
        </div>
      </ComposerMenuContext.Provider>
      {footer}
    </Popover>
  );
}

const SHORT_LEVELS: Readonly<Record<string, string>> = { minimal: "Min", medium: "Med", xhigh: "XHigh" };

export interface ThinkingMenuProps {
  anchor: RefObject<HTMLElement | null>;
  /** A phone: a bottom sheet of segmented rows (design 1w) instead of the popover. */
  sheet: boolean;
  snapshot: HostSnapshot | undefined;
  /** The levels this thread can set; none where the model has none or the runtime sets them itself (`ownsThinking`). */
  levels: readonly string[];
  ownsThinking: boolean;
  onLevel(level: string): void;
  /** The model's context windows, where it has more than one (`contextChoices`). */
  contexts: ReadonlyArray<{ model: UiModel; tokens: number }>;
  onContext(model: UiModel): void;
  /** What a kit says of Fast for this thread; absent where none does. */
  speed?: ComposerSpeedState | undefined;
  onSpeed?: ((fast: boolean) => void) | undefined;
  /** The chords that open the menu and step the level, for its footer. */
  keys?: { open?: string | undefined; cycle?: string | undefined } | undefined;
  onClose(): void;
}

interface Choice { id: string; label: string; tag?: boolean; icon?: ReactNode; detail?: string | undefined; off?: boolean; on: boolean; pick(): void }

/**
 * The thinking chip's menu (K142, after T3): the model's thinking levels, its
 * context windows where it has more than one, then Speed. One pick closes it;
 * on a phone it is a sheet whose sections are rows of segments (thinking-menu.css) and stays until Done.
 */
export function ThinkingMenu({ anchor, sheet, snapshot, levels, ownsThinking, onLevel, contexts, onContext, speed, onSpeed, keys, onClose }: ThinkingMenuProps) {
  const sheetRef = useRef<HTMLElement | null>(null);
  const head = useRef<HTMLElement>(null);
  useLayoutEffect(() => { sheetRef.current = sheet ? head.current?.closest<HTMLElement>(".popover") ?? null : null; }, [sheet]);
  useSheetDrag(sheetRef, onClose);
  const model = snapshot?.model;
  const runtime = snapshot?.backendKind ?? "pi";
  const levelChoices: Choice[] = levels.map((id) => ({
    id, label: (sheet ? SHORT_LEVELS[id] : undefined) ?? THINKING_LABELS[id] ?? id, tag: !sheet && id === DEFAULT_THINKING && runtime === "pi",
    on: id === snapshot?.thinkingLevel, pick: () => onLevel(id),
  }));
  const contextChoices: Choice[] = contexts.map((choice) => ({
    id: choice.model.id, label: choice.tokens ? formatTokens(choice.tokens) : "Standard", tag: !sheet && !choice.model.id.includes("["),
    on: choice.model.id === model?.id, pick: () => onContext(choice.model),
  }));
  const offered = speed?.available === true && onSpeed !== undefined;
  const fastOn = offered && speed.fast;
  const why = speed?.reason ?? `${snapshot?.runtimeBackends?.find((backend) => backend.kind === runtime)?.label ?? "Pi"} offers no Fast tier.`;
  const speedChoices: Choice[] = [
    { id: "standard", label: "Standard", icon: <Gauge size={13} />, on: !fastOn, pick: () => onSpeed?.(false) },
    { id: "fast", label: "Fast", icon: <Zap size={13} className="thinking-zap" />, detail: offered ? speed.detail : why, on: fastOn, off: !offered, pick: () => onSpeed?.(true) },
  ];
  const items = (choices: readonly Choice[]) => choices.map((choice) => (
    <ComposerMenuItem key={choice.id} icon={choice.icon} label={choice.label} detail={choice.detail} selected={choice.on} disabled={choice.off} keepOpen={sheet}
      trailing={choice.tag ? <span className="thinking-default">Default</span> : undefined} onSelect={choice.pick} />
  ));
  const levelNote = levelChoices.length > 1 ? undefined : ownsThinking ? "This runtime sets thinking itself." : `${model?.name ?? "This model"} has no thinking levels.`;
  return (
    <ComposerMenuPopover anchor={anchor} label="Thinking, context window and speed" className={`composer-overflow thinking-menu${sheet ? " thinking-sheet" : ""}`} onClose={onClose} footer={!sheet && (keys?.open || keys?.cycle) ? (
      <footer className="thinking-menu-foot">
        {keys.open ? <span><kbd>{keys.open}</kbd> opens this</span> : null}
        {keys.cycle ? <span><kbd>{keys.cycle}</kbd> next level</span> : null}
      </footer>
    ) : undefined}>
      {sheet ? <header ref={head} className="touch-sheet-header">
        <span className="touch-sheet-grip" aria-hidden="true" />
        <strong>Thinking and speed</strong>
        <button type="button" className="model-sheet-done" onClick={onClose}>Done</button>
      </header> : null}
      <ComposerMenuSection heading="Thinking" aside={model?.name}>
        {levelNote ? <p className="thinking-note">{levelNote}</p> : items(levelChoices)}
      </ComposerMenuSection>
      {contextChoices.length > 1 ? <ComposerMenuSection heading="Context window">{items(contextChoices)}</ComposerMenuSection> : null}
      <ComposerMenuSection heading="Speed">{items(offered || sheet ? speedChoices : speedChoices.slice(1))}</ComposerMenuSection>
      {sheet ? <p className="thinking-note">{offered ? speed.detail : why}</p> : null}
    </ComposerMenuPopover>
  );
}
