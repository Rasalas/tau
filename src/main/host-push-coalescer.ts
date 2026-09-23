import type { HostEvent, UiTurnActivity } from "../shared/contracts.js";
import type { HostPushEvent } from "../shared/host-transport.js";
import { replaceTail, toolOutputDelta } from "../shared/tool-output-delta.js";
import { clientToolRun, liveToolOutput } from "./client-tool-output.js";

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

/** What a message streamed so far, and the push that last added to it. */
interface StreamedText {
  seq: number;
  text: string;
  thinking: string;
}

/** An ended message's text as clients have it from the push numbered `seq`. */
interface EndedText {
  seq: number;
  text: string;
  thinking?: string;
}

/** Ended messages a detail may refer to; older ones travel whole again. */
export const REMEMBERED_ENDED_MESSAGES = 64;

/** A shorter message travels whole: a reference would cost about as much. */
const MIN_REFERRED_CHARS = 64;

const textLength = (message: { text: string; thinking?: string }) => message.text.length + (message.thinking?.length ?? 0);

type TextEvent = Extract<HostPushEvent, { type: "assistant-delta" | "assistant-thinking" }>;
type AssistantEnd = Extract<HostEvent, { type: "assistant-end" }>;
type ToolUpdate = Extract<HostPushEvent, { type: "tool-update" }>;
type ToolEnd = Extract<HostEvent, { type: "tool-end" }>;
type HostUpdateEvent = Extract<HostEvent, { type: "host-update" }>;

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
 * between streams and everything else is kept. A running tool's output goes
 * out as its live tail, as a delta against the push that carried it before
 * (`tool-update-delta`), and whole again after `resendWholeOutputs`; its
 * `tool-end` refers to that push as well (`tool-end-delta`). A message's
 * `assistant-end` refers to the text it streamed (`assistant-end-delta`), and
 * a detail to the `assistant-end` that carried a message's text. A settled
 * detail's `turnActivity` travels once, inside its history.
 */
export class HostPushCoalescer {
  private pending = new Map<string, HostPushEvent>();
  private timer: unknown;
  private readonly sent = new Map<string, SentOutput>();
  private readonly streamed = new Map<string, StreamedText>();
  private readonly ended = new Map<string, EndedText>();
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

  /** Outputs and texts go out whole again: a client that starts from a snapshot never saw what a delta refers to. */
  resendWholeOutputs(): void {
    this.sent.clear();
    this.streamed.clear();
    this.ended.clear();
  }

  private forward(event: HostPushEvent): void {
    if (event.type === "tool-update") {
      this.sendToolOutput(event);
      return;
    }
    if (event.type === "tool-end") {
      this.sendToolEnd(event);
      return;
    }
    if (event.type === "assistant-end") {
      this.sendAssistantEnd(event);
      return;
    }
    if (event.type === "host-update" && event.update.type === "thread-detail") {
      this.record(this.compactDetail(event) ?? event);
      return;
    }
    const seq = this.record(event);
    if (event.type === "assistant-start") {
      this.streamed.set(toolKey(event.sessionId, event.id), { seq, text: "", thinking: "" });
    } else if (event.type === "assistant-delta" || event.type === "assistant-thinking") {
      const streamed = this.streamed.get(toolKey(event.sessionId, event.id));
      if (streamed) {
        streamed.seq = seq;
        streamed[event.type === "assistant-delta" ? "text" : "thinking"] += event.delta;
      }
    } else if (event.type === "assistant-anchor") {
      // A detail names the message by its persisted entry from here on.
      const ended = this.ended.get(toolKey(event.sessionId, event.id));
      if (ended) this.remember(toolKey(event.sessionId, event.sourceEntryId), ended);
    } else if (event.type === "agent-status") {
      const prefix = toolKey(event.sessionId, "");
      const forget = (map: Map<string, unknown>) => { for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key); };
      if (!event.running) forget(this.sent);
      // A new turn: the last one's messages travel whole from here on.
      else { forget(this.streamed); forget(this.ended); }
    }
  }

  private sendAssistantEnd(event: AssistantEnd): void {
    const key = toolKey(event.sessionId, event.message.id);
    const streamed = this.streamed.get(key);
    this.streamed.delete(key);
    const { text, thinking, ...message } = event.message;
    const seq = streamed && textLength(event.message) >= MIN_REFERRED_CHARS
      ? this.record({
        type: "assistant-end-delta",
        sessionId: event.sessionId,
        message,
        after: streamed.seq,
        text: replaceTail(streamed.text, text),
        ...(thinking === undefined ? {} : { thinking: replaceTail(streamed.thinking, thinking) }),
      })
      : this.record(event);
    this.remember(key, { seq, text, ...(thinking === undefined ? {} : { thinking }) });
  }

  private remember(key: string, ended: EndedText): void {
    this.ended.delete(key);
    this.ended.set(key, ended);
    if (this.ended.size > REMEMBERED_ENDED_MESSAGES) this.ended.delete(this.ended.keys().next().value!);
  }

  /** The detail without what repeats its last history entry or an ended message's text. */
  private compactDetail(event: HostUpdateEvent): HostPushEvent | undefined {
    if (event.update.type !== "thread-detail") return undefined;
    const { turnActivity, ...rest } = event.update.detail;
    const last = rest.turnActivityHistory?.at(-1);
    const activityFromHistory = Boolean(turnActivity && last && sameActivity(turnActivity, last));
    const texts: Record<string, number> = {};
    let referred = false;
    const messages = rest.messages.map((message) => {
      const ended = this.ended.get(toolKey(rest.sessionId, message.id));
      if (!ended || ended.text !== message.text || ended.thinking !== message.thinking || textLength(message) < MIN_REFERRED_CHARS) return message;
      texts[message.id] = ended.seq;
      referred = true;
      const { thinking: _thinking, ...withoutThinking } = message;
      return { ...withoutThinking, text: "" };
    });
    if (!activityFromHistory && !referred) return undefined;
    const detail = { ...(activityFromHistory ? rest : event.update.detail), messages };
    return {
      type: "thread-detail-compact",
      update: { ...event.update, detail },
      ...(activityFromHistory ? { activityFromHistory: true as const } : {}),
      ...(referred ? { texts } : {}),
    };
  }

  private sendToolOutput(event: ToolUpdate): void {
    const key = toolKey(event.sessionId, event.id);
    const last = this.sent.get(key);
    const output = liveToolOutput(event.output);
    if (last?.output === output) return;
    const delta = last && toolOutputDelta(last.output, output);
    const seq = last && delta
      ? this.record({ type: "tool-update-delta", sessionId: event.sessionId, id: event.id, after: last.seq, ...delta })
      : this.record(output === event.output ? event : { ...event, output });
    this.sent.set(key, { seq, output });
  }

  private sendToolEnd(event: ToolEnd): void {
    const key = toolKey(event.sessionId, event.tool.id);
    const last = this.sent.get(key);
    this.sent.delete(key);
    const tool = clientToolRun(event.tool);
    const { output, ...rest } = tool;
    const delta = last && output !== undefined
      ? (output === last.output ? { keep: output.length, drop: 0, text: "" } : toolOutputDelta(last.output, output))
      : undefined;
    if (last && output !== undefined && delta) {
      this.record({ type: "tool-end-delta", sessionId: event.sessionId, tool: rest, after: last.seq, length: output.length, ...delta });
    } else {
      this.record(tool === event.tool ? event : { ...event, tool });
    }
  }
}

function sameActivity(activity: UiTurnActivity, entry: UiTurnActivity): boolean {
  const fromEntry: UiTurnActivity = { tools: entry.tools, ...(entry.anchorMessageId === undefined ? {} : { anchorMessageId: entry.anchorMessageId }) };
  return JSON.stringify(activity) === JSON.stringify(fromEntry);
}
