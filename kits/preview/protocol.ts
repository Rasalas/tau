/**
 * Preview Kit's own contract between its host entry and its desktop entry.
 * Tau core does not know these commands; it only routes them by extension id.
 */
export const PREVIEW_HOST_EXTENSION_ID = "tau.preview";

/** Event the host pushes whenever the browsed page changes. */
export const PREVIEW_STATE_EVENT = "state";

/** Where the panel wants the view drawn, in the window's CSS pixels. */
export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export interface PreviewState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Console errors and failed requests of the current page, newest last. */
  consoleErrors: string[];
  /** False on a host without a window: the tools and the panel are unavailable. */
  available: boolean;
}

export type PreviewNavigateInput = { url: string } | { action: "back" | "forward" | "reload" };

export interface PreviewHostCommands {
  "open": { input: { url: string }; output: PreviewState };
  "navigate": { input: PreviewNavigateInput; output: PreviewState };
  "close": { input: undefined; output: PreviewState };
  "bounds": { input: PreviewBounds; output: void };
  "state": { input: undefined; output: PreviewState };
}

export type PreviewHostClient = {
  [Command in keyof PreviewHostCommands]: PreviewHostCommands[Command]["input"] extends undefined
    ? () => Promise<PreviewHostCommands[Command]["output"]>
    : (input: PreviewHostCommands[Command]["input"]) => Promise<PreviewHostCommands[Command]["output"]>;
};

export function createPreviewHostClient(invoke: (command: string, input?: unknown) => Promise<unknown>): PreviewHostClient {
  const call = <Command extends keyof PreviewHostCommands>(command: Command) =>
    (input?: unknown) => invoke(command, input) as Promise<PreviewHostCommands[Command]["output"]>;
  return {
    open: call("open"),
    navigate: call("navigate"),
    close: call("close"),
    bounds: call("bounds"),
    state: call("state"),
  } as PreviewHostClient;
}

export const EMPTY_PREVIEW_STATE: PreviewState = {
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  consoleErrors: [],
  available: true,
};
