import {
  COMPUTER_USE_TOOL_PREFIX,
  type ScreenAction,
  type ScreenActionKind,
  type ScreenFrame,
  type ScreenFrameInfo,
  type ScreenPoint,
  type ScreenState,
  type ScreenWindow,
} from "./protocol.js";

interface Box { x: number; y: number; w: number; h: number }

/** The last `get_window_state` of one window: where its elements are, in screen points. */
interface Snapshot {
  window: Box;
  width: number;
  height: number;
  elements: Map<string, Box>;
}

interface ThreadScreen {
  window?: ScreenWindow;
  frames: ScreenFrame[];
  actions: ScreenAction[];
  updatedAt: number;
}

export interface ToolOutcome {
  content?: readonly unknown[];
  details?: unknown;
  isError?: boolean;
}

export interface ScreenFeedLimits {
  /** Frames kept per thread, so a late reader still gets the one it was told about. */
  framesPerThread: number;
  threads: number;
  /** Base64 characters kept over all threads. */
  bytes: number;
  actions: number;
}

const DEFAULT_LIMITS: ScreenFeedLimits = { framesPerThread: 3, threads: 8, bytes: 48 * 1024 * 1024, actions: 12 };
const MAX_TEXT = 200;
const MAX_WINDOW_NAMES = 200;

type Fields = Record<string, unknown>;

const fields = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const windowKey = (pid: number, windowId: number | undefined): string => `${pid}:${windowId ?? "?"}`;

function box(value: unknown): Box | undefined {
  const frame = fields(value);
  const x = number(frame.x), y = number(frame.y), w = number(frame.w ?? frame.width), h = number(frame.h ?? frame.height);
  return x === undefined || y === undefined || w === undefined || h === undefined || w <= 0 || h <= 0 ? undefined : { x, y, w, h };
}

/** Width and height from a PNG or JPEG header, for a result that did not say. */
export function imageSize(base64: string): { width: number; height: number } | undefined {
  const head = Buffer.from(base64.slice(0, 44), "base64");
  if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47) return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  const bytes = Buffer.from(base64, "base64");
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  for (let offset = 2; offset + 9 < bytes.length;) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    // SOF0–SOF15 carry the size, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return undefined;
}

function keysOf(operation: string, input: Fields): string[] | undefined {
  if (operation === "hotkey") return Array.isArray(input.keys) ? input.keys.filter((key): key is string => typeof key === "string") : undefined;
  const key = text(input.key);
  if (!key) return undefined;
  const modifiers = Array.isArray(input.modifiers) ? input.modifiers.filter((entry): entry is string => typeof entry === "string") : [];
  return [...modifiers, key];
}

function kindOf(operation: string, input: Fields): ScreenActionKind | undefined {
  switch (operation) {
    case "click":
      if (input.button === "right") return "right-click";
      return number(input.count) === 2 ? "double-click" : "click";
    case "double_click": return "double-click";
    case "right_click": return "right-click";
    case "drag": return "drag";
    case "type_text":
    case "set_value": return "type";
    case "press_key":
    case "hotkey": return "key";
    case "scroll": return "scroll";
    default: return undefined;
  }
}

/**
 * The window a thread's agent drives, what it last saw of it and what it did
 * there, built from the computer-use tool calls and their results. It keeps
 * only window-scoped screenshots: a desktop screenshot or a zoom crop is not
 * a picture of the window, and the desktop is not the agent's to show.
 */
export class ScreenFeed {
  private readonly threads = new Map<string, ThreadScreen>();

  private readonly snapshots = new Map<string, Snapshot>();

  private readonly names = new Map<string, { app?: string; title?: string }>();

  private readonly limits: ScreenFeedLimits;

  private seq = 0;

  constructor(
    private readonly publish: (state: ScreenState) => void,
    private readonly options: { now?: () => number; canBringToFront?: (threadId: string) => boolean; limits?: Partial<ScreenFeedLimits> } = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  state(threadId: string): ScreenState | undefined {
    const thread = this.threads.get(threadId);
    if (!thread) return undefined;
    const frame = thread.frames.at(-1);
    return {
      threadId,
      ...(thread.window ? { window: { ...thread.window } } : {}),
      ...(frame ? { frame: frameInfo(frame) } : {}),
      actions: thread.actions.map((action) => ({ ...action })),
      canBringToFront: Boolean(thread.window && this.options.canBringToFront?.(threadId)),
      updatedAt: thread.updatedAt,
    };
  }

  frame(threadId: string, seq?: number): ScreenFrame | null {
    const frames = this.threads.get(threadId)?.frames ?? [];
    const frame = seq === undefined ? frames.at(-1) : frames.find((candidate) => candidate.seq === seq);
    return frame ? { ...frame, window: { ...frame.window } } : null;
  }

  target(threadId: string): ScreenWindow | undefined {
    const window = this.threads.get(threadId)?.window;
    return window ? { ...window } : undefined;
  }

  forget(threadId: string): void {
    this.threads.delete(threadId);
  }

  /** A computer-use call is about to run. */
  toolCall(threadId: string, toolName: string, rawInput: unknown, callId: string): void {
    if (!toolName.startsWith(COMPUTER_USE_TOOL_PREFIX)) return;
    const operation = toolName.slice(COMPUTER_USE_TOOL_PREFIX.length);
    const input = fields(rawInput);
    const kind = kindOf(operation, input);
    const pid = number(input.pid);
    // A desktop-scoped call names screen pixels and no window; it moves nothing we show.
    if (input.scope === "desktop" && pid === undefined) return;
    if (!kind && operation !== "get_window_state" && operation !== "bring_to_front") return;

    const thread = this.touch(threadId);
    if (pid !== undefined) this.aim(thread, pid, number(input.window_id));
    if (!kind) {
      this.emit(threadId, thread);
      return;
    }
    for (const earlier of thread.actions) if (earlier.status === "running") earlier.status = "done";
    thread.actions.push(this.action(thread, operation, kind, input, callId));
    if (thread.actions.length > this.limits.actions) thread.actions.splice(0, thread.actions.length - this.limits.actions);
    this.emit(threadId, thread);
  }

  /** A computer-use call answered. */
  toolResult(threadId: string, toolName: string, rawInput: unknown, callId: string, outcome: ToolOutcome): void {
    if (!toolName.startsWith(COMPUTER_USE_TOOL_PREFIX)) return;
    const operation = toolName.slice(COMPUTER_USE_TOOL_PREFIX.length);
    const input = fields(rawInput);
    const details = fields(outcome.details);
    if (operation === "list_windows") {
      this.noteWindowNames(details.windows);
      return;
    }
    const thread = this.threads.get(threadId);
    const action = thread?.actions.find((candidate) => candidate.id === callId);
    if (thread && action) {
      action.status = outcome.isError ? "failed" : "done";
      this.emit(threadId, thread);
    }
    if (operation !== "get_window_state" || outcome.isError) return;
    const pid = number(input.pid) ?? number(details.pid);
    const windowId = number(input.window_id);
    if (pid === undefined || windowId === undefined) return;
    const image = outcome.content?.map(fields).find((entry) => entry.type === "image" && typeof entry.data === "string");
    this.noteSnapshot(pid, windowId, details);
    if (!image) return;
    this.addFrame(threadId, pid, windowId, String(image.data), text(image.mimeType) ?? "image/png", details);
  }

  private touch(threadId: string): ThreadScreen {
    let thread = this.threads.get(threadId);
    if (thread) {
      // Most recently used last, so the first entry is the one to let go.
      this.threads.delete(threadId);
    } else {
      thread = { frames: [], actions: [], updatedAt: this.now() };
    }
    this.threads.set(threadId, thread);
    while (this.threads.size > this.limits.threads) this.threads.delete(this.threads.keys().next().value!);
    return thread;
  }

  private aim(thread: ThreadScreen, pid: number, windowId: number | undefined): void {
    const same = thread.window?.pid === pid;
    const id = windowId ?? (same ? thread.window?.windowId : undefined);
    const names = this.names.get(windowKey(pid, id)) ?? {};
    const app = names.app ?? this.appOf(pid) ?? (same ? thread.window?.app : undefined);
    const title = names.title ?? (same && id === thread.window?.windowId ? thread.window?.title : undefined);
    thread.window = { pid, ...(id !== undefined ? { windowId: id } : {}), ...(app ? { app } : {}), ...(title ? { title } : {}) };
  }

  private appOf(pid: number): string | undefined {
    for (const [key, names] of this.names) if (key.startsWith(`${pid}:`) && names.app) return names.app;
    return undefined;
  }

  private action(thread: ThreadScreen, operation: string, kind: ScreenActionKind, input: Fields, id: string): ScreenAction {
    const action: ScreenAction = { id, kind, at: this.now(), status: "running" };
    const window = thread.window;
    const snapshot = window?.windowId !== undefined ? this.snapshots.get(windowKey(window.pid, window.windowId)) : undefined;
    const lastFrame = thread.frames.at(-1);
    const space = snapshot ? { width: snapshot.width, height: snapshot.height } : lastFrame ? { width: lastFrame.width, height: lastFrame.height } : undefined;
    const pixels = input.from_zoom !== true;
    if (kind === "drag") {
      const from = point(input.from_x, input.from_y), to = point(input.to_x, input.to_y);
      if (pixels && from && to) Object.assign(action, { point: from, to });
    } else {
      const at = pixels ? point(input.x, input.y) : undefined;
      const element = at ? undefined : this.elementPoint(snapshot, input);
      if (at ?? element) action.point = at ?? element;
    }
    if (action.point && space) action.space = space;
    if (kind === "type") {
      const typed = text(input.text) ?? text(input.value);
      if (typed) action.text = typed.length > MAX_TEXT ? `${typed.slice(0, MAX_TEXT)}…` : typed;
    }
    if (kind === "key") {
      const keys = keysOf(operation, input);
      if (keys?.length) action.keys = keys;
    }
    if (kind === "scroll" && (input.direction === "up" || input.direction === "down" || input.direction === "left" || input.direction === "right")) {
      action.direction = input.direction;
    }
    return action;
  }

  /** An element-addressed call, placed at the element's centre in screenshot pixels. */
  private elementPoint(snapshot: Snapshot | undefined, input: Fields): ScreenPoint | undefined {
    if (!snapshot) return undefined;
    const token = text(input.element_token);
    const index = number(input.element_index);
    const element = (token ? snapshot.elements.get(token) : undefined) ?? (index !== undefined ? snapshot.elements.get(String(index)) : undefined);
    if (!element) return undefined;
    const scaleX = snapshot.width / snapshot.window.w, scaleY = snapshot.height / snapshot.window.h;
    const x = (element.x + element.w / 2 - snapshot.window.x) * scaleX;
    const y = (element.y + element.h / 2 - snapshot.window.y) * scaleY;
    if (x < 0 || y < 0 || x > snapshot.width || y > snapshot.height) return undefined;
    return { x: Math.round(x), y: Math.round(y) };
  }

  private noteWindowNames(windows: unknown): void {
    if (!Array.isArray(windows)) return;
    for (const entry of windows.map(fields)) {
      const pid = number(entry.pid), windowId = number(entry.window_id);
      if (pid === undefined || windowId === undefined) continue;
      const key = windowKey(pid, windowId);
      this.names.delete(key);
      this.names.set(key, { app: text(entry.app_name), title: text(entry.title) });
    }
    while (this.names.size > MAX_WINDOW_NAMES) this.names.delete(this.names.keys().next().value!);
  }

  private noteSnapshot(pid: number, windowId: number, details: Fields): void {
    const width = number(details.screenshot_width), height = number(details.screenshot_height);
    const elements = Array.isArray(details.elements) ? details.elements.map(fields) : [];
    const windowElement = elements.find((element) => element.role === "AXWindow");
    const frame = box(windowElement?.frame);
    const title = text(windowElement?.label);
    const key = windowKey(pid, windowId);
    if (title) this.names.set(key, { ...this.names.get(key), title });
    if (!frame || width === undefined || height === undefined) return;
    const boxes = new Map<string, Box>();
    for (const element of elements) {
      const place = box(element.frame);
      if (!place) continue;
      const index = number(element.element_index);
      if (index !== undefined) boxes.set(String(index), place);
      const token = text(element.element_token);
      if (token) boxes.set(token, place);
    }
    this.snapshots.delete(key);
    this.snapshots.set(key, { window: frame, width, height, elements: boxes });
    while (this.snapshots.size > this.limits.threads * 2) this.snapshots.delete(this.snapshots.keys().next().value!);
  }

  private addFrame(threadId: string, pid: number, windowId: number, data: string, mimeType: string, details: Fields): void {
    const size = number(details.screenshot_width) && number(details.screenshot_height)
      ? { width: number(details.screenshot_width)!, height: number(details.screenshot_height)! }
      : imageSize(data);
    if (!size) return;
    const thread = this.touch(threadId);
    this.aim(thread, pid, windowId);
    thread.frames.push({ seq: ++this.seq, at: this.now(), ...size, mimeType, window: { ...thread.window! }, data });
    if (thread.frames.length > this.limits.framesPerThread) thread.frames.splice(0, thread.frames.length - this.limits.framesPerThread);
    this.trim();
    this.emit(threadId, thread);
  }

  /** Oldest frames of the least recent threads go first; each thread keeps its newest. */
  private trim(): void {
    let total = 0;
    for (const thread of this.threads.values()) for (const frame of thread.frames) total += frame.data.length;
    for (const thread of this.threads.values()) {
      while (total > this.limits.bytes && thread.frames.length > 1) total -= thread.frames.shift()!.data.length;
    }
    for (const thread of this.threads.values()) {
      if (total <= this.limits.bytes) break;
      const frame = thread.frames.shift();
      if (frame) total -= frame.data.length;
    }
  }

  private emit(threadId: string, thread: ThreadScreen): void {
    thread.updatedAt = this.now();
    const state = this.state(threadId);
    if (state) this.publish(state);
  }
}

function point(x: unknown, y: unknown): ScreenPoint | undefined {
  const px = number(x), py = number(y);
  return px === undefined || py === undefined ? undefined : { x: px, y: py };
}

function frameInfo(frame: ScreenFrame): ScreenFrameInfo {
  const { data: _data, ...info } = frame;
  return { ...info, window: { ...info.window } };
}
