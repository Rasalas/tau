import { useLayoutEffect, useRef, type RefObject } from "react";

let lastInput: "keyboard" | "pointer" = "pointer";
if (typeof document !== "undefined") {
  document.addEventListener("keydown", () => { lastInput = "keyboard"; }, true);
  document.addEventListener("pointerdown", () => { lastInput = "pointer"; }, true);
  document.addEventListener("mousedown", () => { lastInput = "pointer"; }, true);
}

/** Whether the last thing the user did was a key press; a menu opened that way focuses its first entry. */
export const openedByKeyboard = (): boolean => lastInput === "keyboard";

const FOCUSABLE = "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.closest("[inert]"));
}

function focusIsLost(container: HTMLElement | null): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active.tagName === "HTML" || Boolean(container?.contains(active));
}

function focusedElement(): HTMLElement | undefined {
  const active = typeof document === "undefined" ? null : document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : undefined;
}

/**
 * Remembers what had focus when `active` turned on and gives focus back to it
 * when `active` turns off or the component goes, unless something else took
 * focus meanwhile. `fallback` runs when that element is gone.
 */
export function useFocusReturn(active: boolean, container?: RefObject<HTMLElement | null>, fallback?: () => void): void {
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  // Read while rendering: a child's layout effect may move focus before this hook's own effect runs.
  const trigger = useRef<HTMLElement | undefined>(undefined);
  const wasActive = useRef(false);
  if (active && !wasActive.current) trigger.current = focusedElement();
  wasActive.current = active;
  useLayoutEffect(() => {
    if (!active) return undefined;
    const target = trigger.current;
    // The surface's node is read now: by cleanup time React may have detached the ref.
    let node: HTMLElement | null = container?.current ?? null;
    const frame = requestAnimationFrame(() => { node = container?.current ?? node; });
    return () => {
      cancelAnimationFrame(frame);
      if (!focusIsLost(container?.current ?? node)) return;
      if (target?.isConnected && !node?.contains(target)) target.focus({ preventScroll: true });
      else fallbackRef.current?.();
    };
  }, [active, container]);
}

/** Keeps Tab and Shift-Tab inside `container` while `active`. */
export function useFocusTrap(container: RefObject<HTMLElement | null>, active = true): void {
  useLayoutEffect(() => {
    const element = container.current;
    if (!active || !element) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = focusableElements(element);
      if (focusable.length === 0) { event.preventDefault(); return; }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !element.contains(current))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (current === last || !element.contains(current))) { event.preventDefault(); first.focus(); }
    };
    element.addEventListener("keydown", onKeyDown);
    return () => element.removeEventListener("keydown", onKeyDown);
  }, [active, container]);
}
