import { useEffect, useRef, useSyncExternalStore } from "react";
import type { WorkbenchActions } from "tau";
import type { ComputerUseScreenService, ScreenState } from "./screen-protocol.js";

/** A value several components read and one place writes, without a provider around the panel. */
export class Cell<T> {
  private readonly listeners = new Set<() => void>();

  constructor(private value: T) {}

  get = (): T => this.value;

  set(value: T): void {
    if (Object.is(value, this.value)) return;
    this.value = value;
    this.listeners.forEach((listener) => listener());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  use(): T {
    return useSyncExternalStore(this.subscribe, this.get, this.get);
  }
}

export type PreviewView = "browser" | "screen";

/** Computer Use's screen service while that kit is on; the Screen tab exists only then. */
export const screenService = new Cell<ComputerUseScreenService | undefined>(undefined);

/** Which of the panel's two views is in front. */
export const previewView = new Cell<PreviewView>("browser");

/** The thread on screen, as the workbench last announced it. */
export const activeThread = new Cell<string | undefined>(undefined);

/** For `useService`: holds the service while it exists. */
export function holdScreenService(service: ComputerUseScreenService): () => void {
  screenService.set(service);
  return () => {
    if (screenService.get() === service) screenService.set(undefined);
    if (previewView.get() === "screen") previewView.set("browser");
  };
}

const windowKey = (state: ScreenState): string | undefined => state.window ? `${state.window.pid}:${state.window.windowId ?? "?"}` : undefined;

/**
 * Brings the Screen view forward when the agent of the thread on screen starts
 * driving a window, once per window, so a user who went back to the browser
 * is not pulled away on every click.
 */
export function useScreenFollower(actions: Pick<WorkbenchActions, "openPanel" | "activeThread">, panel: string): void {
  const service = screenService.use();
  const followed = useRef(new Map<string, string>());
  useEffect(() => {
    if (!service) return undefined;
    return service.subscribe((state) => {
      const key = windowKey(state);
      const threadId = actions.activeThread()?.sessionId ?? activeThread.get();
      if (!key || state.threadId !== threadId || followed.current.get(state.threadId) === key) return;
      followed.current.set(state.threadId, key);
      previewView.set("screen");
      actions.openPanel(panel);
    });
  }, [actions, panel, service]);
}
