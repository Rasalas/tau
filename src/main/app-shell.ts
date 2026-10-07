import type { ReleaseNotes, WindowAction, WindowShellEvent, WindowShellStatus } from "../shared/window-shell.js";

/** How long a quit waits for the page's first answer before it goes ahead anyway. */
export const QUIT_ANSWER_TIMEOUT_MS = 2_000;

export interface AppShellPorts {
  /** A `window-shell` push to this window's page. */
  publish(event: WindowShellEvent): void;
  /** Whether a page is there to answer; without one a quit goes ahead at once. */
  hasPage(): boolean;
  pasteAsText(): void;
  /** The page is about to ask the user; a window the quit shortcut hid must show again. */
  showWindow?(): void;
  checkForUpdates(): void;
  updateReady(): string | undefined;
  devBuild?: boolean;
  releaseNotes?: { pending(): Promise<ReleaseNotes | undefined>; seen(version: string): Promise<void> };
  schedule?(run: () => void, ms: number): () => void;
}

const defaultSchedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * The window process's side of `src/shared/window-shell.ts`: what the page asks
 * of it, and the question before a quit. The page knows which threads are
 * working and whether the user wants to be asked; this side only waits.
 */
export function createAppShell(ports: AppShellPorts) {
  const schedule = ports.schedule ?? defaultSchedule;
  const waiting = new Map<string, { settle(quit: boolean): void; cancel(): void }>();
  let next = 0;

  return {
    /** Resolves true to quit, false when the user chose to stay. A page that never answers lets the quit go ahead. */
    confirmQuit(): Promise<boolean> {
      if (!ports.hasPage()) return Promise.resolve(true);
      const requestId = `quit-${next += 1}`;
      return new Promise<boolean>((resolve) => {
        const settle = (quit: boolean) => {
          const entry = waiting.get(requestId);
          if (!entry) return;
          entry.cancel();
          waiting.delete(requestId);
          resolve(quit);
        };
        waiting.set(requestId, { settle, cancel: schedule(() => settle(true), QUIT_ANSWER_TIMEOUT_MS) });
        ports.publish({ kind: "quit-requested", requestId });
      });
    },

    async act(action: WindowAction): Promise<unknown> {
      switch (action.kind) {
        case "paste-as-text":
          ports.pasteAsText();
          return undefined;
        case "answer-quit": {
          const entry = waiting.get(action.requestId);
          if (!entry) return undefined;
          // The page is asking the user; that may take as long as it takes.
          if (action.answer === "asking") {
            entry.cancel();
            ports.showWindow?.();
          } else {
            entry.settle(action.answer === "quit");
          }
          return undefined;
        }
        case "status": {
          const updateReady = ports.updateReady();
          const releaseNotes = await ports.releaseNotes?.pending().catch(() => undefined);
          return { ...(updateReady ? { updateReady } : {}), ...(releaseNotes ? { releaseNotes } : {}), ...(ports.devBuild ? { devBuild: true } : {}) } satisfies WindowShellStatus;
        }
        case "release-notes-seen":
          await ports.releaseNotes?.seen(action.version);
          return undefined;
        case "check-for-updates":
          ports.checkForUpdates();
          return undefined;
      }
    },
  };
}

export type AppShell = ReturnType<typeof createAppShell>;
