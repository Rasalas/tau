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
}
