/**
 * Preview Kit's own contract between its host entry and its desktop entry.
 * Tau core does not know these commands; it only routes them by extension id.
 */
import type { ComponentType } from "react";
import type { WorkbenchActions } from "tau";
import type { PreviewAnnotationResult, PreviewAnnotationTool, PreviewPickedElement } from "./page-overlay.js";

export const PREVIEW_HOST_EXTENSION_ID = "tau.preview";

/** The profile a new install browses in: the partition the preview always had. */
export const DEFAULT_PREVIEW_PROFILE = "default";

/** Event the host pushes whenever the browsed page changes. */
export const PREVIEW_STATE_EVENT = "state";

/** `prefers-color-scheme` the page sees; `system` follows the OS. */
export type PreviewAppearance = "system" | "light" | "dark";

/** The page's viewport: the panel's whole rectangle, or a fixed CSS size scaled to fit it. */
export type PreviewViewport = { mode: "fill" } | { mode: "fixed"; width: number; height: number; preset?: string };

export interface PreviewRecordingOptions {
  frameRate: number;
  /** Draw each key press into the recording; never inside a password field. */
  showKeys: boolean;
  /** Draw a ring where the pointer presses. */
  showClicks: boolean;
}

/** What a new page opens with, from Settings → Preview. */
export interface PreviewDefaults {
  viewport: PreviewViewport;
  zoom: number;
  appearance: PreviewAppearance;
  recording: PreviewRecordingOptions;
}

export type PreviewMiniCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Where the floating preview sits and how wide it is at rest; each device keeps its own. */
export interface PreviewMiniPrefs {
  corner: PreviewMiniCorner;
  width: number;
}

/** The thread whose agent last drove the page or a window, until its turn ends. */
export interface PreviewDriver {
  threadId: string;
  source: "browser" | "screen";
  since: number;
  /** The user hid the floating preview for this drive. */
  dismissed?: boolean;
}

/** A page the preview showed, newest first in the list. */
export interface PreviewHistoryEntry {
  url: string;
  title?: string;
  visitedAt: number;
}

/** What the preview page's own keys asked for: the `preview.refresh` and zoom chords. */
export type PreviewChord = "reload" | "hard-reload" | "zoom-in" | "zoom-out" | "zoom-reset";

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
  /** The page's own zoom, apart from the workbench's. */
  zoom: number;
  viewport: PreviewViewport;
  appearance: PreviewAppearance;
  driver?: PreviewDriver;
  /** What older clients start the floating preview from; a device now keeps its own. */
  mini: PreviewMiniPrefs;
  /** The page is laid out for this device's screen rather than the host window's panel. */
  layoutFor?: PreviewLayoutFor;
  /** No Tau window on the host's machine can draw the page; a device shows why instead of a picture. */
  noWindow?: PreviewNoWindow;
}

/** Why the host's machine has no window for the page. */
export interface PreviewNoWindow {
  /** A Linux host without a display: `tau service install --display` gives it one out of sight. Else the Tau app has to run there. */
  displayService: boolean;
}

/**
 * A device that shows the page, as it describes itself: the CSS size of the
 * area it draws the page in, its pixel ratio, and whether it is a touch
 * screen. `id` stays the same on one device across reloads.
 */
export interface PreviewViewer {
  id: string;
  width: number;
  height: number;
  dpr: number;
  touch: boolean;
}

/** The device the page is laid out for, as every client shows it. */
export interface PreviewLayoutFor {
  id: string;
  name: string;
  width: number;
  height: number;
  touch: boolean;
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
  /** Profile ids; an id names the profile's partition and never changes. */
  profiles: string[];
  active: string;
  /** A name the user gave a profile, by id; the id is its name otherwise. */
  names?: Record<string, string>;
}

/** What a profile is called in the panel and in Settings. */
export function profileLabel(profiles: PreviewProfiles | undefined, id: string): string {
  return profiles?.names?.[id] ?? id;
}

/** A small picture of the page for the floating preview. */
export interface PreviewFrame {
  /** JPEG, base64. */
  data: string;
  width: number;
  height: number;
}

/** What a client that shows the page asks for: a width that fits it, and the frame it already has. */
export interface PreviewLiveFrameRequest {
  maxWidth: number;
  /** The id of the frame the client shows; an unchanged page answers without the picture. */
  since?: string;
  /** A device that shows the page full size; the page may be laid out for it while the host window does not show it. */
  viewer?: PreviewViewer;
}

/** A JPEG of the page sized for one client, or word that it still shows the same. */
export type PreviewLiveFrame =
  | { id: string; data: string; width: number; height: number; url: string }
  | { id: string; unchanged: true };

/** The keys a remote device may send; no chords, so nothing reaches past the page. */
export const PREVIEW_INPUT_KEYS = [
  "Enter", "Tab", "Backspace", "Delete", "Escape",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
] as const;

export type PreviewInputKey = typeof PREVIEW_INPUT_KEYS[number];

/**
 * Input from a device that shows the page: a tap becomes a click, typed text
 * goes into the focused field. `x` and `y` are fractions of the frame, so the
 * same tap lands in the same place at any frame size.
 */
export type PreviewInput =
  | { kind: "click"; x: number; y: number }
  /** `dx` and `dy` are fractions of the frame too: 0.5 scrolls half a screen. */
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: PreviewInputKey };

/** Where the page's keyboard focus is after an input: a device masks its own field for a secret. */
export interface PreviewInputResult {
  focus: "secret" | "field" | "none";
}

export interface PreviewRecording {
  path: string;
  name: string;
  size: number;
  durationMs: number;
  mimeType: string;
}

export type PreviewNavigateInput = { url: string } | { action: "back" | "forward" | "reload" };

/** A browser whose cookies can be copied into a profile. */
export interface CookieImportSource {
  id: string;
  name: string;
  engine: "chromium" | "firefox" | "safari";
  /** The browser's own profiles that hold a cookie store. */
  profiles: Array<{ id: string; name: string }>;
  /** Chromium's cookies are encrypted with a key in the OS keychain. */
  keychain?: string;
}

/** The cookies of one site in a source profile, counted without reading a value. */
export interface CookieImportSite {
  site: string;
  cookies: number;
}

export interface CookieImportRequest {
  source: string;
  profile: string;
}

export interface CookieImportResult {
  imported: number;
  skipped: number;
  /** Sites with cookies that could not be decrypted or written, a few at most. */
  skippedSites: string[];
  /** The Preview profile the cookies went into. */
  profile: string;
  /** The page in view was reloaded because it runs in that profile. */
  reloaded: boolean;
}

/**
 * Why an import stopped, as the first word of the error's message in
 * brackets: errors cross two process boundaries as plain text.
 */
export type CookieImportFailure =
  | "keychain-denied"
  | "keychain-missing"
  | "keychain-unavailable"
  | "full-disk-access"
  | "busy"
  | "read-failed"
  | "unknown-source"
  | "unknown-profile"
  | "no-window";

export function cookieImportFailure(message: string): CookieImportFailure | undefined {
  return /^\[([a-z-]+)\]/u.exec(message)?.[1] as CookieImportFailure | undefined;
}

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
  "rename-profile": { input: { id: string; name: string }; output: PreviewProfiles };
  "delete-profile": { input: { id: string }; output: PreviewProfiles };
  "zoom": { input: { step: "in" | "out" | "reset" } | { factor: number }; output: PreviewState };
  "viewport": { input: PreviewViewport; output: PreviewState };
  "appearance": { input: { appearance: PreviewAppearance }; output: PreviewState };
  "defaults": { input: PreviewDefaults; output: void };
  /** What `defaults` set last; a client that holds the same sends nothing. */
  "current-defaults": { input: undefined; output: PreviewDefaults };
  "history": { input: undefined; output: PreviewHistoryEntry[] };
  "forget": { input: { url: string }; output: PreviewHistoryEntry[] };
  "mini-frame": { input: undefined; output: PreviewFrame | null };
  "mini-prefs": { input: Partial<PreviewMiniPrefs>; output: PreviewState };
  "mini-dismiss": { input: undefined; output: PreviewState };
  /** Only a client that shows the page asks; it paces itself and picks the size. */
  "live-frame": { input: PreviewLiveFrameRequest; output: PreviewLiveFrame | null };
  /** Full access only: a Read-only device watches. */
  "input": { input: PreviewInput; output: PreviewInputResult };
  /**
   * Whose screen the page is laid out for: `viewer` lays it out for that
   * device, `release` gives it back to the host window if that device still
   * has it, and neither gives it back at once.
   */
  "layout": { input: { viewer?: PreviewViewer; release?: string }; output: PreviewState };
  /** Browsers installed on the machine the window runs on; reads no cookie. */
  "import-sources": { input: undefined; output: CookieImportSource[] };
  /** Site names and counts of one source profile; decrypts nothing. */
  "import-sites": { input: CookieImportRequest; output: CookieImportSite[] };
  /** Copies the chosen sites' cookies into a Preview profile; may ask the keychain. */
  "import-cookies": { input: CookieImportRequest & { sites: string[]; into: string }; output: CookieImportResult };
  /** Opens the system setting that grants Full Disk Access (Safari's cookies). */
  "import-open-access": { input: undefined; output: void };
  /** The user holds the page: a focused password field says it is not recorded. */
  "hold": { input: { on: boolean }; output: void };
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
    "rename-profile": call("rename-profile"),
    "delete-profile": call("delete-profile"),
    zoom: call("zoom"),
    viewport: call("viewport"),
    appearance: call("appearance"),
    defaults: call("defaults"),
    "current-defaults": call("current-defaults"),
    history: call("history"),
    forget: call("forget"),
    "mini-frame": call("mini-frame"),
    "mini-prefs": call("mini-prefs"),
    "mini-dismiss": call("mini-dismiss"),
    "live-frame": call("live-frame"),
    input: call("input"),
    layout: call("layout"),
    "import-sources": call("import-sources"),
    "import-sites": call("import-sites"),
    "import-cookies": call("import-cookies"),
    "import-open-access": call("import-open-access"),
    hold: call("hold"),
  } as PreviewHostClient;
}

export const DEFAULT_MINI_PREFS: PreviewMiniPrefs = { corner: "bottom-right", width: 280 };

export const EMPTY_PREVIEW_STATE: PreviewState = {
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  consoleErrors: [],
  available: true,
  profile: DEFAULT_PREVIEW_PROFILE,
  zoom: 1,
  viewport: { mode: "fill" },
  appearance: "system",
  mini: DEFAULT_MINI_PREFS,
};

/**
 * What the kit's desktop half publishes with `context.provideService`, so
 * another kit can show a page without importing this one: it brings the panel
 * forward and navigates. The caller passes its own workbench actions.
 */
export const PREVIEW_BROWSER_SERVICE = "tau.preview/browser";

export interface PreviewBrowserService {
  open(url: string, actions: { openPanel(id: string): void }): Promise<void>;
  /**
   * Brings forward what an agent drives: the Preview panel with the page
   * (`browser`), or the window of `threadId`'s agent in front of every app
   * (`app`). A handover asking the user to take over uses these.
   */
  jump(target: { kind: "browser" } | { kind: "app"; threadId: string }, actions: { openPanel(id: string): void }): Promise<void>;
  /**
   * A small live picture of the page or of the window `threadId`'s agent
   * drives, at `maxWidth`, while the calling view is on screen; `undefined`
   * while there is nothing to show. Returns the stop. Absent before API 1.13.0.
   */
  watch?(target: { kind: "browser" } | { kind: "app"; threadId: string }, maxWidth: number, onFrame: (picture: { url: string; width: number; height: number } | undefined) => void): () => void;
  /** This client is not on the host's machine: `jump` opens the Preview here, where the user can drive it. */
  remote?(): boolean;
  /**
   * The user holds the page, e.g. for a sign-in: the panel draws an amber frame
   * and "you have control"; a phone's sheet draws `Bar` above the page and
   * `Footer` under it. Returns the release.
   */
  hold?(control: PreviewHold): () => void;
}

export interface PreviewHold {
  Bar?: ComponentType<{ actions: WorkbenchActions }>;
  Footer?: ComponentType;
}

/**
 * Opens the cookie import dialog for one site and profile, e.g. after the user
 * signed in in their own browser. The user still picks the browser and clicks
 * Import; that click is the consent. Answers `undefined` when closed without one.
 */
export const PREVIEW_COOKIE_IMPORT_SERVICE = "tau.preview/cookie-import";

export interface PreviewCookieImportService {
  importSite(request: { site: string; profile?: string }): Promise<CookieImportResult | undefined>;
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
