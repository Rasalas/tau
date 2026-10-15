import type { HostEvent, HostSnapshot, UiMessage, UiToolRun } from "../shared/contracts.js";
import { HOST_PROTOCOL_VERSION, catalogFromSnapshot, type HostUpdate, type ThreadDetail } from "../shared/host-protocol.js";
import type { LiveTurnState } from "./live-turn-state.js";

export interface TurnEventServices {
  emit(event: HostEvent): void;
  emitUpdate(update: HostUpdate): void;
  log(label: string, detail?: string): void;
  fail(error: unknown, sessionId: string): void;
  settledSnapshot(): Promise<HostSnapshot>;
  detailForSnapshot(snapshot: HostSnapshot): ThreadDetail;
  toolEnded(sessionId: string, tool: UiToolRun, cwd: string): void;
  turnSettled(sessionId: string, error: string | undefined, limit?: { resetsAt?: number }): void;
}

/** Owns live state transitions and their publication for both runtime dialects.
 * Journal correlation and durable transcript/activity storage belong to the adapters.
 */
export class TurnEvents {
  private readonly toolOwners = new Map<string, string>();
  private readonly generations = new WeakMap<LiveTurnState, number>();
  constructor(private readonly services: TurnEventServices) {}

  releaseTool(id: string): void { this.toolOwners.delete(id); }

  start(state: LiveTurnState, sessionId: string): void {
    this.generations.set(state, (this.generations.get(state) ?? 0) + 1);
    state.turnError = undefined;
    this.services.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "run", event: "started", sessionId });
    this.services.emit({ type: "agent-status", sessionId, running: true });
    this.services.log("agent.started", sessionId.slice(0, 8));
  }

  compaction(state: LiveTurnState, sessionId: string, running: boolean): void {
    state.isCompacting = running;
    this.services.emit({ type: "context-compaction", sessionId, running });
  }

  assistant(state: LiveTurnState, sessionId: string, event:
    | { type: "start"; id: string; timestamp: number }
    | { type: "text" | "thinking"; id: string; delta: string }
    | { type: "end"; message: UiMessage }): void {
    if (event.type === "start") {
      state.currentAssistantId = event.id;
      state.liveAssistant = { id: event.id, timestamp: event.timestamp, text: "", thinking: "" };
      this.services.emit({ type: "assistant-start", sessionId, id: event.id, timestamp: event.timestamp });
    } else if (event.type === "end") {
      if (state.currentAssistantId === event.message.id) {
        state.currentAssistantId = undefined;
        state.liveAssistant = undefined;
      }
      this.services.emit({ type: "assistant-end", sessionId, message: event.message });
    } else {
      // Late deltas must not recreate a finished answer or update another answer.
      if (state.currentAssistantId !== event.id) return;
      if (state.liveAssistant) state.liveAssistant[event.type === "text" ? "text" : "thinking"] += event.delta;
      this.services.emit({ type: event.type === "text" ? "assistant-delta" : "assistant-thinking", sessionId, id: event.id, delta: event.delta });
    }
  }

  tool(state: LiveTurnState, sessionId: string, cwd: string, event:
    | { type: "start" | "end"; tool: UiToolRun }
    | { type: "output"; id: string; output: string }): void {
    if (event.type === "output") {
      const previous = state.tools.get(event.id);
      if (!previous || this.toolOwners.get(event.id) !== sessionId) return;
      state.tools.set(event.id, { ...previous, output: event.output });
      this.services.emit({ type: "tool-update", sessionId, id: event.id, output: event.output });
    } else if (event.type === "start") {
      state.tools.set(event.tool.id, event.tool);
      this.toolOwners.set(event.tool.id, sessionId);
      this.services.emit({ type: "tool-start", sessionId, tool: event.tool });
      this.services.log("tool.started", event.tool.name);
    } else {
      this.services.toolEnded(sessionId, event.tool, cwd);
      this.services.emit({ type: "tool-end", sessionId, tool: event.tool });
      state.tools.delete(event.tool.id);
      this.releaseTool(event.tool.id);
      this.services.log("tool.ended", `${event.tool.name}:${event.tool.status}`);
    }
  }

  settle(state: LiveTurnState, sessionId: string, options: {
    snapshot: boolean; catalog?: boolean; error?: string; limit?: { resetsAt?: number };
    /** Pi closes answers at message_end; its run settlement may arrive after another answer starts. */
    retainAssistant?: boolean;
  }): void {
    if (state.isCompacting) this.compaction(state, sessionId, false);
    if (!options.retainAssistant) {
      state.currentAssistantId = undefined;
      state.liveAssistant = undefined;
    }
    if (options.limit) this.services.turnSettled(sessionId, options.error, options.limit);
    else this.services.turnSettled(sessionId, options.error);
    this.services.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "run", event: "settled", sessionId });
    this.services.emit({ type: "agent-status", sessionId, running: false });
    const generation = this.generations.get(state);
    if (options.snapshot) void this.services.settledSnapshot().then((snapshot) => {
      if (this.generations.get(state) !== generation || snapshot.sessionId !== sessionId || snapshot.isStreaming) return;
      this.services.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.services.detailForSnapshot(snapshot) });
      if (options.catalog) this.services.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: catalogFromSnapshot(snapshot) });
    }).catch((error) => this.services.fail(error, sessionId));
    this.services.log("agent.settled", sessionId.slice(0, 8));
  }
}
