import type { ThreadRuntimeEvent } from "tau/host-extension";
import { NativeAgentTracker } from "../agents/native-events.js";

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.map((block) => string(object(block).text) ?? "").filter(Boolean).join("\n") : "";
}

/** Claude's Agent calls and task bookends share the originating tool-use id. */
export class ClaudeNativeAgents {
  readonly tracker = new NativeAgentTracker("claude-code");
  private readonly tasks = new Map<string, string>();
  /** A SendMessage that resumed an agent, to the row the agent already has. */
  private readonly resumedBy = new Map<string, string>();
  private readonly background = new Set<string>();
  private readonly streamingMessage = new Map<string, string>();
  owns(id: string): boolean { return this.tracker.has(id); }
  private row(toolUseId: string | undefined): string | undefined { return toolUseId ? this.resumedBy.get(toolUseId) ?? toolUseId : undefined; }

  push(raw: unknown): ThreadRuntimeEvent[] {
    const frame = object(raw);
    const message = object(frame.message);
    const content = Array.isArray(message.content) ? message.content.map(object) : [];
    const events: ThreadRuntimeEvent[] = [];
    if (frame.type === "assistant") {
      for (const block of content) {
        if (block.type !== "tool_use" || (block.name !== "Agent" && block.name !== "Task")) continue;
        const id = string(block.id);
        const input = object(block.input);
        if (!id) continue;
        if (input.run_in_background === true) this.background.add(id);
        events.push(...this.tracker.update(id, { title: string(input.description) ?? string(input.subagent_type) ?? "Subagent", ...(string(input.model) ? { model: string(input.model) } : {}) }));
      }
    }
    const parent = this.row(string(frame.parent_tool_use_id));
    if (frame.type === "tool_progress") {
      // A foreground command past 30 s sends heartbeats under its own id; only an agent's tools count.
      if (parent && this.owns(parent) && frame.heartbeat !== true) events.push(...this.tracker.update(parent, { lastTool: string(frame.tool_name) }));
      return events;
    }
    if (parent) {
      // A launch Tau did not see, such as one from before a restart: the frames name its task.
      if (!this.owns(parent) && frame.type === "assistant") events.push(...this.tracker.update(parent, { title: string(frame.task_description) ?? string(frame.subagent_type) ?? "Subagent" }));
      if (!this.owns(parent)) return events;
      if (frame.type === "assistant") {
        if (string(message.model)) events.push(...this.tracker.update(parent, { model: string(message.model) }));
        const text = contentText(content);
        if (text) events.push(...this.tracker.text(parent, string(message.id) ?? this.streamingMessage.get(parent) ?? "reply", text));
        for (const block of content) {
          if (block.type === "tool_use" && typeof block.name === "string") {
            events.push(...this.tracker.update(parent, { lastTool: block.name }), ...this.tracker.text(parent, `tool:${String(block.id)}`, block.name));
          }
        }
      }
      if (frame.type === "stream_event") {
        const event = object(frame.event);
        const delta = object(event.delta);
        if (event.type === "message_start") this.streamingMessage.set(parent, string(object(event.message).id) ?? "reply");
        if (delta.type === "text_delta" && typeof delta.text === "string") events.push(...this.tracker.text(parent, this.streamingMessage.get(parent) ?? "reply", delta.text, true));
      }
      return events;
    }
    if (frame.type === "system" && typeof frame.task_id === "string") {
      const id = this.row(string(frame.tool_use_id)) ?? this.tasks.get(frame.task_id);
      if (frame.subtype === "task_started") {
        // Background shells and housekeeping are not subagents.
        if (frame.ambient || frame.skip_transcript || (frame.task_type !== "local_agent" && !frame.subagent_type && !(id && this.owns(id)))) return events;
        // SendMessage resumes an agent under its own tool id; the agent keeps its row.
        const known = this.tasks.get(frame.task_id);
        const toolUseId = string(frame.tool_use_id);
        if (known && toolUseId && toolUseId !== known) this.resumedBy.set(toolUseId, known);
        const handle = known ?? id ?? frame.task_id;
        this.tasks.set(frame.task_id, handle);
        if (frame.is_backgrounded !== false) this.background.add(handle);
        events.push(...this.tracker.update(handle, { title: string(frame.description) ?? "Subagent", ...(known ? { status: "running" as const } : {}) }));
      } else if (id && this.owns(id)) {
        if (frame.subtype === "task_notification") {
          this.background.delete(id);
          events.push(...this.tracker.update(id, { status: frame.status === "failed" ? "failed" : frame.status === "stopped" ? "cancelled" : "completed" }));
          if (string(frame.summary)) events.push(...this.tracker.text(id, "result", String(frame.summary)));
        } else if (frame.subtype === "task_progress") events.push(...this.tracker.update(id, { lastTool: string(frame.summary) ?? string(frame.last_tool_name) ?? string(frame.description) }));
        else if (frame.subtype === "task_updated" && object(frame.patch).is_backgrounded === true) this.background.add(id);
      }
    }
    if (frame.type === "user") {
      for (const block of content) {
        const id = string(block.tool_use_id);
        if (block.type !== "tool_result" || !id || !this.owns(id)) continue;
        const text = contentText(block.content);
        if (text) events.push(...this.tracker.text(id, "result", text));
        if (!this.background.has(id)) events.push(...this.tracker.update(id, { status: block.is_error ? "failed" : "completed" }));
      }
    }
    return events;
  }
}
