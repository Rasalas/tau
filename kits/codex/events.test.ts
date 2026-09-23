import { describe, expect, it } from "vitest";
import type { ThreadRuntimeEvent } from "tau/host-extension";
import { CodexTurnTranslator, contextUsage, displayCommand, threadUsage, toolFor } from "./events.js";
import frames from "./fixtures/app-server-frames.json" with { type: "json" };

type Frame = { method: string; id?: number; params: Record<string, unknown> };

function replay(name: keyof typeof frames.scenarios): { events: ThreadRuntimeEvent[]; translator: CodexTurnTranslator } {
  let clock = 0;
  const translator = new CodexTurnTranslator(() => ++clock);
  const events: ThreadRuntimeEvent[] = [];
  const ids = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll("{thread}", "th").replaceAll("{turn}", "tu").replaceAll("{cwd}", "/repo")) as Frame[];
  for (const frame of ids(frames.scenarios[name])) {
    if (frame.id === undefined) events.push(...translator.push(frame.method, frame.params));
  }
  return { events, translator };
}

describe("a proposed plan", () => {
  it("streams as a reply of its own inside proposed_plan tags, with the finished item's text", () => {
    let clock = 0;
    const translator = new CodexTurnTranslator(() => ++clock);
    const events = [
      ...translator.push("item/agentMessage/delta", { itemId: "m1", delta: "Looked around." }),
      ...translator.push("item/started", { item: { type: "plan", id: "p1", text: "" } }),
      ...translator.push("item/plan/delta", { itemId: "p1", delta: "# Plan\n- one" }),
      ...translator.push("item/completed", { item: { type: "plan", id: "p1", text: "# Plan\n- one\n- two\n" } }),
    ];
    const ends = events.filter((event) => event.type === "assistant-end") as Array<Extract<ThreadRuntimeEvent, { type: "assistant-end" }>>;
    expect(ends.map((event) => event.message.text)).toEqual(["Looked around.", "<proposed_plan>\n# Plan\n- one\n- two\n</proposed_plan>"]);
  });

  it("stands alone when Codex reports only the finished item", () => {
    const translator = new CodexTurnTranslator(() => 1);
    const events = translator.push("item/completed", { item: { type: "plan", id: "p1", text: "# Plan" } });
    expect(events.map((event) => event.type)).toEqual(["assistant-start", "assistant-delta", "assistant-end"]);
    expect(events.at(-1)).toMatchObject({ message: { text: "<proposed_plan>\n# Plan\n</proposed_plan>" } });
  });
});

describe("CodexTurnTranslator against recorded frames", () => {
  it("streams a plain answer as one assistant message", () => {
    const { events, translator } = replay("plain");
    expect(events.map((event) => event.type)).toEqual(["assistant-start", "assistant-delta", "assistant-end"]);
    expect(events.at(-1)).toMatchObject({ type: "assistant-end", message: { role: "assistant", text: "hello" } });
    expect(translator.outcome).toEqual({ status: "completed", texts: ["hello"] });
  });

  it("turns a command into one bash card with its output, and an empty narration into nothing", () => {
    const { events } = replay("command");
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("tool-start");
    const start = events.find((event) => event.type === "tool-start");
    expect(start).toMatchObject({ tool: { name: "bash", args: { command: "echo tau-ok > out.txt && cat out.txt", cwd: "/repo" }, status: "running" } });
    const end = events.find((event) => event.type === "tool-end");
    expect(end).toMatchObject({ tool: { name: "bash", status: "done", output: "tau-ok\n" } });
    expect(events.at(-1)).toMatchObject({ type: "assistant-end", message: { text: "tau-ok" } });
  });

  it("turns a new file into a write card and remembers its path for the approval", () => {
    const { events, translator } = replay("edit");
    const start = events.find((event) => event.type === "tool-start") as Extract<ThreadRuntimeEvent, { type: "tool-start" }>;
    expect(start.tool).toMatchObject({ name: "write", args: { path: "/repo/note.txt" } });
    expect(translator.changes.get(start.tool.id)).toEqual(["/repo/note.txt"]);
    expect(events.find((event) => event.type === "tool-end")).toMatchObject({ tool: { status: "done", output: "/repo/note.txt\ntau" } });
  });

  it("closes a tool that never finished when the turn is interrupted", () => {
    const { events, translator } = replay("interrupt");
    expect(events.at(-1)).toMatchObject({ type: "tool-start", tool: { name: "bash" } });
    const closing = translator.push("turn/completed", { turn: { id: "tu", status: "interrupted", error: null } });
    expect(closing).toMatchObject([{ type: "tool-end", tool: { status: "error", output: "Interrupted." } }]);
    expect(translator.outcome?.status).toBe("interrupted");
  });
});

describe("CodexTurnTranslator", () => {
  it("puts reasoning before a message into that message's thinking", () => {
    const translator = new CodexTurnTranslator(() => 1);
    const events = [
      ...translator.push("item/started", { item: { type: "reasoning", id: "r1", summary: [], content: [] } }),
      ...translator.push("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "Weighing it." }),
      ...translator.push("item/started", { item: { type: "agentMessage", id: "m1", text: "" } }),
      ...translator.push("item/agentMessage/delta", { itemId: "m1", delta: "Yes" }),
      ...translator.push("item/completed", { item: { type: "agentMessage", id: "m1", text: "Yes." } }),
    ];
    expect(events.map((event) => event.type)).toEqual(["assistant-start", "assistant-thinking", "assistant-delta", "assistant-delta", "assistant-end"]);
    expect(events.at(-1)).toMatchObject({ message: { text: "Yes.", thinking: "Weighing it." } });
  });

  it("marks a declined or failed item as an error card", () => {
    const translator = new CodexTurnTranslator(() => 1);
    translator.push("item/started", { item: { type: "commandExecution", id: "c1", command: "rm -rf /", status: "inProgress" } });
    const [end] = translator.push("item/completed", { item: { type: "commandExecution", id: "c1", command: "rm -rf /", status: "declined", aggregatedOutput: null, exitCode: null } });
    expect(end).toMatchObject({ type: "tool-end", tool: { status: "error" } });
  });

  it("names MCP calls the way the transcript groups them", () => {
    expect(toolFor({ type: "mcpToolCall", id: "m", server: "linear", tool: "create_issue", arguments: { title: "x" } }, 0)).toMatchObject({ name: "mcp__linear__create_issue", args: { title: "x" } });
    expect(toolFor({ type: "commandExecution", id: "c", command: "cat a.ts", commandActions: [{ type: "read", command: "cat a.ts", name: "a.ts", path: "/repo/a.ts" }] }, 0)).toMatchObject({ name: "read", args: { path: "/repo/a.ts" } });
    expect(toolFor({ type: "agentMessage", id: "x" }, 0)).toBeUndefined();
  });
});

describe("usage", () => {
  const usage = {
    total: { totalTokens: 23986, inputTokens: 23790, cachedInputTokens: 19968, cacheWriteInputTokens: 0, outputTokens: 196, reasoningOutputTokens: 107 },
    last: { totalTokens: 12166, inputTokens: 12000, cachedInputTokens: 9984, cacheWriteInputTokens: 0, outputTokens: 166, reasoningOutputTokens: 80 },
    modelContextWindow: 258400,
  };

  it("keeps cached input apart from fresh input and bills nothing", () => {
    expect(threadUsage(usage, 2)).toEqual({ inputTokens: 3822, outputTokens: 196, cacheReadTokens: 19968, cacheWriteTokens: 0, totalTokens: 23986, costUsd: 0, turns: 2 });
  });

  it("reads the context fill from the last request", () => {
    expect(contextUsage(usage)).toEqual({ tokens: 12166, contextWindow: 258400, percent: 5 });
    expect(contextUsage({ ...usage, modelContextWindow: null })).toBeUndefined();
  });
});

describe("displayCommand", () => {
  it("drops the login-shell wrapper Codex puts around a command", () => {
    expect(displayCommand("/bin/zsh -lc 'ls -la'")).toBe("ls -la");
    expect(displayCommand("bash -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(displayCommand("git status")).toBe("git status");
  });
});
