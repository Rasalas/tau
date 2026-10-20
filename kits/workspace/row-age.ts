import { useCallback, useSyncExternalStore } from "react";

/** How often a row's age is read again; ages count whole minutes, so half of one is close enough. */
export const ROW_AGE_TICK_MS = 30_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let now = Date.now();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((each) => each());
    }, ROW_AGE_TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) { clearInterval(timer); timer = undefined; }
  };
}

/** A row's age (`now`, `5m`, `3h`, `2d`), kept current by one timer every rail row shares; a row redraws only when its label changes. */
export function useRowAge(modifiedAt: number, format: (timestamp: number, now: number) => string): string {
  const read = useCallback(() => format(modifiedAt, listeners.size > 0 ? now : Date.now()), [format, modifiedAt]);
  return useSyncExternalStore(subscribe, read);
}
