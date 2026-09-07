import { describe, expect, it } from "vitest";
import { AcpTurnTranslator, toolName } from "./events.js";

describe("AcpTurnTranslator", () => {
  it("streams text into one assistant message, closes it at a tool call, and ends tools with their output", () => {
    let clock = 1_000;
    const translator = new AcpTurnTranslator(() => clock++);
    const events = [
      ...translator.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } }),
      ...translator.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } }),
      ...translator.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } }),
      ...translator.push({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Run `ls`", kind: "execute", status: "pending", rawInput: { command: "ls" } }),
      ...translator.push({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", content: [{ type: "content", content: { type: "text", text: "a.txt" } }] }),
      ...translator.push({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: { combinedOutput: "a.txt\nb.txt" } }),
      ...translator.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } }),
      ...translator.finish({ stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
    ];
    expect(events.map((event) => event.type)).toEqual([
      "assistant-start", "assistant-thinking", "assistant-delta", "assistant-delta", "assistant-end",
      "tool-start", "tool-update", "tool-end", "assistant-start", "assistant-delta", "assistant-end",
    ]);
    const first = events.find((event) => event.type === "assistant-end");
    expect(first).toMatchObject({ message: { role: "assistant", text: "Hello world", thinking: "hm" } });
    expect(events.find((event) => event.type === "tool-start")).toMatchObject({ tool: { id: "t1", name: "Run `ls`", args: { command: "ls" }, status: "running" } });
    expect(events.find((event) => event.type === "tool-end")).toMatchObject({ tool: { status: "done", output: "a.txt\nb.txt" } });
    expect(translator.outcome).toMatchObject({ texts: ["Hello world", "Done."], stopReason: "end_turn", cancelled: false, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, turns: 1 } });
  });

  it("closes tools still running when the turn is cancelled, and keeps the session's facts", () => {
    const translator = new AcpTurnTranslator(() => 5);
    translator.push({ sessionUpdate: "tool_call", toolCallId: "t2", kind: "edit", status: "in_progress", content: [{ type: "diff", path: "a.ts", oldText: "x", newText: "y" }] });
    translator.push({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Squash history", input: { hint: "" } }, { name: " ", description: "blank" }] });
    translator.push({ sessionUpdate: "current_mode_update", currentModeId: "yolo" });
    translator.push({ sessionUpdate: "usage_update", used: 500, size: 1_000_000, cost: { amount: 0.12, currency: "USD" } });
    translator.push({ sessionUpdate: "plan", entries: [{ content: "step", status: "pending" }] });
    translator.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "skip" }, _meta: { isReplay: true } });
    const events = translator.finish({ stopReason: "cancelled" });
    expect(events).toEqual([{ type: "tool-end", tool: expect.objectContaining({ id: "t2", name: "edit", status: "error", output: "a.ts\n-x\n+y", endedAt: 5 }) }]);
    expect(translator.outcome?.cancelled).toBe(true);
    expect(translator.facts).toEqual({ commands: [{ name: "compact", description: "Squash history" }], modeId: "yolo", contextUsage: { tokens: 500, contextWindow: 1_000_000, percent: 0 }, sessionCostUsd: 0.12 });
  });

  it("names a tool after its title unless the title is generic, and skips a replayed completed start", () => {
    expect(toolName({ title: "Terminal", kind: "execute" })).toBe("execute");
    expect(toolName({ title: "Read file", kind: "read" })).toBe("Read file");
    const translator = new AcpTurnTranslator(() => 1);
    expect(translator.push({ sessionUpdate: "tool_call_update", toolCallId: "old", status: "completed" })).toEqual([]);
    expect(translator.push({ sessionUpdate: "tool_call", toolCallId: "done", kind: "read", status: "completed", rawOutput: "text" }).map((event) => event.type)).toEqual(["tool-start", "tool-end"]);
  });
});
