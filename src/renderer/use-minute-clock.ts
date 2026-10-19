import { useSyncExternalStore } from "react";

const MINUTE = 60_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

function schedule(): void {
  timer = setTimeout(() => {
    listeners.forEach((listener) => listener());
    schedule();
  }, MINUTE - (Date.now() % MINUTE));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) schedule();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) { clearTimeout(timer); timer = undefined; }
  };
}

const idle = () => () => undefined;
const minute = () => Math.floor(Date.now() / MINUTE);

/** Re-renders only its caller when the wall-clock minute turns; one timer serves every subscriber, none while `active` is off. */
export function useMinuteClock(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : idle, minute);
}
