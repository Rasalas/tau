import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { tooltipProps } from "./ui/Tooltip";

/** How far one arrow key moves a handle; Shift moves four times as far. */
export const RESIZE_KEY_STEP = 16;

export function clampSize(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.round(Math.min(Math.max(min, max), Math.max(min, value)));
}

/**
 * A separator that resizes the pane beside it: drag, arrow keys (Shift for
 * bigger steps), Home to reset, End for the maximum, double-click to reset.
 * `grows` names the pointer direction that makes the pane larger.
 */
export function ResizeHandle({ className, label, orientation, value, min, max, defaultValue, grows, onChange }: {
  className: string;
  label: string;
  /** `vertical` sits between columns and changes a width; `horizontal` changes a height. */
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  grows: "right" | "left" | "up";
  onChange(value: number): void;
}) {
  const cleanup = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cleanup.current?.(), []);
  const change = (next: number) => onChange(clampSize(next, min, max, defaultValue));
  const sign = grows === "right" ? 1 : -1;
  const bodyClass = orientation === "vertical" ? "resizing-col" : "resizing-row";

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    cleanup.current?.();
    const start = orientation === "vertical" ? event.clientX : event.clientY;
    const startValue = value;
    const onMove = (move: globalThis.PointerEvent) => change(startValue + sign * ((orientation === "vertical" ? move.clientX : move.clientY) - start));
    const stop = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      document.body.classList.remove(bodyClass);
      cleanup.current = undefined;
    };
    cleanup.current = stop;
    document.body.classList.add(bodyClass);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = RESIZE_KEY_STEP * (event.shiftKey ? 4 : 1);
    const keys: Record<string, number | undefined> = orientation === "vertical"
      ? { ArrowRight: value + sign * step, ArrowLeft: value - sign * step }
      : { ArrowUp: value + step, ArrowDown: value - step };
    const next = event.key === "Home" ? defaultValue : event.key === "End" ? max : keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    change(next);
  };

  return <div
    className={`resize-handle ${className}`}
    role="separator"
    aria-label={label}
    aria-orientation={orientation}
    aria-valuemin={min}
    aria-valuemax={Math.max(min, max)}
    aria-valuenow={value}
    tabIndex={0}
    {...tooltipProps("Drag to resize. Double-click to reset.", { side: orientation === "vertical" ? (grows === "right" ? "right" : "left") : "top" })}
    onPointerDown={onPointerDown}
    onDoubleClick={() => change(defaultValue)}
    onKeyDown={onKeyDown}
  />;
}
