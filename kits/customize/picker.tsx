import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { CustomizablePart, WorkbenchActions } from "tau";
import { CUSTOMIZE_SETTINGS_PAGE, partRowId } from "./settings.js";

/** Whether the picker is on; the command turns it on, a pick or Escape off. */
export function createPickerState() {
  let active = false;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => active,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next: boolean) {
      if (next === active) return;
      active = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

export type PickerState = ReturnType<typeof createPickerState>;

/** The part under a point: the innermost element named by `data-tau-part`. */
export function partAt(target: EventTarget | null): HTMLElement | undefined {
  return target instanceof Element ? (target.closest("[data-tau-part]") as HTMLElement | null) ?? undefined : undefined;
}

/** A part draws no box of its own (`display: contents`); its children's union is where it is. */
export function partBox(part: Element): DOMRect | undefined {
  const range = document.createRange();
  range.selectNodeContents(part);
  const rect = range.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? rect : undefined;
}

interface Hover { name: string; rect: DOMRect }

/**
 * Names the part under the pointer while the picker is on. A click opens
 * Settings → Customize at that part; Escape ends it.
 */
export function Picker({ state, actions, parts }: { state: PickerState; actions: WorkbenchActions; parts(): CustomizablePart[] }) {
  const active = useSyncExternalStore(state.subscribe, state.getSnapshot);
  const [hover, setHover] = useState<Hover | undefined>();

  useEffect(() => {
    if (!active) { setHover(undefined); return; }
    const move = (event: PointerEvent) => {
      const part = partAt(document.elementFromPoint(event.clientX, event.clientY));
      const rect = part ? partBox(part) : undefined;
      setHover(part && rect ? { name: part.dataset.tauPart ?? "", rect } : undefined);
    };
    const click = (event: MouseEvent) => {
      // The pick is the picker's: the part under it does not get the click.
      event.preventDefault();
      event.stopPropagation();
      const part = partAt(document.elementFromPoint(event.clientX, event.clientY));
      state.set(false);
      if (part?.dataset.tauPart) actions.openSettings(`${CUSTOMIZE_SETTINGS_PAGE}#${partRowId(part.dataset.tauPart)}`);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      state.set(false);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("click", click, true);
    window.addEventListener("keydown", key, true);
    document.body.dataset.tauPicking = "";
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("keydown", key, true);
      delete document.body.dataset.tauPicking;
    };
  }, [active, actions, state]);

  if (!active) return null;
  const part = hover ? parts().find((entry) => entry.name === hover.name) : undefined;
  return createPortal(
    <div className="customize-picker" aria-live="polite">
      {hover ? (
        <>
          <div className="customize-picker-box" style={{ left: hover.rect.left, top: hover.rect.top, width: hover.rect.width, height: hover.rect.height }} />
          <div className="customize-picker-label" style={{ left: hover.rect.left, top: Math.max(4, hover.rect.top - 26) }}>
            <code>{hover.name}</code>{part ? <span> · {part.extensionName}</span> : null}
          </div>
        </>
      ) : null}
      <div className="customize-picker-hint">Click a part to customize it · Esc to stop</div>
    </div>,
    document.body,
  );
}
