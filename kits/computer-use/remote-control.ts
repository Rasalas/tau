import {
  COMPUTER_USE_TOOL_PREFIX,
  SCREEN_INPUT_KEYS,
  type ScreenAccess,
  type ScreenFrame,
  type ScreenInput,
  type ScreenInputKey,
  type ScreenLiveFrame,
  type ScreenViewFrame,
  type ScreenWindow,
} from "./protocol.js";

const MAX_TEXT = 4_000;
const MAX_SCROLL = 10;
const FRAME_WIDTH = { min: 120, max: 1_600 } as const;
/** How long the host keeps a window's live capture for remote views after the last ask. */
export const REMOTE_LIVE_IDLE_MS = 10_000;
const ACCESS_FRESH_MS = 30_000;

const fraction = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
const delta = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(-MAX_SCROLL, Math.min(MAX_SCROLL, value)) : 0;

export function readScreenInput(value: unknown): ScreenInput {
  const fields = value && typeof value === "object" ? value as Record<string, unknown> : {};
  switch (fields.kind) {
    case "click": {
      const x = fraction(fields.x), y = fraction(fields.y);
      if (x === undefined || y === undefined) throw new Error("A tap needs x and y between 0 and 1.");
      return { kind: "click", x, y };
    }
    case "scroll":
      return { kind: "scroll", x: fraction(fields.x) ?? 0.5, y: fraction(fields.y) ?? 0.5, dx: delta(fields.dx), dy: delta(fields.dy) };
    case "text":
      if (typeof fields.text !== "string" || !fields.text) throw new Error("Typing needs text.");
      if (fields.text.length > MAX_TEXT) throw new Error(`Type at most ${String(MAX_TEXT)} characters at once.`);
      return { kind: "text", text: fields.text };
    case "key": {
      const key = SCREEN_INPUT_KEYS.find((candidate) => candidate === fields.key);
      if (!key) throw new Error(`A device may send ${SCREEN_INPUT_KEYS.join(", ")}.`);
      return { kind: "key", key };
    }
    default:
      throw new Error("Input is a click, a scroll, text or a key.");
  }
}

/** The driver's key names. */
const DRIVER_KEYS: Record<ScreenInputKey, string> = {
  Enter: "return", Tab: "tab", Backspace: "delete", Escape: "escape",
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
};

export interface DriverCall {
  tool: string;
  params: Record<string, unknown>;
}

/**
 * The driver calls for one input, addressed to the window the thread's agent
 * drives and nothing else: pid and window come from the feed, never from the
 * device, and nothing is sent to the desktop scope.
 */
export function driverCalls(input: ScreenInput, target: Required<Pick<ScreenWindow, "pid" | "windowId">>, space: { width: number; height: number }): DriverCall[] {
  const window = { pid: target.pid, window_id: target.windowId };
  const at = (x: number, y: number) => ({ x: Math.round(x * space.width), y: Math.round(y * space.height) });
  switch (input.kind) {
    case "click":
      return [{ tool: `${COMPUTER_USE_TOOL_PREFIX}click`, params: { ...window, ...at(input.x, input.y) } }];
    case "scroll": {
      const vertical = Math.abs(input.dy) >= Math.abs(input.dx);
      const amount = vertical ? input.dy : input.dx;
      if (amount === 0) return [];
      const direction = vertical ? (amount > 0 ? "down" : "up") : (amount > 0 ? "right" : "left");
      // About ten notches per frame's height.
      const notches = Math.max(1, Math.min(50, Math.round(Math.abs(amount) * 10)));
      return [{ tool: `${COMPUTER_USE_TOOL_PREFIX}scroll`, params: { ...window, ...at(input.x, input.y), direction, amount: notches } }];
    }
    case "text":
      return [{ tool: `${COMPUTER_USE_TOOL_PREFIX}type_text`, params: { ...window, text: input.text } }];
    case "key":
      return [{ tool: `${COMPUTER_USE_TOOL_PREFIX}press_key`, params: { ...window, key: DRIVER_KEYS[input.key] } }];
  }
}

export interface ToolRunResult {
  content?: readonly unknown[];
  details?: unknown;
  isError?: boolean;
}

export interface ScreenRemotePorts {
  target(threadId: string): ScreenWindow | undefined;
  frame(threadId: string): ScreenFrame | null;
  /** Runs one of the thread's own driver tools, around every hook. */
  run(threadId: string, tool: string, params: Record<string, unknown>): Promise<ToolRunResult>;
  /** A fresh look at the window went through the driver: the feed takes its screenshot. */
  looked(threadId: string, params: Record<string, unknown>, result: ToolRunResult): void;
  /** Computer Use's window half on the host's machine. */
  callWindow(command: string, input?: unknown): Promise<unknown>;
  now(): number;
}

type Picture = { id: string; data: string; width: number; height: number; mimeType: string };

const dataUrl = (url: string): { data: string; mimeType: string } | undefined => {
  const match = /^data:([^;,]+);base64,(.*)$/su.exec(url);
  return match ? { mimeType: match[1]!, data: match[2]! } : undefined;
};

/**
 * The driven window for devices other than the host's own window: a frame at
 * the size each asks for, and their taps and keys, through the thread's driver.
 */
export class ScreenRemote {
  private queue = Promise.resolve();

  private access: { value: ScreenAccess; at: number } | undefined;

  private live: { windowId: number; lastAsked: number; timer?: ReturnType<typeof setTimeout> } | undefined;

  private readonly shrunk = new Map<string, Promise<Picture | undefined>>();

  constructor(private readonly ports: ScreenRemotePorts) {}

  /** One input at a time, in order; then a fresh look, so every device sees what it did. */
  input(threadId: string, raw: unknown): Promise<void> {
    const input = readScreenInput(raw);
    const run = this.queue.then(async () => {
      const target = this.ports.target(threadId);
      if (!target || target.windowId === undefined) throw new Error("The agent of this thread drives no window yet.");
      const frame = this.ports.frame(threadId);
      if (!frame) throw new Error("There is no picture of the window yet to point into.");
      const window = { pid: target.pid, windowId: target.windowId };
      for (const call of driverCalls(input, window, frame)) {
        const result = await this.ports.run(threadId, call.tool, call.params);
        if (result.isError) throw new Error(textOf(result) || "The window did not take the input.");
      }
      const look = { pid: target.pid, window_id: target.windowId };
      const state = await this.ports.run(threadId, `${COMPUTER_USE_TOOL_PREFIX}get_window_state`, look).catch(() => undefined);
      if (state && !state.isError) this.ports.looked(threadId, look, state);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * The newest picture of the window at `maxWidth`: the live capture where
   * this Mac allows it, else the driver's latest screenshot. An unchanged one
   * answers with its id alone.
   */
  async frame(threadId: string, request: { maxWidth?: unknown; since?: unknown }): Promise<ScreenViewFrame | null> {
    const target = this.ports.target(threadId);
    const maxWidth = typeof request.maxWidth === "number" && Number.isFinite(request.maxWidth)
      ? Math.round(Math.min(FRAME_WIDTH.max, Math.max(FRAME_WIDTH.min, request.maxWidth)))
      : 640;
    const picture = (target?.windowId !== undefined ? await this.livePicture(target.windowId) : undefined) ?? this.driverPicture(threadId);
    if (!picture) return null;
    if (picture.id === request.since) return { id: picture.id, unchanged: true };
    const sized = picture.width > maxWidth ? await this.shrink(picture, maxWidth) : picture;
    return sized ?? picture;
  }

  dispose(): void {
    if (this.live?.timer) clearTimeout(this.live.timer);
    this.live = undefined;
  }

  private driverPicture(threadId: string): Picture | undefined {
    const frame = this.ports.frame(threadId);
    return frame ? { id: `d${String(frame.seq)}`, data: frame.data, width: frame.width, height: frame.height, mimeType: frame.mimeType } : undefined;
  }

  private async livePicture(windowId: number): Promise<Picture | undefined> {
    if (await this.screenAccess() !== "granted") return undefined;
    try {
      if (this.live?.windowId !== windowId) {
        await this.ports.callWindow("live-start", { windowId });
        this.live = { windowId, lastAsked: this.ports.now() };
      }
      this.keepLive(windowId);
      const frame = await this.ports.callWindow("live-frame", { windowId }) as ScreenLiveFrame | { ended: true } | null;
      if (!frame) return undefined;
      if ("ended" in frame) {
        // Someone stopped the capture (the desktop's Screen view closed); the next ask starts it again.
        this.live = undefined;
        return undefined;
      }
      const parsed = dataUrl(frame.url);
      return parsed ? { id: `l${String(windowId)}:${String(frame.seq)}`, ...parsed, width: frame.width, height: frame.height } : undefined;
    } catch {
      return undefined;
    }
  }

  /** The capture runs while devices keep asking, and stops a while after the last. */
  private keepLive(windowId: number): void {
    const live = this.live;
    if (!live) return;
    live.lastAsked = this.ports.now();
    if (live.timer) clearTimeout(live.timer);
    live.timer = setTimeout(() => {
      if (this.live !== live) return;
      this.live = undefined;
      void this.ports.callWindow("live-stop", { windowId }).catch(() => undefined);
    }, REMOTE_LIVE_IDLE_MS);
    live.timer.unref?.();
  }

  private async screenAccess(): Promise<ScreenAccess> {
    const cached = this.access;
    if (cached && this.ports.now() - cached.at < ACCESS_FRESH_MS) return cached.value;
    let value: ScreenAccess = "unavailable";
    try {
      value = await this.ports.callWindow("access") as ScreenAccess;
    } catch {
      value = "unavailable";
    }
    this.access = { value, at: this.ports.now() };
    return value;
  }

  private shrink(picture: Picture, maxWidth: number): Promise<Picture | undefined> {
    const key = `${picture.id}@${String(maxWidth)}`;
    let pending = this.shrunk.get(key);
    if (!pending) {
      pending = this.ports.callWindow("shrink", { data: picture.data, mimeType: picture.mimeType, maxWidth })
        .then((answer) => {
          const shrunk = answer as { data?: unknown; width?: unknown; height?: unknown } | null;
          return shrunk && typeof shrunk.data === "string" && typeof shrunk.width === "number" && typeof shrunk.height === "number"
            ? { id: picture.id, data: shrunk.data, width: shrunk.width, height: shrunk.height, mimeType: "image/jpeg" }
            : undefined;
        }, () => undefined);
      this.shrunk.set(key, pending);
      // Only the newest few sizes are worth keeping.
      while (this.shrunk.size > 8) this.shrunk.delete(this.shrunk.keys().next().value!);
    }
    return pending;
  }
}

function textOf(result: ToolRunResult): string {
  return (result.content ?? []).map((entry) => {
    const part = entry as { type?: unknown; text?: unknown };
    return part.type === "text" && typeof part.text === "string" ? part.text : "";
  }).join(" ").trim();
}
