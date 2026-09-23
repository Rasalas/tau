import { errorMessage, type HostExtensionClient } from "tau";
import {
  SCREEN_EVENT,
  type ComputerUseScreenService,
  type ScreenAccess,
  type ScreenFrame,
  type ScreenLiveFrame,
  type ScreenState,
} from "./protocol.js";

/** A few frames a second: enough to follow a click, cheap enough to leave on. */
export const LIVE_INTERVAL_MS = 300;

export function isScreenState(value: unknown): value is ScreenState {
  const state = value as Partial<ScreenState> | null;
  return Boolean(state && typeof state.threadId === "string" && Array.isArray(state.actions));
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The renderer's side of the screen stream: the states the host pushes, the
 * frames it holds on request, and a live view that asks for the next frame only
 * after the last one arrived.
 */
export function createScreenService(host: HostExtensionClient, pause: (ms: number) => Promise<void> = wait): { service: ComputerUseScreenService; dispose(): void } {
  const states = new Map<string, ScreenState>();
  const listeners = new Set<(state: ScreenState) => void>();
  const accept = (state: ScreenState): void => {
    const known = states.get(state.threadId);
    if (known && known.updatedAt > state.updatedAt) return;
    states.set(state.threadId, state);
    for (const listener of listeners) listener(state);
  };
  const stopEvents = host.onEvent(SCREEN_EVENT, (payload) => { if (isScreenState(payload)) accept(payload); });

  const service: ComputerUseScreenService = {
    state: (threadId) => states.get(threadId),
    async load(threadId) {
      const state = await host.invoke("screen-state", { threadId });
      if (isScreenState(state)) accept(state);
      return states.get(threadId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    frame: async (threadId, seq) => await host.invoke("screen-frame", { threadId, ...(seq !== undefined ? { seq } : {}) }) as ScreenFrame | null,
    bringToFront: async (threadId) => { await host.invoke("screen-front", { threadId }); },
    icon: async (threadId) => {
      const url = await host.invoke("screen-icon", { threadId });
      return typeof url === "string" ? url : null;
    },
    access: async () => await host.invoke("screen-access") as ScreenAccess,
    openAccessSettings: async () => { await host.invoke("screen-access-settings"); },
    live(threadId, onFrame, ended) {
      let stopped = false;
      let started = false;
      const release = (): void => {
        if (started) void host.invoke("screen-live-stop", { threadId }).catch(() => undefined);
      };
      const finish = (reason: string): void => {
        if (stopped) return;
        stopped = true;
        release();
        ended?.(reason);
      };
      void (async () => {
        const access = await host.invoke("screen-live-start", { threadId }) as ScreenAccess;
        if (access !== "granted") return finish(access);
        started = true;
        if (stopped) return release();
        let last = -1;
        // `stopped` changes from outside the loop, when the view lets go.
        for (;;) {
          const frame = await host.invoke("screen-live-frame", { threadId }) as ScreenLiveFrame | { ended: true } | null;
          if (stopped) return;
          if (frame && "ended" in frame) return finish("ended");
          if (frame && frame.seq !== last) {
            last = frame.seq;
            onFrame(frame);
          }
          await pause(LIVE_INTERVAL_MS);
          if (stopped) return;
        }
      })().catch((error: unknown) => finish(errorMessage(error)));
      return () => {
        if (stopped) return;
        stopped = true;
        release();
      };
    },
  };
  return {
    service,
    dispose() {
      stopEvents();
      listeners.clear();
      states.clear();
    },
  };
}
