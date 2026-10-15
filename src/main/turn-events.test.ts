import { describe, expect, it, vi } from "vitest";
import type { HostEvent, HostSnapshot, UiToolRun } from "../shared/contracts.js";
import type { HostUpdate } from "../shared/host-protocol.js";
import type { LiveTurnState } from "./live-turn-state.js";
import { handleRuntimeSessionEvent, type SessionEventServices } from "./session-events.js";
import { ClientTurnLedger } from "./client-turn-ledger.js";
import { TurnEvents } from "./turn-events.js";

function setup() {
  const events: HostEvent[] = [];
  const updates: HostUpdate[] = [];
  const services = {
    emit: (event: HostEvent) => { events.push(event); },
    emitUpdate: (update: HostUpdate) => { updates.push(update); },
    log: vi.fn(), fail: vi.fn(), toolEnded: vi.fn(), turnSettled: vi.fn(),
    settledSnapshot: vi.fn(async () => ({ sessionId: "one", isStreaming: false }) as HostSnapshot),
    detailForSnapshot: vi.fn(() => ({ sessionId: "one" }) as never),
  };
  const state: LiveTurnState = { tools: new Map() };
  return { turns: new TurnEvents(services), services, state, events, updates };
}

const tool: UiToolRun = { id: "tool", name: "read", args: {}, status: "running", startedAt: 1 };

describe("TurnEvents", () => {
  it("publishes one tool lifecycle and ignores output after completion or release", () => {
    const { turns, state, events, services } = setup();
    turns.tool(state, "one", "/repo", { type: "start", tool });
    turns.tool(state, "one", "/repo", { type: "output", id: tool.id, output: "first" });
    expect(state.tools.get(tool.id)?.output).toBe("first");
    const ended = { ...tool, status: "done" as const, output: "final" };
    turns.tool(state, "one", "/repo", { type: "end", tool: ended });
    turns.tool(state, "one", "/repo", { type: "output", id: tool.id, output: "late" });
    expect(events.map((event) => event.type)).toEqual(["tool-start", "tool-update", "tool-end"]);
    expect(services.toolEnded).toHaveBeenCalledWith("one", ended, "/repo");
    expect(state.tools.size).toBe(0);
    turns.tool(state, "one", "/repo", { type: "start", tool });
    turns.releaseTool(tool.id);
    turns.tool(state, "one", "/repo", { type: "output", id: tool.id, output: "aborted" });
    expect(events.at(-1)?.type).toBe("tool-start");
  });

  it("keeps the current answer when an earlier answer ends and rejects late deltas", () => {
    const { turns, state, events } = setup();
    turns.assistant(state, "one", { type: "start", id: "new", timestamp: 1 });
    turns.assistant(state, "one", { type: "text", id: "old", delta: "stale" });
    turns.assistant(state, "one", { type: "end", message: { id: "old", role: "assistant", text: "old", timestamp: 0 } });
    turns.assistant(state, "one", { type: "thinking", id: "new", delta: "thought" });
    expect(state.liveAssistant).toMatchObject({ id: "new", text: "", thinking: "thought" });
    expect(events.some((event) => event.type === "assistant-delta")).toBe(false);
    turns.settle(state, "one", { snapshot: false });
    turns.assistant(state, "one", { type: "text", id: "new", delta: "late" });
    expect(state.liveAssistant).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "agent-status", running: false });
  });

  it("preserves Pi message ordering and keeps the answer until message_end", () => {
    const { turns, state, services, events } = setup();
    const adapter: SessionEventServices = {
      turns, emit: services.emit, log: services.log, clientTurns: new ClientTurnLedger(),
      trackedClientMessageIds: () => [], failClientMessageIfUnpersisted: () => {},
      correlateUserMessageStart: () => {}, decorateUserEvent: (_state, message) => message,
      messageMappingOptions: () => ({}), pinnedEntries: () => new Set(),
    };
    const send = (event: unknown) => handleRuntimeSessionEvent(event, state, "one", "/repo", adapter);
    send({ type: "agent_start" });
    send({ type: "message_start", message: { role: "assistant", timestamp: 1 } });
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
    send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "think" } });
    send({ type: "agent_settled" });
    expect(state.liveAssistant).toMatchObject({ text: "hello", thinking: "think" });
    send({ type: "message_end", message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "hello" }] } });
    expect(state.liveAssistant).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual([
      "agent-status", "assistant-start", "assistant-delta", "assistant-thinking", "agent-status", "assistant-end",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "assistant-end", message: { id: "assistant-live-1", text: "hello" } });
  });

  it("suppresses a settled snapshot overtaken by the next turn", async () => {
    const { turns, state, services, updates } = setup();
    let complete!: (snapshot: HostSnapshot) => void;
    services.settledSnapshot.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    turns.start(state, "one");
    turns.compaction(state, "one", true);
    turns.settle(state, "one", { snapshot: true, error: "failed" });
    expect(state.isCompacting).toBe(false);
    expect(services.turnSettled).toHaveBeenCalledWith("one", "failed");
    turns.start(state, "one");
    complete({ sessionId: "one", isStreaming: false } as HostSnapshot);
    await Promise.resolve();
    expect(updates.filter((update) => update.type === "thread-detail")).toEqual([]);
    expect(state.turnError).toBeUndefined();
  });
});
