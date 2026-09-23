import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadRuntimeEvent, UiContextUsage, UiMessage, UiThreadUsage, UiToolRun, UsageTally } from "tau/host-extension";

/** Matches the host's own bound for a tool card; the durable result stays with Claude's session. */
export const MAX_TOOL_OUTPUT_BYTES = 128 * 1024;

export function boundedToolOutput(output: string): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= MAX_TOOL_OUTPUT_BYTES) return output;
  const tail = bytes.subarray(bytes.length - MAX_TOOL_OUTPUT_BYTES).toString("utf8");
  return `[Earlier tool output truncated; showing the latest ${MAX_TOOL_OUTPUT_BYTES} bytes.]\n${tail}`;
}

export interface TurnOutcome {
  /** Everything the main loop wrote, one entry per assistant message. */
  texts: string[];
  /** This turn's own tokens and cost; the backend adds them to the thread's total. */
  usage: UiThreadUsage;
  /** The same, one tally per model the turn called (sub-agents may run another). */
  tallies: UsageTally[];
  contextUsage?: UiContextUsage;
  error?: string;
  /** The turn was stopped, by the user or by the host; nothing went wrong. */
  interrupted?: boolean;
  /** A usage limit stopped the turn; the reset in epoch ms when the CLI named one. */
  limit?: { resetsAt?: number };
}

/** The CLI reports a stopped turn as an error result; its diagnostics are not for the user. */
function interruptedResult(message: ResultMessage): boolean {
  const reason = (message as { terminal_reason?: string }).terminal_reason;
  if (reason === "aborted_streaming" || reason === "aborted_tools") return true;
  const errors = (message as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every((error) => typeof error === "string" && (/^\[ede_diagnostic\]/u.test(error) || /interrupted|aborted/iu.test(error)));
}

export interface SdkSessionFacts {
  model?: string;
  claudeCodeVersion?: string;
  /** How the CLI authenticated, as the SDK names it; "none" is the subscription login. */
  apiKeySource?: string;
  /** The effort the session runs at, as the CLI reports it. */
  effort?: string;
  /** Every `rate_limit_event` of the turn, oldest first: the plan's windows as the CLI saw them. */
  rateLimits?: Array<Record<string, unknown>>;
}

const EMPTY_USAGE: UiThreadUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, turns: 0 };

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

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "")
    .filter(Boolean)
    .join("\n");
}

type ResultMessage = SDKMessage & { type: "result" };

function resultUsage(message: ResultMessage): UiThreadUsage {
  const models = Object.values((message as { modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }> }).modelUsage ?? {});
  if (models.length === 0) {
    const usage = message.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
    const input = usage?.input_tokens ?? 0;
    const output = usage?.output_tokens ?? 0;
    const read = usage?.cache_read_input_tokens ?? 0;
    const write = usage?.cache_creation_input_tokens ?? 0;
    return { inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write, totalTokens: input + output + read + write, costUsd: message.total_cost_usd ?? 0, turns: 1 };
  }
  const summed = models.reduce((total, model) => ({
    inputTokens: total.inputTokens + model.inputTokens,
    outputTokens: total.outputTokens + model.outputTokens,
    cacheReadTokens: total.cacheReadTokens + model.cacheReadInputTokens,
    cacheWriteTokens: total.cacheWriteTokens + model.cacheCreationInputTokens,
    costUsd: total.costUsd + model.costUSD,
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
  return {
    ...summed,
    totalTokens: summed.inputTokens + summed.outputTokens + summed.cacheReadTokens + summed.cacheWriteTokens,
    // The SDK's own estimate covers the same calls; prefer it when present.
    costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : summed.costUsd,
    turns: 1,
  };
}

type ModelUsage = { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number };

/** The turn's tokens per model, as `modelUsage` splits them; one tally for the session's model without it. */
export function resultTallies(message: ResultMessage, sessionModel: string | undefined): UsageTally[] {
  const models = Object.entries((message as { modelUsage?: Record<string, ModelUsage> }).modelUsage ?? {});
  if (models.length === 0) {
    const usage = resultUsage(message);
    return [{ provider: "anthropic", ...(sessionModel ? { model: sessionModel } : {}), inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, totalTokens: usage.totalTokens, costUsd: usage.costUsd, turns: 1 }];
  }
  // The turn counts once, for the model it ran on (or the first one named).
  const main = Math.max(0, models.findIndex(([name]) => name === sessionModel));
  // The SDK's own estimate wins, as in the total; it is spread over the models by their share.
  const named = models.reduce((sum, [, usage]) => sum + usage.costUSD, 0);
  const total = typeof message.total_cost_usd === "number" ? message.total_cost_usd : named;
  const costOf = (usage: ModelUsage, index: number) => named > 0 ? total * usage.costUSD / named : index === main ? total : 0;
  return models.map(([model, usage], index) => {
    const tally = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadInputTokens,
      cacheWriteTokens: usage.cacheCreationInputTokens,
    };
    return {
      provider: "anthropic",
      model,
      ...tally,
      totalTokens: tally.inputTokens + tally.outputTokens + tally.cacheReadTokens + tally.cacheWriteTokens,
      costUsd: costOf(usage, index),
      turns: index === main ? 1 : 0,
    };
  });
}

function resultContextUsage(message: ResultMessage): UiContextUsage | undefined {
  const usage = message.usage as { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
  const tokens = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);
  const windows = Object.values((message as { modelUsage?: Record<string, { contextWindow?: number }> }).modelUsage ?? {}).map((model) => model.contextWindow ?? 0);
  const contextWindow = Math.max(0, ...windows);
  if (!tokens || !contextWindow) return undefined;
  return { tokens, contextWindow, percent: Math.min(100, Math.round((tokens / contextWindow) * 1000) / 10) };
}

function resultErrorText(message: ResultMessage): string {
  const candidate = message as { subtype: string; result?: unknown; errors?: unknown };
  const parts = [
    ...(Array.isArray(candidate.errors) ? candidate.errors.map(String) : []),
    typeof candidate.result === "string" ? candidate.result : "",
  ].map((part) => part.trim()).filter(Boolean);
  return parts.join("\n") || candidate.subtype;
}

function formatWait(resetsAtSeconds: number, now: number): string {
  const seconds = Math.max(0, Math.round(resetsAtSeconds - now / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${Math.max(1, minutes)} min`;
}

/**
 * Turns one turn's SDK frames into Tau runtime events. Text and thinking stream
 * from the partial events of the main loop; a tool card opens when the complete
 * assistant message names the call, so its arguments are whole, and closes on
 * the tool result. Sub-agent frames carry `parent_tool_use_id`: their narration
 * stays out of the transcript, their tool calls show as cards of the turn.
 */
export class SdkTurnTranslator {
  readonly facts: SdkSessionFacts = {};
  readonly running = new Map<string, UiToolRun>();
  outcome?: TurnOutcome;
  private assistantId?: string;
  private assistantStarted = false;
  private texts: string[] = [];
  private sawAssistant = false;
  private readonly noticed = new Set<string>();
  /** A limit the CLI rejected this turn with; the error result that follows is that limit. */
  private rejected?: { resetsAt?: number };

  constructor(private readonly now: () => number = Date.now, private readonly nextId: () => string = () => `claude-assistant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`) {}

  push(message: SDKMessage): ThreadRuntimeEvent[] {
    switch (message.type) {
      case "stream_event":
        return this.streamEvent(message);
      case "assistant":
        return this.assistant(message);
      case "user":
        return this.user(message);
      case "result":
        return this.result(message);
      case "system":
        return this.system(message);
      case "rate_limit_event":
        return this.rateLimit(message);
      default:
        return [];
    }
  }

  private streamEvent(message: SDKMessage & { type: "stream_event" }): ThreadRuntimeEvent[] {
    if (message.parent_tool_use_id) return [];
    const event = message.event as { type: string; delta?: { type?: string; text?: string; thinking?: string } };
    if (event.type === "message_start") {
      this.assistantId = this.nextId();
      this.assistantStarted = false;
      return [];
    }
    if (event.type !== "content_block_delta" || !event.delta) return [];
    const id = this.assistantId ??= this.nextId();
    const events: ThreadRuntimeEvent[] = [];
    if (!this.assistantStarted && (event.delta.type === "text_delta" || event.delta.type === "thinking_delta")) {
      this.assistantStarted = true;
      events.push({ type: "assistant-start", id, timestamp: this.now() });
    }
    if (event.delta.type === "text_delta" && event.delta.text) events.push({ type: "assistant-delta", id, delta: event.delta.text });
    else if (event.delta.type === "thinking_delta" && event.delta.thinking) events.push({ type: "assistant-thinking", id, delta: event.delta.thinking });
    return events;
  }

  private assistant(message: SDKMessage & { type: "assistant" }): ThreadRuntimeEvent[] {
    const events: ThreadRuntimeEvent[] = [];
    const content = Array.isArray(message.message.content) ? message.message.content : [];
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      const tool: UiToolRun = { id: block.id, name: block.name, args: (block.input ?? {}) as Record<string, unknown>, status: "running", startedAt: this.now() };
      this.running.set(tool.id, tool);
      events.push({ type: "tool-start", tool });
    }
    if (message.parent_tool_use_id) return events;
    this.sawAssistant = true;
    const text = content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("\n\n").trim();
    const thinking = content.filter((block) => block.type === "thinking").map((block) => (block as { thinking: string }).thinking).join("\n\n").trim();
    const id = this.assistantId ?? this.nextId();
    this.assistantId = undefined;
    this.assistantStarted = false;
    if (text || thinking) {
      this.texts.push(text);
      const ui: UiMessage = { id, role: "assistant", text, timestamp: this.now(), ...(thinking ? { thinking } : {}) };
      // Tool cards belong after the text that announced them; the host appends in order.
      events.unshift({ type: "assistant-end", message: ui });
    }
    return events;
  }

  private user(message: SDKMessage & { type: "user" }): ThreadRuntimeEvent[] {
    const content = message.message.content;
    if (!Array.isArray(content)) return [];
    const events: ThreadRuntimeEvent[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object" || (block as { type?: string }).type !== "tool_result") continue;
      const result = block as { tool_use_id: string; content?: unknown; is_error?: boolean };
      const previous = this.running.get(result.tool_use_id);
      const output = boundedToolOutput(textOf(result.content));
      const tool: UiToolRun = {
        id: result.tool_use_id,
        name: previous?.name ?? "tool",
        args: previous?.args ?? {},
        status: result.is_error ? "error" : "done",
        output,
        startedAt: previous?.startedAt ?? this.now(),
        endedAt: this.now(),
      };
      this.running.delete(tool.id);
      events.push({ type: "tool-end", tool });
    }
    return events;
  }

  private result(message: ResultMessage): ThreadRuntimeEvent[] {
    if (message.subtype !== "success" || message.is_error) {
      const blocked = (message as { terminal_reason?: string }).terminal_reason === "blocking_limit" ? {} : undefined;
      const limit = this.rejected ?? blocked;
      const tallies = resultTallies(message, this.facts.model);
      this.outcome = interruptedResult(message)
        ? { texts: this.texts, usage: resultUsage(message), tallies, interrupted: true }
        : { texts: this.texts, usage: resultUsage(message), tallies, error: resultErrorText(message), ...(limit ? { limit } : {}) };
      return [];
    }
    // A resumed session answers with an empty result before the turn.
    if (message.num_turns === 0 && !this.sawAssistant) return [];
    const contextUsage = resultContextUsage(message);
    const texts = this.texts.length > 0 ? this.texts : message.result ? [message.result] : [];
    this.outcome = { texts, usage: resultUsage(message), tallies: resultTallies(message, this.facts.model), ...(contextUsage ? { contextUsage } : {}) };
    return [];
  }

  private system(message: SDKMessage & { type: "system" }): ThreadRuntimeEvent[] {
    const subtype = (message as { subtype: string }).subtype;
    if (subtype === "init") {
      const init = message as { model?: string; claude_code_version?: string; apiKeySource?: string; effort?: string | null };
      this.facts.model = init.model;
      this.facts.claudeCodeVersion = init.claude_code_version;
      this.facts.apiKeySource = init.apiKeySource;
      if (init.effort) this.facts.effort = init.effort;
      return [];
    }
    if (subtype === "compact_boundary") {
      const metadata = (message as { compact_metadata?: { pre_tokens?: number; post_tokens?: number } }).compact_metadata;
      const detail = metadata?.pre_tokens ? ` (${metadata.pre_tokens.toLocaleString("en-US")} → ${(metadata.post_tokens ?? 0).toLocaleString("en-US")} tokens)` : "";
      return [{ type: "notice", message: `Claude compacted the conversation${detail}.`, level: "info" }];
    }
    if (subtype === "permission_denied") {
      const denied = message as { tool_name?: string; reason?: string };
      return [{ type: "notice", message: `Claude was not allowed to run ${denied.tool_name ?? "a tool"}${denied.reason ? `: ${denied.reason}` : "."}`, level: "warning" }];
    }
    return [];
  }

  private rateLimit(message: SDKMessage & { type: "rate_limit_event" }): ThreadRuntimeEvent[] {
    const info = message.rate_limit_info;
    (this.facts.rateLimits ??= []).push({ ...info });
    if (info.status !== "rejected" || info.isUsingOverage) return [];
    this.rejected = info.resetsAt ? { resetsAt: info.resetsAt * 1000 } : {};
    const key = `${info.rateLimitType ?? "limit"}:${info.resetsAt ?? 0}`;
    if (this.noticed.has(key)) return [];
    this.noticed.add(key);
    const wait = info.resetsAt ? ` It resumes in about ${formatWait(info.resetsAt, this.now())}.` : "";
    return [{ type: "notice", message: `Claude usage limit reached; this turn waits until the limit resets.${wait}`, level: "warning" }];
  }

  static emptyUsage(): UiThreadUsage {
    return { ...EMPTY_USAGE };
  }
}
