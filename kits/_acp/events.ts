import type { ThreadRuntimeEvent, UiContextUsage, UiMessage, UiThreadUsage, UiToolRun } from "tau/host-extension";

/**
 * Turns the agent's `session/update` notifications and the prompt's answer
 * into Tau's runtime events: one assistant message per stretch of text, one
 * tool card per tool call, and the facts a session states about itself.
 */
export interface AcpTextBlock { type: "text"; text: string }
export interface AcpContentBlock { type: string; text?: string; data?: string; mimeType?: string; uri?: string; name?: string }
export interface AcpToolCallContent { type: string; content?: AcpContentBlock; path?: string; oldText?: string | null; newText?: string; terminalId?: string }
export interface AcpToolCallUpdate {
  toolCallId: string;
  title?: string | null;
  kind?: string | null;
  status?: string | null;
  content?: AcpToolCallContent[] | null;
  locations?: Array<{ path: string; line?: number | null }> | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: Record<string, unknown> | null;
}
export interface AcpSessionUpdate extends Omit<Partial<AcpToolCallUpdate>, "content"> {
  sessionUpdate: string;
  content?: AcpContentBlock | AcpToolCallContent[] | null;
  entries?: Array<{ content: string; status: string; priority?: string }>;
  availableCommands?: Array<{ name: string; description?: string; input?: { hint?: string } | null }>;
  currentModeId?: string;
  configOptions?: unknown[];
  used?: number;
  size?: number;
  cost?: { amount: number; currency: string } | null;
  _meta?: Record<string, unknown> | null;
}
export interface AcpPromptResponse {
  stopReason: string;
  usage?: { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null; cachedReadTokens?: number | null; cachedWriteTokens?: number | null; thoughtTokens?: number | null } | null;
}

export interface AcpCommand { name: string; description?: string; hint?: string }

export interface AcpTurnFacts {
  commands?: AcpCommand[];
  modeId?: string;
  configOptions?: unknown[];
  contextUsage?: UiContextUsage;
  /** Cumulative session cost, when the agent reports one. */
  sessionCostUsd?: number;
}

export interface AcpTurnOutcome {
  texts: string[];
  usage: UiThreadUsage;
  stopReason: string;
  cancelled: boolean;
}

const MAX_TOOL_OUTPUT_BYTES = 128 * 1024;
const EMPTY_USAGE: UiThreadUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, turns: 0 };

export function boundedToolOutput(output: string): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= MAX_TOOL_OUTPUT_BYTES) return output;
  const tail = bytes.subarray(bytes.length - MAX_TOOL_OUTPUT_BYTES).toString("utf8");
  return `[Earlier tool output truncated; showing the latest ${MAX_TOOL_OUTPUT_BYTES} bytes.]\n${tail}`;
}

export function addUsage(left: UiThreadUsage, right: UiThreadUsage): UiThreadUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd: left.costUsd + right.costUsd,
    turns: left.turns + right.turns,
  };
}

/** The tool card's name: the agent's title, else its kind. Generic titles read as their kind. */
export function toolName(update: Pick<AcpToolCallUpdate, "title" | "kind">): string {
  const title = update.title?.trim();
  if (title && !/^(?:tool call|terminal)$/iu.test(title)) return title;
  return update.kind?.trim() || "tool";
}

function textOfContent(content: AcpToolCallContent[] | null | undefined): string {
  if (!content) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (entry.type === "content" && entry.content?.type === "text" && entry.content.text) parts.push(entry.content.text);
    else if (entry.type === "diff" && entry.path) {
      const before = entry.oldText ?? "";
      parts.push(`${entry.path}\n${before ? `${before.split("\n").map((line) => `-${line}`).join("\n")}\n` : ""}${(entry.newText ?? "").split("\n").map((line) => `+${line}`).join("\n")}`);
    }
  }
  return parts.join("\n");
}

/** Native field names agents put on raw payloads (Google's among them); the ACP fields come first. */
function textOfRawOutput(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return "";
  const record = raw as Record<string, unknown>;
  for (const key of ["combinedOutput", "combined_output", "output", "stdout", "content", "result", "text"]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  try { return JSON.stringify(raw, null, 2).slice(0, MAX_TOOL_OUTPUT_BYTES); } catch { return ""; }
}

function argsOf(rawInput: unknown): Record<string, unknown> {
  return rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput as Record<string, unknown> : rawInput === undefined ? {} : { input: rawInput };
}

interface Segment { id: string; text: string; thinking: string; timestamp: number }

export class AcpTurnTranslator {
  readonly running = new Map<string, UiToolRun>();
  readonly facts: AcpTurnFacts = {};
  outcome?: AcpTurnOutcome;
  private segment?: Segment;
  private readonly texts: string[] = [];
  private segments = 0;

  /** `idPrefix` names the assistant messages: `antigravity-assistant-…`. */
  constructor(private readonly now: () => number = Date.now, private readonly idPrefix = "acp") {}

  static emptyUsage(): UiThreadUsage { return { ...EMPTY_USAGE }; }

  push(update: AcpSessionUpdate): ThreadRuntimeEvent[] {
    if (update["_meta"]?.isReplay === true) return [];
    switch (update.sessionUpdate) {
      case "agent_message_chunk": return this.chunk(update, "text");
      case "agent_thought_chunk": return this.chunk(update, "thinking");
      case "tool_call": return [...this.closeSegment(), ...this.toolCall(update as AcpToolCallUpdate, true)];
      case "tool_call_update": return this.toolCall(update as AcpToolCallUpdate, false);
      case "available_commands_update":
        this.facts.commands = (update.availableCommands ?? []).flatMap((command) => command.name?.trim()
          ? [{ name: command.name.trim(), ...(command.description?.trim() ? { description: command.description.trim() } : {}), ...(command.input?.hint?.trim() ? { hint: command.input.hint.trim() } : {}) }]
          : []);
        return [];
      case "current_mode_update":
        if (typeof update.currentModeId === "string" && update.currentModeId.trim()) this.facts.modeId = update.currentModeId.trim();
        return [];
      case "config_option_update":
        if (Array.isArray(update.configOptions)) this.facts.configOptions = update.configOptions;
        return [];
      case "usage_update": {
        if (typeof update.used === "number" && typeof update.size === "number" && update.size > 0) {
          this.facts.contextUsage = { tokens: update.used, contextWindow: update.size, percent: Math.min(100, Math.round((update.used / update.size) * 100)) };
        }
        if (update.cost && typeof update.cost.amount === "number" && /^usd$/iu.test(update.cost.currency ?? "")) this.facts.sessionCostUsd = update.cost.amount;
        return [];
      }
      default:
        return [];
    }
  }

  /** The prompt's answer ends the turn: the open text becomes a message, tools still running are closed. */
  finish(response: AcpPromptResponse): ThreadRuntimeEvent[] {
    const events = this.closeSegment();
    const cancelled = response.stopReason === "cancelled";
    for (const tool of [...this.running.values()]) {
      this.running.delete(tool.id);
      events.push({ type: "tool-end", tool: { ...tool, status: "error", output: tool.output || (cancelled ? "Interrupted." : "The turn ended before the tool did."), endedAt: this.now() } });
    }
    const usage = response.usage ?? undefined;
    const n = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    const input = n(usage?.inputTokens);
    const output = n(usage?.outputTokens);
    this.outcome = {
      texts: [...this.texts],
      usage: { inputTokens: input, outputTokens: output, cacheReadTokens: n(usage?.cachedReadTokens), cacheWriteTokens: n(usage?.cachedWriteTokens), totalTokens: n(usage?.totalTokens) || input + output, costUsd: 0, turns: 1 },
      stopReason: response.stopReason,
      cancelled,
    };
    return events;
  }

  /** A reply the agent sent outside the stream (a plan, say): it closes the open text and stands as a message of its own. */
  reply(text: string): ThreadRuntimeEvent[] {
    if (!text.trim()) return [];
    const events = this.closeSegment();
    events.push(...this.chunk({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, "text"));
    events.push(...this.closeSegment());
    return events;
  }

  /** A tool the agent reported through a method of its own: a card that starts and ends at once. */
  finishedTool(tool: { id: string; name: string; args?: Record<string, unknown>; output?: string; failed?: boolean }): ThreadRuntimeEvent[] {
    const started: UiToolRun = { id: tool.id, name: tool.name, args: tool.args ?? {}, status: "running", startedAt: this.now() };
    const output = tool.output ? boundedToolOutput(tool.output) : undefined;
    return [
      ...this.closeSegment(),
      { type: "tool-start", tool: started },
      { type: "tool-end", tool: { ...started, status: tool.failed ? "error" : "done", ...(output ? { output } : {}), endedAt: this.now() } },
    ];
  }

  /** The process died mid-turn. */
  abandon(): ThreadRuntimeEvent[] {
    return this.finish({ stopReason: "cancelled" });
  }

  private chunk(update: AcpSessionUpdate, field: "text" | "thinking"): ThreadRuntimeEvent[] {
    const content = update.content;
    const text = content && !Array.isArray(content) && content.type === "text" ? content.text ?? "" : "";
    if (!text) return [];
    const events: ThreadRuntimeEvent[] = [];
    if (!this.segment) {
      this.segments += 1;
      this.segment = { id: `${this.idPrefix}-assistant-${this.now()}-${this.segments}`, text: "", thinking: "", timestamp: this.now() };
      events.push({ type: "assistant-start", id: this.segment.id, timestamp: this.segment.timestamp });
    }
    this.segment[field] += text;
    events.push(field === "text" ? { type: "assistant-delta", id: this.segment.id, delta: text } : { type: "assistant-thinking", id: this.segment.id, delta: text });
    return events;
  }

  private closeSegment(): ThreadRuntimeEvent[] {
    const segment = this.segment;
    if (!segment) return [];
    this.segment = undefined;
    if (!segment.text.trim() && !segment.thinking.trim()) return [];
    const message: UiMessage = { id: segment.id, role: "assistant", text: segment.text, ...(segment.thinking ? { thinking: segment.thinking } : {}), timestamp: segment.timestamp };
    if (segment.text.trim()) this.texts.push(segment.text);
    return [{ type: "assistant-end", message }];
  }

  private toolCall(update: AcpToolCallUpdate, start: boolean): ThreadRuntimeEvent[] {
    if (!update.toolCallId) return [];
    const previous = this.running.get(update.toolCallId);
    if (!previous && !start && (update.status === "completed" || update.status === "failed") && update.rawOutput === undefined && !update.content) {
      // History replays a completed start before the result; nothing to show yet.
      return [];
    }
    const output = boundedToolOutput([textOfContent(update.content), update.rawOutput !== undefined ? textOfRawOutput(update.rawOutput) : ""].filter(Boolean).join("\n") || previous?.output || "");
    const tool: UiToolRun = {
      id: update.toolCallId,
      name: update.title || update.kind ? toolName(update) : previous?.name ?? "tool",
      args: update.rawInput !== undefined ? argsOf(update.rawInput) : previous?.args ?? {},
      status: "running",
      ...(output ? { output } : {}),
      startedAt: previous?.startedAt ?? this.now(),
    };
    const status = update.status ?? (start ? "pending" : undefined);
    if (status === "completed" || status === "failed") {
      this.running.delete(tool.id);
      const ended: UiToolRun = { ...tool, status: status === "failed" ? "error" : "done", endedAt: this.now() };
      return previous || start ? [...(previous ? [] : [{ type: "tool-start" as const, tool }]), { type: "tool-end", tool: ended }] : [{ type: "tool-start", tool }, { type: "tool-end", tool: ended }];
    }
    this.running.set(tool.id, tool);
    if (!previous) return [{ type: "tool-start", tool }];
    return output && output !== previous.output ? [{ type: "tool-update", id: tool.id, output }] : [];
  }
}
