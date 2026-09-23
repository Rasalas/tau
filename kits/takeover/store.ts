import type { WorkbenchActions } from "tau";
import type { ComputerUseScreenService, PreviewBrowserService, PreviewCookieImportService, Takeover } from "./protocol.js";

/** One value and its listeners, for `useSyncExternalStore`. */
export class Cell<T> {
  private readonly listeners = new Set<() => void>();

  constructor(private value: T) {}

  get = (): T => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  set(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** What the host last said waits for the user, in every client alike. */
export const takeovers = new Cell<readonly Takeover[]>([]);

/** The other kits' services, while they are there. */
export const services = {
  preview: new Cell<PreviewBrowserService | undefined>(undefined),
  cookies: new Cell<PreviewCookieImportService | undefined>(undefined),
  screen: new Cell<ComputerUseScreenService | undefined>(undefined),
};

/** The workbench's actions as the last drawn region had them, for a notification's click. */
export const workbench = new Cell<WorkbenchActions | undefined>(undefined);

export function hold<T>(cell: Cell<T | undefined>) {
  return (value: T) => {
    cell.set(value);
    return () => { if (cell.get() === value) cell.set(undefined); };
  };
}
