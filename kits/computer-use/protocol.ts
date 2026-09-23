export const COMPUTER_USE_EXTENSION_ID = "tau.computer-use";

/** The npm package Tau ships; the host resolves and loads it (see `host.ts`). */
export const COMPUTER_USE_PACKAGE = "@amaster.ai/pi-computer-use";

/** How the contributed Pi extension is named inside every runtime Tau creates. */
export const COMPUTER_USE_RUNTIME_EXTENSION = "tau-computer-use";

/** The observer that feeds the screen view; it runs whoever registered the driver. */
export const COMPUTER_USE_SCREEN_RUNTIME_EXTENSION = "tau-computer-use-screen";

/** Every computer-use tool is `computer_use_<operation>`. */
export const COMPUTER_USE_TOOL_PREFIX = "computer_use_";

/** Host extensions granted `screen-state` and `screen-frame`: Evidence Kit. */
export const SCREEN_CALLERS: readonly string[] = ["tau.evidence"];

/** Event the host emits with a `ScreenState` whenever a thread's screen changes. */
export const SCREEN_EVENT = "screen";

/**
 * What the desktop half publishes with `provideService`: the window the agent
 * of a thread drives, its frames and actions. Preview Kit draws it; evidence
 * capture reads the same stream.
 */
export const COMPUTER_USE_SCREEN_SERVICE = "tau.computer-use/screen";

/** A point in the pixels of the window's latest driver screenshot, top-left origin. */
export interface ScreenPoint {
  x: number;
  y: number;
}

export type ScreenActionKind = "click" | "double-click" | "right-click" | "drag" | "type" | "key" | "scroll";

/** One input the agent sent to the window. */
export interface ScreenAction {
  /** The tool call's id. */
  id: string;
  kind: ScreenActionKind;
  at: number;
  /** Where it landed; absent when the driver addressed an element it could not place. */
  point?: ScreenPoint;
  /** A drag's end. */
  to?: ScreenPoint;
  /** The size of the screenshot `point` is measured in. */
  space?: { width: number; height: number };
  text?: string;
  /** A key or a chord, modifiers first: `["cmd", "c"]`. */
  keys?: string[];
  direction?: "up" | "down" | "left" | "right";
  status: "running" | "done" | "failed";
}

export interface ScreenWindow {
  pid: number;
  windowId?: number;
  app?: string;
  title?: string;
}

export interface ScreenFrameInfo {
  seq: number;
  at: number;
  width: number;
  height: number;
  mimeType: string;
  window: ScreenWindow;
}

export interface ScreenFrame extends ScreenFrameInfo {
  /** Base64. */
  data: string;
}

/** What a thread's agent drives right now; no image data, so it travels as an event. */
export interface ScreenState {
  threadId: string;
  window?: ScreenWindow;
  frame?: ScreenFrameInfo;
  /** Newest last. */
  actions: ScreenAction[];
  /** The driver of this thread can raise the window. */
  canBringToFront: boolean;
  updatedAt: number;
}

/** Whether this machine lets Tau record one window (macOS: Screen Recording). */
export type ScreenAccess = "granted" | "denied" | "not-determined" | "restricted" | "unavailable";

/** A frame of the live capture: a JPEG data URL, scaled down. */
export interface ScreenLiveFrame {
  seq: number;
  url: string;
  width: number;
  height: number;
}

export interface ComputerUseHostCommands {
  "screen-state": { input: { threadId: string }; output: ScreenState | null };
  "screen-frame": { input: { threadId: string; seq?: number }; output: ScreenFrame | null };
  "screen-front": { input: { threadId: string }; output: void };
  "screen-icon": { input: { threadId: string }; output: string | null };
  "screen-access": { input: undefined; output: ScreenAccess };
  "screen-access-settings": { input: undefined; output: void };
  "screen-live-start": { input: { threadId: string }; output: ScreenAccess };
  /** `null` while no frame is ready yet; `ended` once the capture stopped by itself. */
  "screen-live-frame": { input: { threadId: string }; output: ScreenLiveFrame | { ended: true } | null };
  /** Stops the capture of this thread's window; another window's capture goes on. */
  "screen-live-stop": { input: { threadId: string }; output: void };
}

/** The renderer's view of the stream; `COMPUTER_USE_SCREEN_SERVICE` publishes it. */
export interface ComputerUseScreenService {
  /** What the window last heard; `load` asks the host, for a thread whose events came before the window did. */
  state(threadId: string): ScreenState | undefined;
  load(threadId: string): Promise<ScreenState | undefined>;
  /** Every state change of every thread; returns the unsubscribe. */
  subscribe(listener: (state: ScreenState) => void): () => void;
  /** The newest frame, or the one numbered `seq` while the host still holds it. */
  frame(threadId: string, seq?: number): Promise<ScreenFrame | null>;
  bringToFront(threadId: string): Promise<void>;
  /** The app's icon as a data URL, when the window's client can draw one. */
  icon(threadId: string): Promise<string | null>;
  access(): Promise<ScreenAccess>;
  openAccessSettings(): Promise<void>;
  /**
   * Records the thread's window, and only that window, a few frames a second
   * until the returned stop runs. `ended` hears why it stopped by itself.
   */
  live(threadId: string, onFrame: (frame: ScreenLiveFrame) => void, ended?: (reason: string) => void): () => void;
}
