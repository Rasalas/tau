import type { ThreadRuntimeEvent, UiMessage, UiToolRun } from "tau/host-extension";
import type { OpenCodeTokens } from "./client.js";
import type { TurnTranslator } from "./api.js";
import { bounded, record, toolCall, type OpenCodeTurnOutcome } from "./events.js";

/**
 * Turns OpenCode 2's session events into Tau's runtime events, the same ones
 * `OpenCodeTurnTranslator` makes of OpenCode 1's: one assistant message per
 * text part (the reasoning before it as thinking), tool cards, and the
 * execution events end the turn.
 */

/** A tool's name and arguments as Tau's cards read them; OpenCode 2 calls the shell `shell` and `glob` finds. */
export function toolCall2(tool: string, input: unknown): { name: string; args: Record<string, unknown> } {
  switch (tool) {
    case "shell": return { name: "bash", args: toolCall("bash", input).args };
    case "glob": return { name: "find", args: toolCall("find", input).args };
    default: return toolCall(tool, input);
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** What a finished tool says on its card: an edit's patches, else its text content. */
function successOutput(tool: string, data: Record<string, unknown>): string {
  const metadata = record(data.metadata);
  if ((tool === "edit" || tool === "write") && Array.isArray(metadata.files)) {
    const patches = metadata.files.map((file) => text(record(file).patch)).filter((patch) => patch.trim());
    if (patches.length) return patches.join("\n\n");
  }
  const output = contentText(data.content);
  const exit = typeof metadata.exit === "number" && metadata.exit !== 0 ? `\n[exit code ${metadata.exit}]` : "";
  return `${output}${exit}`;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const lines: string[] = [];
  for (const entry of content) {
    const item = record(entry);
    if (item.type === "text") lines.push(text(item.text));
    else if (item.type === "file") lines.push(`[${text(item.name) || text(item.uri) || "file"}]`);
  }
  return lines.join("\n");
}

interface Segment { id: string; text: string; thinking: string; timestamp: number; announced?: boolean; textPart?: string }

export class OpenCode2TurnTranslator implements TurnTranslator {
  /** Running tools by OpenCode's call id. */
  readonly running = new Map<string, UiToolRun>();
  outcome?: OpenCodeTurnOutcome;
  model?: { providerID: string; modelID: string };
  lastStep?: OpenCodeTokens & { total?: number };
  /** The text each text/reasoning part showed so far, keyed `<kind>:<message>:<ordinal>`. */
  private readonly parts = new Map<string, string>();
  private readonly ended = new Set<string>();
  /** Tool names from `tool.input.started`, by call id. */
  private readonly names = new Map<string, string>();
  /** What a running tool printed so far, by call id. */
  private readonly live = new Map<string, string>();
  private readonly texts: string[] = [];
  private segment?: Segment;
  private segments = 0;
  private error?: string;
  private aborted = false;
  /** OpenCode said the execution runs; an end before that belongs to an earlier run. */
  private busy = false;

  constructor(private readonly now: () => number = Date.now) {}

  lateTool(type: string, properties: Record<string, unknown>): ThreadRuntimeEvent[] {
    if (!this.running.has(text(properties.id))) return [];
    if (type === "session.tool.success") return this.toolEnded(properties, "done");
    if (type === "session.tool.failed") return this.toolEnded(properties, "error");
    return type === "session.tool.progress" ? this.progress(properties) : [];
  }

  push(type: string, properties: Record<string, unknown>): ThreadRuntimeEvent[] {
    if (this.outcome) return [];
    switch (type) {
      case "session.execution.started": this.busy = true; return [];
      case "session.step.started": return this.stepStarted(properties);
      case "session.step.ended": this.lastStep = record(properties.tokens) as OpenCodeTokens & { total?: number }; return [];
      case "session.step.failed": this.error = text(record(properties.error).message).trim() || this.error; return [];
      case "session.text.started": return this.partStarted("text", properties);
      case "session.text.delta": return this.partDelta("text", properties);
      case "session.text.ended": return this.partEnded("text", properties);
      case "session.reasoning.started": return this.partStarted("reasoning", properties);
      case "session.reasoning.delta": return this.partDelta("reasoning", properties);
      case "session.reasoning.ended": return this.partEnded("reasoning", properties);
      case "session.tool.input.started": return this.inputStarted(properties);
      case "session.tool.called": return this.called(properties);
      case "session.tool.progress": return this.progress(properties);
      case "session.tool.success": return this.toolEnded(properties, "done");
      case "session.tool.failed": return this.toolEnded(properties, "error");
      case "session.retry.scheduled": return this.retry(properties);
      case "session.compaction.ended": return [{ type: "notice", message: "OpenCode compacted the conversation to fit its context window.", level: "info" }];
      case "session.execution.succeeded": return this.busy ? this.finish("completed") : [];
      case "session.execution.failed": return this.busy ? this.executionFailed(properties) : [];
      case "session.execution.interrupted": return this.busy ? this.interrupted() : [];
      default: return [];
    }
  }

  /** The turn ended without OpenCode saying so: the server died, or Tau stopped waiting. */
  abandon(status: "interrupted" | "failed", error?: string): ThreadRuntimeEvent[] {
    if (status === "interrupted") this.aborted = true;
    if (error) this.error ??= error;
    return this.finish(status);
  }

  private stepStarted(data: Record<string, unknown>): ThreadRuntimeEvent[] {
    this.busy = true;
    const model = record(data.model);
    if (typeof model.providerID === "string" && typeof model.id === "string") this.model = { providerID: model.providerID, modelID: model.id };
    return [];
  }

  private key(kind: string, data: Record<string, unknown>): string {
    return `${kind}:${text(data.assistantMessageID)}:${typeof data.ordinal === "number" ? data.ordinal : 0}`;
  }

  private partStarted(kind: "text" | "reasoning", data: Record<string, unknown>): ThreadRuntimeEvent[] {
    this.busy = true;
    const key = this.key(kind, data);
    if (!this.parts.has(key)) this.parts.set(key, "");
    return [];
  }

  private partDelta(kind: "text" | "reasoning", data: Record<string, unknown>): ThreadRuntimeEvent[] {
    const key = this.key(kind, data);
    const delta = text(data.delta);
    if (this.ended.has(key) || !delta) return [];
    this.busy = true;
    this.parts.set(key, (this.parts.get(key) ?? "") + delta);
    return this.append(key, kind, delta);
  }

  private partEnded(kind: "text" | "reasoning", data: Record<string, unknown>): ThreadRuntimeEvent[] {
    const key = this.key(kind, data);
    if (this.ended.has(key)) return [];
    this.busy = true;
    this.ended.add(key);
    const known = this.parts.get(key) ?? "";
    const full = text(data.text);
    // A replay or a missed delta: the final text may carry more than was streamed.
    const events = full.startsWith(known) && full.length > known.length ? this.append(key, kind, full.slice(known.length)) : [];
    this.parts.set(key, full.startsWith(known) ? full : known);
    if (kind === "text") events.push(...this.closeSegment());
    return events;
  }

  private inputStarted(data: Record<string, unknown>): ThreadRuntimeEvent[] {
    const id = text(data.id);
    if (id && typeof data.name === "string") this.names.set(id, data.name);
    return [];
  }

  private called(data: Record<string, unknown>): ThreadRuntimeEvent[] {
    const id = text(data.id);
    if (!id || this.running.has(id)) return [];
    this.busy = true;
    const call = toolCall2(this.names.get(id) ?? "tool", data.input);
    const tool: UiToolRun = { id, name: call.name, args: call.args, status: "running", startedAt: this.now() };
    this.running.set(id, tool);
    return [...this.closeSegment(), { type: "tool-start", tool }];
  }

  private progress(data: Record<string, unknown>): ThreadRuntimeEvent[] {
    const id = text(data.id);
    const printed = record(data.metadata).output;
    if (!this.running.has(id) || typeof printed !== "string" || !printed || printed === this.live.get(id)) return [];
    this.live.set(id, printed);
    return [{ type: "tool-update", id, output: bounded(printed) }];
  }

  private toolEnded(data: Record<string, unknown>, status: "done" | "error"): ThreadRuntimeEvent[] {
    const id = text(data.id);
    if (!id) return [];
    this.busy = true;
    const name = this.names.get(id) ?? "tool";
    const started = this.running.get(id);
    this.running.delete(id);
    this.live.delete(id);
    const base: UiToolRun = started ?? { id, name: toolCall2(name, {}).name, args: {}, status: "running", startedAt: this.now() };
    const raw = status === "error" ? contentText(data.content) || text(record(data.error).message) || "The tool failed." : successOutput(name, data);
    const output = bounded(raw);
    const ended: UiToolRun = { ...base, status, ...(output ? { output } : {}), endedAt: this.now() };
    return [...(started ? [] : [...this.closeSegment(), { type: "tool-start" as const, tool: base }]), { type: "tool-end", tool: ended }];
  }

  private retry(data: Record<string, unknown>): ThreadRuntimeEvent[] {
    this.busy = true;
    const message = text(record(data.error).message) || "the provider did not answer";
    const attempt = typeof data.attempt === "number" ? data.attempt : 0;
    return [{ type: "notice", message: `OpenCode is retrying (attempt ${attempt}): ${message}`, level: "warning" }];
  }

  private executionFailed(data: Record<string, unknown>): ThreadRuntimeEvent[] {
    this.error = text(record(data.error).message).trim() || this.error || "OpenCode reported an error.";
    return this.finish("failed");
  }

  private interrupted(): ThreadRuntimeEvent[] {
    this.aborted = true;
    return this.finish("interrupted");
  }

  private open(): Segment {
    if (this.segment) return this.segment;
    this.segments += 1;
    const timestamp = this.now();
    this.segment = { id: `opencode-assistant-${timestamp}-${this.segments}`, text: "", thinking: "", timestamp };
    return this.segment;
  }

  private append(key: string, kind: "text" | "reasoning", delta: string): ThreadRuntimeEvent[] {
    const field = kind === "text" ? "text" : "thinking";
    // A second text part is a reply of its own.
    const events = kind === "text" && this.segment?.textPart && this.segment.textPart !== key ? this.closeSegment() : [];
    const segment = this.open();
    if (kind === "text") segment.textPart = key;
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

  private finish(status: "completed" | "interrupted" | "failed"): ThreadRuntimeEvent[] {
    if (this.outcome) return [];
    const events = this.closeSegment();
    for (const tool of [...this.running.values()]) {
      this.running.delete(tool.id);
      const output = this.live.get(tool.id) || (status === "interrupted" ? "Interrupted." : "The turn ended before the tool did.");
      events.push({ type: "tool-end", tool: { ...tool, status: "error", output, endedAt: this.now() } });
    }
    this.outcome = { status, texts: [...this.texts], ...(status === "failed" && this.error ? { error: this.error } : {}) };
    return events;
  }
}
