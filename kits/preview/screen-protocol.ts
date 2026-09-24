/**
 * Computer Use's screen service, copied rather than imported (a kit never
 * imports another kit): the part the Screen view reads. The source of truth is
 * `kits/computer-use/protocol.ts`.
 */
export const COMPUTER_USE_SCREEN_SERVICE = "tau.computer-use/screen";

export interface ScreenPoint {
  x: number;
  y: number;
}

export type ScreenActionKind = "click" | "double-click" | "right-click" | "drag" | "type" | "key" | "scroll";

export interface ScreenAction {
  id: string;
  kind: ScreenActionKind;
  at: number;
  point?: ScreenPoint;
  to?: ScreenPoint;
  space?: { width: number; height: number };
  text?: string;
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
  data: string;
}

export interface ScreenState {
  threadId: string;
  window?: ScreenWindow;
  frame?: ScreenFrameInfo;
  actions: ScreenAction[];
  canBringToFront: boolean;
  updatedAt: number;
}

export type ScreenAccess = "granted" | "denied" | "not-determined" | "restricted" | "unavailable";

export interface ScreenLiveFrame {
  seq: number;
  url: string;
  width: number;
  height: number;
}

/** The keys a remote device may send to a driven window; no chords. */
export const SCREEN_INPUT_KEYS = ["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"] as const;

export type ScreenInputKey = typeof SCREEN_INPUT_KEYS[number];

/**
 * A device's input to the window a thread's agent drives, given to that
 * window alone through the thread's own driver. Points and scroll distances
 * are fractions of the frame.
 */
export type ScreenInput =
  | { kind: "click"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: ScreenInputKey };

/** A frame of the driven window sized for one client, or word that it still shows the same. */
export type ScreenViewFrame =
  | { id: string; data: string; width: number; height: number; mimeType: string }
  | { id: string; unchanged: true };

export interface ComputerUseScreenService {
  state(threadId: string): ScreenState | undefined;
  load(threadId: string): Promise<ScreenState | undefined>;
  subscribe(listener: (state: ScreenState) => void): () => void;
  frame(threadId: string, seq?: number): Promise<ScreenFrame | null>;
  bringToFront(threadId: string): Promise<void>;
  icon(threadId: string): Promise<string | null>;
  access(): Promise<ScreenAccess>;
  openAccessSettings(): Promise<void>;
  live(threadId: string, onFrame: (frame: ScreenLiveFrame) => void, ended?: (reason: string) => void): () => void;
  /** A frame for a view on another device, at its width (API 1.13.0 hosts; absent before). */
  viewFrame?(threadId: string, maxWidth: number, since?: string): Promise<ScreenViewFrame | null>;
  /** Clicks, types or presses a key in the driven window; Full access only. */
  input?(threadId: string, input: ScreenInput): Promise<void>;
}
