import type { HostPushEvent } from "../shared/host-transport.js";
import { toolOutputDelta } from "../shared/tool-output-delta.js";

/** How long streamed text and tool output wait for more of the same before they are pushed. */
export const HOST_PUSH_COALESCE_MS = 50;

export interface CoalescerClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_CLOCK: CoalescerClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface HostPushCoalescerOptions {
  windowMs?: number;
  clock?: CoalescerClock;
}

/** The output a tool's last push carried, and that push's sequence. */
interface SentOutput {
  seq: number;
  output: string;
}

type TextEvent = Extract<HostPushEvent, { type: "assistant-delta" | "assistant-thinking" }>;
type ToolUpdate = Extract<HostPushEvent, { type: "tool-update" }>;

const toolKey = (sessionId: string, id: string) => `${sessionId}\u0000${id}`;

function coalesceKey(event: HostPushEvent): string | undefined {
  if (event.type === "assistant-delta" || event.type === "assistant-thinking") return `${event.type}\u0000${event.sessionId}\u0000${event.id}`;
  if (event.type === "tool-update") return `tool\u0000${toolKey(event.sessionId, event.id)}`;
  return undefined;
}

/**
 * Stands between the host's events and its push log. Text deltas of one
 * message are joined and a tool's output updates collapse to the latest for
 * up to `windowMs`; any other event pushes what waits first, so the order
 * between streams and everything else is kept. A tool's output then goes out
 * as a delta against the push that carried it before (`tool-update-delta`),
 * and whole again after `resendWholeOutputs`.
 */
export class HostPushCoalescer {
  private pending = new Map<string, HostPushEvent>();
  private timer: unknown;
  private readonly sent = new Map<string, SentOutput>();
  private readonly windowMs: number;
  private readonly clock: CoalescerClock;

  /** `record` numbers and delivers one push and answers its sequence. */
  constructor(private readonly record: (event: HostPushEvent) => number, options: HostPushCoalescerOptions = {}) {
    this.windowMs = options.windowMs ?? HOST_PUSH_COALESCE_MS;
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  publish(event: HostPushEvent): void {
    const key = coalesceKey(event);
    if (key === undefined) {
      this.flush();
      this.forward(event);
      return;
    }
    const waiting = this.pending.get(key);
    if (waiting && (event.type === "assistant-delta" || event.type === "assistant-thinking")) {
      (waiting as TextEvent).delta += event.delta;
    } else {
      this.pending.set(key, event.type === "tool-update" ? event : { ...event });
    }
    if (this.timer === undefined) {
      this.timer = this.clock.setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, this.windowMs);
    }
  }

  /** Pushes what waits now; a response must never overtake the events before it. */
  flush(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.size === 0) return;
    const pending = this.pending;
    this.pending = new Map();
    for (const event of pending.values()) this.forward(event);
  }

  /**
   * The next update of every running tool goes out whole. A client that
   * starts from a snapshot never saw the pushes a delta would refer to.
   */
  resendWholeOutputs(): void {
    this.sent.clear();
  }

  private forward(event: HostPushEvent): void {
    if (event.type === "tool-update") {
      this.sendToolOutput(event);
      return;
    }
    this.record(event);
    if (event.type === "tool-end") this.sent.delete(toolKey(event.sessionId, event.tool.id));
    if (event.type === "agent-status" && !event.running) {
      const prefix = toolKey(event.sessionId, "");
      for (const key of this.sent.keys()) if (key.startsWith(prefix)) this.sent.delete(key);
    }
  }

  private sendToolOutput(event: ToolUpdate): void {
    const key = toolKey(event.sessionId, event.id);
    const last = this.sent.get(key);
    if (last?.output === event.output) return;
    const delta = last && toolOutputDelta(last.output, event.output);
    const seq = last && delta
      ? this.record({ type: "tool-update-delta", sessionId: event.sessionId, id: event.id, after: last.seq, ...delta })
      : this.record(event);
    this.sent.set(key, { seq, output: event.output });
  }
}
