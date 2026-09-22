/**
 * Preview Kit's own contract between its host entry and its desktop entry.
 * Tau core does not know these commands; it only routes them by extension id.
 */
import type { PreviewAnnotationResult, PreviewAnnotationTool, PreviewPickedElement } from "./page-overlay.js";

export const PREVIEW_HOST_EXTENSION_ID = "tau.preview";

/** The profile a new install browses in: the partition the preview always had. */
export const DEFAULT_PREVIEW_PROFILE = "default";

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
  /** The browser profile the view runs in; each has its own cookies and storage. */
  profile: string;
  /** The page is taking a pick or annotations, not clicks. */
  mode?: "pick" | "annotate";
  /** A recording in progress, since this many ms after the epoch. */
  recordingSince?: number;
  /** The last recording that ended without being asked to, e.g. at the length cap. */
  recordingNotice?: string;
}

/** A local server the address bar suggests. */
export interface PreviewServer {
  url: string;
  port: number;
  pid?: number;
  command?: string;
  /** The listening process runs inside the workspace. */
  inWorkspace: boolean;
  /** It answered with a page. */
  html: boolean;
}

export interface PreviewImage {
  /** PNG, base64. */
  data: string;
  width: number;
  height: number;
}

export interface PreviewProfiles {
  profiles: string[];
  active: string;
}

export interface PreviewRecording {
  path: string;
  name: string;
  size: number;
  durationMs: number;
  mimeType: string;
}

export type PreviewNavigateInput = { url: string } | { action: "back" | "forward" | "reload" };

export interface PreviewHostCommands {
  "open": { input: { url: string }; output: PreviewState };
  "navigate": { input: PreviewNavigateInput; output: PreviewState };
  "close": { input: undefined; output: PreviewState };
  "bounds": { input: PreviewBounds; output: void };
  "state": { input: undefined; output: PreviewState };
  "ports": { input: { cwd?: string }; output: PreviewServer[] };
  /** Resolves once the user clicked an element or gave up (`null`). */
  "pick": { input: undefined; output: { element: PreviewPickedElement; image?: PreviewImage } | null };
  "pick-cancel": { input: undefined; output: void };
  "annotate": { input: { tool: PreviewAnnotationTool }; output: void };
  "annotate-cancel": { input: undefined; output: void };
  "annotate-send": { input: undefined; output: { annotations: PreviewAnnotationResult; image?: PreviewImage } | null };
  "record-start": { input: undefined; output: PreviewState };
  "record-stop": { input: undefined; output: PreviewRecording | null };
  "profiles": { input: undefined; output: PreviewProfiles };
  "use-profile": { input: { name: string }; output: PreviewProfiles };
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
    ports: call("ports"),
    pick: call("pick"),
    "pick-cancel": call("pick-cancel"),
    annotate: call("annotate"),
    "annotate-cancel": call("annotate-cancel"),
    "annotate-send": call("annotate-send"),
    "record-start": call("record-start"),
    "record-stop": call("record-stop"),
    profiles: call("profiles"),
    "use-profile": call("use-profile"),
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
  profile: DEFAULT_PREVIEW_PROFILE,
};

/**
 * What the kit's desktop half publishes with `context.provideService`, so
 * another kit can show a page without importing this one: it brings the panel
 * forward and navigates. The caller passes its own workbench actions.
 */
export const PREVIEW_BROWSER_SERVICE = "tau.preview/browser";

export interface PreviewBrowserService {
  open(url: string, actions: { openPanel(id: string): void }): Promise<void>;
}

/**
 * Composer Context's chip service, copied rather than imported (a kit never
 * imports another kit): the part Preview Kit uses.
 */
export const COMPOSER_CONTEXT_CHIPS_SERVICE = "tau.composer-context/chips";

export type PreviewChipInput =
  | { kind: "text-excerpt"; label?: string; payload: { source: string; text: string } }
  | { kind: "attachment"; label?: string; payload: { name: string; mimeType: string; size: number; path?: string } };

export interface ComposerContextChips {
  addChip(chip: PreviewChipInput): string;
  removeChip(id: string): void;
}
