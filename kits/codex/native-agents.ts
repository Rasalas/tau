import type { ThreadRuntimeEvent } from "tau/host-extension";
import { NativeAgentTracker, type NativeAgentStatus } from "../agents/native-events.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function status(value: unknown): NativeAgentStatus {
  const kind = typeof value === "string" ? value : record(value).type;
  if (kind === "errored" || kind === "failed") return "failed";
  if (kind === "shutdown" || kind === "stopped") return "cancelled";
  if (kind === "completed") return "completed";
  if (kind === "idle") return "idle";
  if (kind === "waiting" || kind === "waitingForInput") return "waiting";
  return "running";
}

/** Both app-server generations identify native children explicitly. Unrelated threads stay unrelated. */
export class CodexNativeAgents {
  readonly tracker = new NativeAgentTracker("codex");

  push(method: string, params: Record<string, unknown>, root: string | undefined): { handled: boolean; events: ThreadRuntimeEvent[] } {
    const events: ThreadRuntimeEvent[] = [];
    const thread = record(params.thread);
    const source = record(record(record(thread.source).subAgent).thread_spawn);
    const parent = text(source.parent_thread_id);
    const child = text(thread.id);
    if (method === "thread/started" && child && child !== root && parent && (parent === root || this.tracker.has(parent))) {
      events.push(...this.tracker.update(child, { title: text(source.agent_nickname) ?? text(source.agent_role) ?? "Subagent", ...(text(thread.model) ? { model: text(thread.model) } : {}) }));
      return { handled: true, events };
    }
    const item = record(params.item);
    const owner = text(params.threadId);
    const own = owner === root || !!owner && this.tracker.has(owner);
    if (own && (method === "item/started" || method === "item/completed")) {
      if (item.type === "subAgentActivity") {
        const id = text(item.agentThreadId);
        if (id && id !== root && item.agentPath !== "/root" && item.agentPath !== "/") {
          events.push(...this.tracker.update(id, { title: text(item.agentNickname) ?? text(item.agentPath)?.split("/").at(-1) ?? "Subagent", ...(text(item.model) ? { model: text(item.model) } : {}), ...(item.kind === "closed" ? { status: "completed" as const } : item.kind === "started" ? { status: "running" as const } : {}) }));
        }
        return { handled: true, events };
      }
      if (item.type === "collabAgentToolCall") {
        const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
        for (const id of receivers) {
          if (typeof id !== "string" || id === root) continue;
          const info = record(record(item.agentsStates)[id]);
          const next = text(info.status);
          events.push(...this.tracker.update(id, { title: text(info.agentNickname) ?? text(item.prompt) ?? "Subagent", ...(text(item.model) ? { model: text(item.model) } : {}), ...(next ? { status: status(next) } : {}) }));
          if (text(info.message)) events.push(...this.tracker.text(id, "result", String(info.message)));
        }
        return { handled: true, events };
      }
    }
    if (!owner || !this.tracker.has(owner)) return { handled: false, events };
    switch (method) {
      case "turn/started": events.push(...this.tracker.update(owner, { status: "running" })); break;
      case "turn/completed": {
        const turn = record(params.turn);
        events.push(...this.tracker.update(owner, { status: turn.status === "failed" ? "failed" : turn.status === "interrupted" ? "cancelled" : "idle" }));
        if (text(record(turn.error).message)) events.push(...this.tracker.text(owner, "error", String(record(turn.error).message)));
        break;
      }
      case "thread/status/changed": events.push(...this.tracker.update(owner, { status: status(params.status) })); break;
      case "error":
        if (!params.willRetry) events.push(...this.tracker.update(owner, { status: "failed" }));
        if (text(record(params.error).message)) events.push(...this.tracker.text(owner, "error", String(record(params.error).message)));
        break;
      case "thread/closed": events.push(...this.tracker.update(owner, { status: "completed" })); break;
      case "item/agentMessage/delta": events.push(...this.tracker.text(owner, String(params.itemId), String(params.delta ?? ""), true)); break;
      case "item/started":
      case "item/completed": {
        if (item.type === "agentMessage") events.push(...this.tracker.text(owner, String(item.id), String(item.text ?? "")));
        // Thinking is the child's state, not a step of its run.
        else if (item.type === "reasoning") { if (method === "item/started") events.push(...this.tracker.update(owner, { lastTool: "Thinking" })); }
        else if (method === "item/started" && typeof item.type === "string" && item.type !== "userMessage") {
          const command = text(item.command);
          events.push(...this.tracker.tool(owner, String(item.id), text(item.tool) ?? (command ? "Shell" : String(item.type)), command));
        }
        break;
      }
    }
    return { handled: true, events };
  }
}
