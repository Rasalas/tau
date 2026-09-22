import type { ThreadRuntimeEvent, UiContextUsage, UiMessage, UiThreadUsage, UiToolRun } from "tau/host-extension";

/**
 * Turns the app-server's notifications for one turn into Tau's runtime
 * events: one assistant message per agent message item (with the reasoning
 * that led to it as thinking), one tool card per command, file change, MCP
 * call or web search, and the usage the thread states about itself.
 */

type Item = { type: string; id: string } & Record<string, unknown>;

interface TokenBreakdown { totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens?: number; outputTokens: number }
export interface CodexTokenUsage { total: TokenBreakdown; last: TokenBreakdown; modelContextWindow: number | null }

export interface CodexTurnOutcome {
  status: "completed" | "interrupted" | "failed";
  error?: string;
  texts: string[];
}

const MAX_TOOL_OUTPUT_BYTES = 128 * 1024;
const EMPTY_USAGE: UiThreadUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, turns: 0 };
/** Items that are not tools: the user's own echo, text and reasoning, and bookkeeping. */
const NOT_TOOLS = new Set(["userMessage", "agentMessage", "reasoning", "plan", "hookPrompt", "contextCompaction", "enteredReviewMode", "exitedReviewMode"]);

export function emptyUsage(): UiThreadUsage { return { ...EMPTY_USAGE }; }

function bounded(output: string): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= MAX_TOOL_OUTPUT_BYTES) return output;
  return `[Earlier output truncated; showing the latest ${MAX_TOOL_OUTPUT_BYTES} bytes.]\n${bytes.subarray(bytes.length - MAX_TOOL_OUTPUT_BYTES).toString("utf8")}`;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * The thread's running total as Tau counts it. Codex reports input with the
 * cached part included; Tau keeps the two apart so a sum never counts twice.
 */
export function threadUsage(usage: CodexTokenUsage, turns: number): UiThreadUsage {
  const total = usage.total;
  const cached = count(total.cachedInputTokens);
  return {
    inputTokens: Math.max(0, count(total.inputTokens) - cached),
    outputTokens: count(total.outputTokens),
    cacheReadTokens: cached,
    cacheWriteTokens: count(total.cacheWriteInputTokens),
    totalTokens: count(total.totalTokens),
    // A subscription bills no tokens; Codex reports no price either way.
    costUsd: 0,
    turns,
  };
}

export function contextUsage(usage: CodexTokenUsage): UiContextUsage | undefined {
  const window = count(usage.modelContextWindow);
  const tokens = count(usage.last.totalTokens);
  if (window <= 0 || tokens <= 0) return undefined;
  return { tokens, contextWindow: window, percent: Math.min(100, Math.round((tokens / window) * 100)) };
}

/** The command a user reads: the shell's `-lc` wrapper removed. */
export function displayCommand(command: string): string {
  const match = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/u.exec(command.trim());
  return match ? match[2]!.replace(/'\\''/gu, "'") : command;
}

/** The tool card an item becomes; undefined for items that are not tools. */
export function toolFor(item: Item, startedAt: number): UiToolRun | undefined {
  if (NOT_TOOLS.has(item.type)) return undefined;
  const base = { id: item.id, status: "running" as const, startedAt };
  switch (item.type) {
    case "commandExecution": {
      const command = displayCommand(String(item.command ?? ""));
      const actions = Array.isArray(item.commandActions) ? item.commandActions as Array<{ type?: string; path?: string; query?: string }> : [];
      const read = actions.length === 1 && actions[0]?.type === "read" && actions[0].path ? actions[0].path : undefined;
      return read
        ? { ...base, name: "read", args: { path: read, command } }
        : { ...base, name: "bash", args: { command, ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}) } };
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes as Array<{ path?: string; kind?: { type?: string } }> : [];
      const paths = changes.flatMap((change) => typeof change.path === "string" ? [change.path] : []);
      const added = changes.length > 0 && changes.every((change) => change.kind?.type === "add");
      return { ...base, name: added ? "write" : "edit", args: { ...(paths[0] ? { path: paths[0] } : {}), ...(paths.length > 1 ? { paths } : {}) } };
    }
    case "mcpToolCall":
      return { ...base, name: `mcp__${String(item.server ?? "server")}__${String(item.tool ?? "tool")}`, args: argsOf(item.arguments) };
    case "dynamicToolCall":
      return { ...base, name: String(item.tool ?? "tool"), args: argsOf(item.arguments) };
    case "webSearch":
      return { ...base, name: "web_search", args: { query: String(item.query ?? "") } };
    case "imageView":
      return { ...base, name: "view_image", args: { path: String(item.path ?? "") } };
    default:
      return { ...base, name: item.type, args: {} };
  }
}

function argsOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : value === undefined || value === null ? {} : { input: value };
}

/** What a finished item says, for its card. */
function outputOf(item: Item, streamed: string): string {
  switch (item.type) {
    case "commandExecution": {
      const text = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : streamed;
      const exit = typeof item.exitCode === "number" && item.exitCode !== 0 ? `\n[exit code ${item.exitCode}]` : "";
      return `${text}${exit}`;
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes as Array<{ path?: string; diff?: string }> : [];
      return changes.map((change) => `${change.path ?? ""}\n${change.diff ?? ""}`.trim()).join("\n\n") || streamed;
    }
    case "mcpToolCall": {
      const error = (item.error as { message?: string } | null)?.message;
      if (error) return error;
      const content = (item.result as { content?: Array<{ type?: string; text?: string }> } | null)?.content ?? [];
      return content.flatMap((entry) => entry.type === "text" && entry.text ? [entry.text] : []).join("\n") || streamed;
    }
    case "dynamicToolCall": {
      const items = Array.isArray(item.contentItems) ? item.contentItems as Array<{ type?: string; text?: string }> : [];
      return items.flatMap((entry) => entry.text ? [entry.text] : []).join("\n") || streamed;
    }
    default:
      return streamed;
  }
}

function failed(item: Item): boolean {
  if (item.status === "failed" || item.status === "declined") return true;
  if (item.type === "dynamicToolCall" && item.success === false) return true;
  return item.type === "mcpToolCall" && Boolean(item.error);
}

interface Segment { id: string; text: string; thinking: string; timestamp: number; itemId?: string; announced?: boolean }

export class CodexTurnTranslator {
  readonly running = new Map<string, UiToolRun>();
  /** File changes by item, so an approval can name what it would write. */
  readonly changes = new Map<string, string[]>();
  outcome?: CodexTurnOutcome;
  private segment?: Segment;
  private readonly texts: string[] = [];
  private readonly streamed = new Map<string, string>();
  private segments = 0;

  constructor(private readonly now: () => number = Date.now) {}

  push(method: string, params: Record<string, unknown>): ThreadRuntimeEvent[] {
    switch (method) {
      case "item/started": return this.itemStarted(params.item as Item);
      case "item/completed": return this.itemCompleted(params.item as Item);
      case "item/agentMessage/delta": return this.text(String(params.itemId ?? ""), String(params.delta ?? ""), "text");
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": return this.text(undefined, String(params.delta ?? ""), "thinking");
      case "item/reasoning/summaryPartAdded": return this.segment?.thinking ? this.text(undefined, "\n\n", "thinking") : [];
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": return this.toolOutput(String(params.itemId ?? ""), String(params.delta ?? ""));
      case "turn/completed": return this.finish(params.turn as { status?: string; error?: { message?: string } | null });
      default: return [];
    }
  }

  /** The turn ended without a `turn/completed` (the process died, or Tau gave up waiting). */
  abandon(status: "interrupted" | "failed", error?: string): ThreadRuntimeEvent[] {
    return this.finish({ status, ...(error ? { error: { message: error } } : {}) });
  }

  private itemStarted(item: Item | undefined): ThreadRuntimeEvent[] {
    if (!item || typeof item.id !== "string") return [];
    if (item.type === "agentMessage") {
      const events = this.segment?.itemId && this.segment.itemId !== item.id ? this.closeSegment() : [];
      this.open(item.id);
      return events;
    }
    const tool = toolFor(item, this.now());
    if (!tool || this.running.has(tool.id)) return [];
    if (item.type === "fileChange") this.changes.set(item.id, (tool.args.paths as string[] | undefined) ?? (tool.args.path ? [String(tool.args.path)] : []));
    this.running.set(tool.id, tool);
    return [...this.closeSegment(), { type: "tool-start", tool }];
  }

  private itemCompleted(item: Item | undefined): ThreadRuntimeEvent[] {
    if (!item || typeof item.id !== "string") return [];
    if (item.type === "agentMessage") {
      // The item's text is authoritative; deltas may have been dropped or never sent.
      const segment = this.open(item.id);
      const text = typeof item.text === "string" ? item.text : segment.text;
      const events = text.startsWith(segment.text) && text.length > segment.text.length ? this.text(item.id, text.slice(segment.text.length), "text") : [];
      segment.text = text;
      return [...events, ...this.closeSegment()];
    }
    if (item.type === "contextCompaction") return [{ type: "notice", message: "Codex compacted the conversation to fit its context window.", level: "info" }];
    const started = this.running.get(item.id);
    const tool = started ?? toolFor(item, this.now());
    if (!tool) return [];
    this.running.delete(item.id);
    const output = bounded(outputOf(item, this.streamed.get(item.id) ?? ""));
    this.streamed.delete(item.id);
    const ended: UiToolRun = { ...tool, status: failed(item) ? "error" : "done", ...(output ? { output } : {}), endedAt: this.now() };
    return [...(started ? [] : [...this.closeSegment(), { type: "tool-start" as const, tool }]), { type: "tool-end", tool: ended }];
  }

  private toolOutput(itemId: string, delta: string): ThreadRuntimeEvent[] {
    if (!delta || !this.running.has(itemId)) return [];
    const output = bounded(`${this.streamed.get(itemId) ?? ""}${delta}`);
    this.streamed.set(itemId, output);
    return [{ type: "tool-update", id: itemId, output }];
  }

  /** The segment text goes into; announced to the workbench with its first character. */
  private open(itemId: string | undefined): Segment {
    if (this.segment) {
      if (itemId && !this.segment.itemId) this.segment.itemId = itemId;
      return this.segment;
    }
    this.segments += 1;
    const timestamp = this.now();
    this.segment = { id: `codex-assistant-${timestamp}-${this.segments}`, text: "", thinking: "", timestamp, ...(itemId ? { itemId } : {}) };
    return this.segment;
  }

  private text(itemId: string | undefined, delta: string, field: "text" | "thinking"): ThreadRuntimeEvent[] {
    if (!delta) return [];
    const segment = this.open(itemId);
    const events: ThreadRuntimeEvent[] = [];
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

  private finish(turn: { status?: string; error?: { message?: string } | null } | undefined): ThreadRuntimeEvent[] {
    if (this.outcome) return [];
    const events = this.closeSegment();
    const status = turn?.status === "interrupted" ? "interrupted" : turn?.status === "failed" ? "failed" : "completed";
    for (const tool of [...this.running.values()]) {
      this.running.delete(tool.id);
      const output = this.streamed.get(tool.id) || (status === "interrupted" ? "Interrupted." : "The turn ended before the tool did.");
      events.push({ type: "tool-end", tool: { ...tool, status: "error", output, endedAt: this.now() } });
    }
    const error = turn?.error?.message?.trim();
    this.outcome = { status, texts: [...this.texts], ...(error ? { error } : {}) };
    return events;
  }
}
