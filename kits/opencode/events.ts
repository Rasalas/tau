import type { ThreadRuntimeEvent, UiContextUsage, UiMessage, UiThreadUsage, UiToolRun } from "tau/host-extension";
import type { OpenCodeMessageInfo, OpenCodePart, OpenCodeTokens } from "./client.js";

/**
 * Turns OpenCode's events for one session into Tau's runtime events: text and
 * reasoning parts become one assistant message per text part (the reasoning
 * before it as thinking), tool parts become tool cards, and `session.status`
 * idle ends the turn. Parts of the user's own messages are skipped.
 */

export interface OpenCodeTurnOutcome {
  status: "completed" | "interrupted" | "failed";
  error?: string;
  texts: string[];
}

/** The server name Tau's MCP endpoint goes by; OpenCode names its tools `<server>_<tool>`. */
export const TAU_MCP_SERVER = "tau";
const MAX_TOOL_OUTPUT_BYTES = 128 * 1024;
const EMPTY_USAGE: UiThreadUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, turns: 0 };

export function emptyUsage(): UiThreadUsage { return { ...EMPTY_USAGE }; }

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** A session's running total as OpenCode keeps it; reasoning counts as output. */
export function sessionUsage(tokens: OpenCodeTokens | undefined, cost: unknown, turns: number): UiThreadUsage {
  const input = count(tokens?.input);
  const output = count(tokens?.output) + count(tokens?.reasoning);
  const cacheRead = count(tokens?.cache?.read);
  const cacheWrite = count(tokens?.cache?.write);
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, costUsd: count(cost), turns };
}

/** What the last step put in the context window, against the model's window. */
export function stepContext(tokens: (OpenCodeTokens & { total?: number }) | undefined, contextWindow: number | undefined): UiContextUsage | undefined {
  if (!tokens || !contextWindow) return undefined;
  const used = count(tokens.total) || count(tokens.input) + count(tokens.output) + count(tokens.reasoning) + count(tokens.cache?.read) + count(tokens.cache?.write);
  if (used <= 0) return undefined;
  return { tokens: used, contextWindow, percent: Math.min(100, Math.round((used / contextWindow) * 100)) };
}

function bounded(output: string): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= MAX_TOOL_OUTPUT_BYTES) return output;
  return `[Earlier output truncated; showing the latest ${MAX_TOOL_OUTPUT_BYTES} bytes.]\n${bytes.subarray(bytes.length - MAX_TOOL_OUTPUT_BYTES).toString("utf8")}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * A tool's name and arguments as Tau's cards read them: OpenCode's `filePath`
 * also as `path`, its `list` as `ls`, Tau's own MCP tools as `mcp__tau__…`.
 */
export function toolCall(tool: string, input: unknown): { name: string; args: Record<string, unknown> } {
  const args = { ...record(input) };
  if (typeof args.filePath === "string" && args.path === undefined) args.path = args.filePath;
  const prefix = `${TAU_MCP_SERVER}_`;
  if (tool.startsWith(prefix)) return { name: `mcp__${TAU_MCP_SERVER}__${tool.slice(prefix.length)}`, args };
  switch (tool) {
    case "list": return { name: "ls", args };
    case "websearch": return { name: "web_search", args };
    default: return { name: tool, args };
  }
}

/** What a finished tool part says on its card: an edit's diff, else the output. */
function toolOutput(tool: string, state: Record<string, unknown>): string {
  if (state.status === "error") return typeof state.error === "string" ? state.error : "The tool failed.";
  const metadata = record(state.metadata);
  if ((tool === "edit" || tool === "write" || tool === "apply_patch") && typeof metadata.diff === "string" && metadata.diff.trim()) return metadata.diff;
  const output = typeof state.output === "string" ? state.output : typeof metadata.output === "string" ? metadata.output : "";
  const exit = typeof metadata.exit === "number" && metadata.exit !== 0 ? `\n[exit code ${metadata.exit}]` : "";
  return `${output}${exit}`;
}

interface Segment { id: string; text: string; thinking: string; timestamp: number; announced?: boolean; textPart?: string }

export class OpenCodeTurnTranslator {
  /** Running tools by OpenCode's call id. */
  readonly running = new Map<string, UiToolRun>();
  outcome?: OpenCodeTurnOutcome;
  /** The model the turn's assistant messages ran on. */
  model?: { providerID: string; modelID: string };
  /** The last step's tokens, for the context meter. */
  lastStep?: OpenCodeTokens & { total?: number };
  private readonly roles = new Map<string, "user" | "assistant">();
  private readonly parts = new Map<string, { type: string; text: string }>();
  private readonly texts: string[] = [];
  private readonly ended = new Set<string>();
  /** What a running tool printed so far, by call id. */
  private readonly live = new Map<string, string>();
  private segment?: Segment;
  private segments = 0;
  private error?: string;
  private aborted = false;
  /** OpenCode said the session is working; an idle before that belongs to an earlier turn. */
  private busy = false;

  constructor(private readonly now: () => number = Date.now) {}

  /** Events of the thread's own session; the caller filters by session. */
  push(type: string, properties: Record<string, unknown>): ThreadRuntimeEvent[] {
    if (this.outcome) return [];
    switch (type) {
      case "message.updated": return this.message(properties.info as OpenCodeMessageInfo | undefined);
      case "message.part.updated": return this.part(properties.part as OpenCodePart | undefined);
      case "message.part.delta": return this.delta(String(properties.partID ?? ""), String(properties.field ?? ""), String(properties.delta ?? ""));
      case "session.status": return this.status(record(properties.status));
      case "session.idle": return this.busy ? this.finish() : [];
      case "session.error": return this.sessionError(record(properties.error));
      case "session.compacted": return [{ type: "notice", message: "OpenCode compacted the conversation to fit its context window.", level: "info" }];
      default: return [];
    }
  }

  /** The turn ended without OpenCode saying so: the server died, or Tau stopped waiting. */
  abandon(status: "interrupted" | "failed", error?: string): ThreadRuntimeEvent[] {
    if (status === "interrupted") this.aborted = true;
    if (error) this.error ??= error;
    return this.finish(status);
  }

  private message(info: OpenCodeMessageInfo | undefined): ThreadRuntimeEvent[] {
    if (!info || typeof info.id !== "string") return [];
    this.roles.set(info.id, info.role);
    if (info.role !== "assistant") return [];
    this.busy = true;
    if (info.providerID && info.modelID) this.model = { providerID: info.providerID, modelID: info.modelID };
    const error = info.error;
    if (error?.name === "MessageAbortedError") this.aborted = true;
    else if (error) this.error = error.data?.message?.trim() || error.name || "OpenCode reported an error.";
    return [];
  }

  private part(part: OpenCodePart | undefined): ThreadRuntimeEvent[] {
    if (!part || typeof part.id !== "string" || this.roles.get(part.messageID) !== "assistant") return [];
    this.busy = true;
    switch (part.type) {
      case "text":
      case "reasoning": {
        const known = this.parts.get(part.id) ?? { type: part.type, text: "" };
        this.parts.set(part.id, known);
        const full = typeof part.text === "string" ? part.text : "";
        const field = part.type === "text" ? "text" : "thinking";
        // The part carries its whole text so far; only what is new goes out.
        const events = full.startsWith(known.text) && full.length > known.text.length ? this.append(part.id, field, full.slice(known.text.length)) : [];
        known.text = full.startsWith(known.text) ? full : known.text;
        const finished = Boolean(record(part.time).end);
        if (part.type === "text" && finished && !this.ended.has(part.id)) {
          this.ended.add(part.id);
          events.push(...this.closeSegment());
        }
        return events;
      }
      case "tool": return this.tool(part);
      case "step-finish": {
        this.lastStep = record(part.tokens) as OpenCodeTokens & { total?: number };
        return [];
      }
      case "retry": {
        const message = record(part.error).message ?? record(record(part.error).data).message;
        return [{ type: "notice", message: `OpenCode is retrying${typeof message === "string" && message ? `: ${message}` : "."}`, level: "warning" }];
      }
      default: return [];
    }
  }

  private delta(partId: string, field: string, delta: string): ThreadRuntimeEvent[] {
    const known = this.parts.get(partId);
    if (!known || field !== "text" || !delta || this.ended.has(partId)) return [];
    known.text += delta;
    return this.append(partId, known.type === "text" ? "text" : "thinking", delta);
  }

  private tool(part: OpenCodePart): ThreadRuntimeEvent[] {
    const state = record(part.state);
    const status = state.status;
    const id = typeof part.callID === "string" && part.callID ? part.callID : part.id;
    const toolName = String(part.tool ?? "tool");
    if (status === "pending") return [];
    const call = toolCall(toolName, state.input);
    const started = this.running.get(id);
    if (status === "running") {
      const events: ThreadRuntimeEvent[] = [];
      let tool = started;
      if (!tool) {
        const at = typeof record(state.time).start === "number" ? record(state.time).start as number : this.now();
        tool = { id, name: call.name, args: call.args, status: "running", startedAt: at };
        this.running.set(id, tool);
        events.push(...this.closeSegment(), { type: "tool-start", tool });
      }
      const printed = record(state.metadata).output;
      if (typeof printed === "string" && printed && printed !== this.live.get(id)) {
        this.live.set(id, printed);
        events.push({ type: "tool-update", id, output: bounded(printed) });
      }
      return events;
    }
    if (status !== "completed" && status !== "error") return [];
    this.running.delete(id);
    this.live.delete(id);
    const base: UiToolRun = started ?? { id, name: call.name, args: call.args, status: "running", startedAt: this.now() };
    const output = bounded(toolOutput(toolName, state));
    const end = record(state.time).end;
    const ended: UiToolRun = { ...base, args: Object.keys(call.args).length ? call.args : base.args, status: status === "error" ? "error" : "done", ...(output ? { output } : {}), endedAt: typeof end === "number" ? end : this.now() };
    return [...(started ? [] : [...this.closeSegment(), { type: "tool-start" as const, tool: base }]), { type: "tool-end", tool: ended }];
  }

  private status(status: Record<string, unknown>): ThreadRuntimeEvent[] {
    if (status.type === "busy") { this.busy = true; return []; }
    if (status.type === "retry") {
      this.busy = true;
      const message = typeof status.message === "string" && status.message ? status.message : "the provider did not answer";
      return [{ type: "notice", message: `OpenCode is retrying (attempt ${count(status.attempt)}): ${message}`, level: "warning" }];
    }
    return status.type === "idle" && this.busy ? this.finish() : [];
  }

  private sessionError(error: Record<string, unknown>): ThreadRuntimeEvent[] {
    if (error.name === "MessageAbortedError") this.aborted = true;
    else this.error = String(record(error.data).message ?? error.name ?? "OpenCode reported an error.").trim();
    return [];
  }

  private open(): Segment {
    if (this.segment) return this.segment;
    this.segments += 1;
    const timestamp = this.now();
    this.segment = { id: `opencode-assistant-${timestamp}-${this.segments}`, text: "", thinking: "", timestamp };
    return this.segment;
  }

  private append(partId: string, field: "text" | "thinking", delta: string): ThreadRuntimeEvent[] {
    // A second text part is a reply of its own.
    const events = field === "text" && this.segment?.textPart && this.segment.textPart !== partId ? this.closeSegment() : [];
    const segment = this.open();
    if (field === "text") segment.textPart = partId;
    if (!segment.announced) {
      segment.announced = true;
      events.push({ type: "assistant-start", id: segment.id, timestamp: segment.timestamp });
    }
    segment[field] += delta;
    events.push(field === "text" ? { type: "assistant-delta", id: segment.id, delta } : { type: "assistant-thinking", id: segment.id, delta });
    return events;
  }

  private closeSegment(): ThreadRuntimeEvent[] {
    const segment = this.segment;
    if (!segment) return [];
    this.segment = undefined;
    const thinking = segment.thinking.trim();
    if (!segment.text.trim() && !thinking) return [];
    const message: UiMessage = { id: segment.id, role: "assistant", text: segment.text, ...(thinking ? { thinking } : {}), timestamp: segment.timestamp };
    if (segment.text.trim()) this.texts.push(segment.text);
    const start: ThreadRuntimeEvent[] = segment.announced ? [] : [{ type: "assistant-start", id: segment.id, timestamp: segment.timestamp }];
    return [...start, { type: "assistant-end", message }];
  }

  private finish(forced?: "interrupted" | "failed"): ThreadRuntimeEvent[] {
    if (this.outcome) return [];
    const events = this.closeSegment();
    const status = forced ?? (this.aborted ? "interrupted" : this.error ? "failed" : "completed");
    for (const tool of [...this.running.values()]) {
      this.running.delete(tool.id);
      const output = this.live.get(tool.id) || (status === "interrupted" ? "Interrupted." : "The turn ended before the tool did.");
      events.push({ type: "tool-end", tool: { ...tool, status: "error", output, endedAt: this.now() } });
    }
    this.outcome = { status, texts: [...this.texts], ...(status === "failed" && this.error ? { error: this.error } : {}) };
    return events;
  }
}
