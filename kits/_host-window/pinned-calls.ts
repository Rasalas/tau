import type { HostClientCallOptions, HostExtensionServices } from "tau/host-extension";

/** What core's `callClient` rejects with once a pinned window is gone (API 1.13.0). */
const GONE = /pinned to is gone/u;

export interface PinnedWindowCalls {
  call(command: string, input?: unknown): Promise<unknown>;
  /** The window was let go of (a view closed): the next call pins again. */
  release(): void;
}

/**
 * Keeps a kit's window-half calls on one Tau window on the host's machine,
 * whichever client or turn asks: a view lives in one window, and a call that
 * reached another would find nothing there. The first call pins the window the
 * caller would reach; once that window is gone, the next newest takes over.
 * A host older than 1.13.0 ignores the options and asks as it always did.
 */
export interface PinnedWindowOptions {
  /**
   * The pinned window went away and the next call goes to another one, which
   * holds none of the old one's views: rebuild them here, through `calls`,
   * before the call that noticed runs there.
   */
  onMoved?(): Promise<void>;
}

export function pinnedWindowCalls(services: Pick<HostExtensionServices, "callClient" | "clientWindow">, options: PinnedWindowOptions = {}): PinnedWindowCalls {
  let pin: string | undefined;
  const target = (): HostClientCallOptions => {
    pin ??= services.clientWindow?.();
    return { window: pin ?? "host" };
  };
  return {
    async call(command, input) {
      const pinned = target();
      try {
        return await services.callClient(command, input, pinned);
      } catch (error) {
        if (pinned.window === "host" || !(error instanceof Error) || !GONE.test(error.message)) throw error;
        pin = undefined;
        await options.onMoved?.();
        return services.callClient(command, input, target());
      }
    },
    release() {
      pin = undefined;
    },
  };
}
