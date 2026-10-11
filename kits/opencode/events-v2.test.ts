import { describe, expect, it } from "vitest";
import type { ThreadRuntimeEvent } from "tau/host-extension";
import recorded from "./fixtures/turn-events-v2.json" with { type: "json" };
import { OpenCode2TurnTranslator, toolCall2 } from "./events-v2.js";

interface Recorded { type: string; data: Record<string, unknown> }

function run(events: Recorded[]) {
  let clock = 1_000;
  const translator = new OpenCode2TurnTranslator(() => clock++);
  const out: ThreadRuntimeEvent[] = [];
  for (const event of events) out.push(...translator.push(event.type, event.data));
  return { translator, out };
}

function replay(name: "permission" | "question" | "steer" | "tools" | "cancelledQuestion") {
  return run(recorded[name] as Recorded[]);
}

function ends<T extends ThreadRuntimeEvent["type"]>(out: ThreadRuntimeEvent[], type: T) {
  return out.filter((event): event is Extract<ThreadRuntimeEvent, { type: T }> => event.type === type);
}

const A = "msg_a";
const part = (ordinal = 0, message = A) => ({ assistantMessageID: message, ordinal });

function began(translator: OpenCode2TurnTranslator) {
  translator.push("session.execution.started", { sessionID: "ses_1" });
}

describe("OpenCode2TurnTranslator on turns recorded from opencode 2.0.26", () => {
  it("shows every built-in tool as a card and ends with the reply", () => {
    const { translator, out } = replay("tools");
    const done = ends(out, "tool-end").map((event) => event.tool);
    expect(done.map((tool) => tool.name)).toEqual(["read", "grep", "find", "write", "edit"]);
    expect(done.every((tool) => tool.status === "done")).toBe(true);
    const starts = ends(out, "tool-start").map((event) => event.tool);
    expect(starts.map((tool) => tool.args)).toEqual([
      { path: "/repo/a.txt" },
      { pattern: "beta", path: "/repo" },
      { pattern: "*.txt", path: "/repo" },
      { path: "/repo/b.txt", content: "hi" },
      { path: "/repo/b.txt", oldString: "hi", newString: "yo" },
    ]);
    expect(starts.every((tool) => tool.status === "running")).toBe(true);
    expect(done[0].output).toBe("Read file /repo/a.txt, lines 1-1\n1: alpha beta");
    expect(done[1].output).toBe("Found 1 matches\n/repo/a.txt:\n  Line 1: alpha beta\n");
    expect(done[2].output).toBe("/repo/a.txt");
    expect(done[3].output).toBe("Created file successfully: b.txt");
    // The edit shows its diff, not the one-line summary.
    expect(done[4].output).toContain("--- b.txt\n+++ b.txt\n@@ -1,1 +1,1 @@\n-hi");
    expect(done[4].output).toContain("+yo");
    expect(translator.running.size).toBe(0);
    expect(ends(out, "assistant-end").at(-1)?.message).toMatchObject({ role: "assistant", text: "finished" });
    expect(ends(out, "assistant-end").at(-1)?.message.thinking).toContain("fetch nothing");
    expect(translator.outcome).toEqual({ status: "completed", texts: ["finished"] });
    expect(translator.model).toEqual({ providerID: "opencode", modelID: "space-bunny-free" });
    expect(translator.lastStep).toEqual({ input: 78, output: 4, reasoning: 211, cache: { read: 6833, write: 0 } });
  });

  it("ends a declined shell call with an error card and goes on with the reply", () => {
    const { translator, out } = replay("permission");
    const tools = ends(out, "tool-end").map((event) => event.tool);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "bash", args: { command: "echo hello" }, status: "error", output: "The user declined this request." });
    expect(ends(out, "assistant-end").map((event) => event.message.text)).toEqual([
      "I'll run that command.",
      expect.stringMatching(/^pong\n\n\(Note: the `echo hello` command was declined/),
    ]);
    expect(ends(out, "assistant-end")[1].message.thinking).toMatch(/^The user declined the command/);
    expect(translator.outcome?.status).toBe("completed");
    expect(translator.outcome?.texts).toHaveLength(2);
    // The text before the tool is closed before the card starts.
    const order = out.map((event) => event.type);
    expect(order.indexOf("assistant-end")).toBeLessThan(order.indexOf("tool-start"));
  });

  it("gives the question tool the answer as its output", () => {
    const { translator, out } = replay("question");
    const tools = ends(out, "tool-end").map((event) => event.tool);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "question", status: "done" });
    expect(tools[0].output).toBe("User has answered your questions: \"Which color do you prefer?\"=\"Blue\". You can now continue with the user's answers in mind.");
    // The reasoning that led to the question is a message of its own.
    expect(ends(out, "assistant-end").map((event) => event.message.text)).toEqual(["", "Blue it is."]);
    expect(translator.outcome).toEqual({ status: "completed", texts: ["Blue it is."] });
  });

  it("shows a dismissed question as a failed card with its message", () => {
    const { translator, out } = replay("cancelledQuestion");
    const tool = ends(out, "tool-end")[0].tool;
    expect(tool).toMatchObject({ name: "question", status: "error", output: "cancelled by user" });
    expect(translator.outcome?.status).toBe("completed");
    expect(translator.outcome?.texts[0]).toMatch(/^The question was cancelled/);
  });

  it("ends a steered turn once, after both replies", () => {
    const { translator, out } = replay("steer");
    const tool = ends(out, "tool-end")[0].tool;
    expect(tool).toMatchObject({ name: "bash", args: { command: "sleep 12", timeout: 20000 }, status: "done", output: "(no output)" });
    expect(translator.outcome).toEqual({ status: "completed", texts: ["done steered", "done steered queued-one"] });
    expect(ends(out, "assistant-end").map((event) => event.message.text)).toEqual(["done steered", "done steered queued-one"]);
    expect(translator.push("session.execution.succeeded", {})).toEqual([]);
  });

  it("streams text as start, deltas and one end with stable ids", () => {
    const { out } = replay("steer");
    const first = ends(out, "assistant-start")[0];
    expect(ends(out, "assistant-delta")[0]).toMatchObject({ id: first.id, delta: "done steered" });
    expect(ends(out, "assistant-end")[0].message.id).toBe(first.id);
    const ids = ends(out, "assistant-start").map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("OpenCode2TurnTranslator", () => {
  it("takes an execution end before any start as an earlier run's", () => {
    const translator = new OpenCode2TurnTranslator();
    expect(translator.push("session.execution.succeeded", {})).toEqual([]);
    expect(translator.push("session.execution.failed", { error: { type: "x", message: "old" } })).toEqual([]);
    expect(translator.push("session.execution.interrupted", { reason: "user" })).toEqual([]);
    expect(translator.outcome).toBeUndefined();
    began(translator);
    translator.push("session.execution.succeeded", {});
    expect(translator.outcome).toEqual({ status: "completed", texts: [] });
  });

  it("counts a step as the start of the run", () => {
    const translator = new OpenCode2TurnTranslator();
    translator.push("session.step.started", { assistantMessageID: A, agent: "build", model: { id: "m", providerID: "p", variant: "default" } });
    translator.push("session.execution.succeeded", {});
    expect(translator.outcome?.status).toBe("completed");
    expect(translator.model).toEqual({ providerID: "p", modelID: "m" });
  });

  it("fails a turn with the error text and keeps the texts so far", () => {
    const translator = new OpenCode2TurnTranslator(() => 5);
    began(translator);
    translator.push("session.text.started", part());
    translator.push("session.text.delta", { ...part(), delta: "partial" });
    const out = translator.push("session.execution.failed", { error: { type: "provider", message: "  Rate limit hit  " } });
    expect(out.map((event) => event.type)).toEqual(["assistant-end"]);
    expect(translator.outcome).toEqual({ status: "failed", error: "Rate limit hit", texts: ["partial"] });
  });

  it("falls back to the step's error, then to a generic one", () => {
    const a = new OpenCode2TurnTranslator();
    began(a);
    a.push("session.step.failed", { error: { type: "api", message: "context too long" } });
    expect(a.outcome).toBeUndefined();
    a.push("session.execution.failed", { error: {} });
    expect(a.outcome).toEqual({ status: "failed", error: "context too long", texts: [] });
    const b = new OpenCode2TurnTranslator();
    began(b);
    b.push("session.execution.failed", {});
    expect(b.outcome).toEqual({ status: "failed", error: "OpenCode reported an error.", texts: [] });
  });

  it("interrupts a turn and closes the tools still running", () => {
    const translator = new OpenCode2TurnTranslator(() => 7);
    began(translator);
    translator.push("session.tool.input.started", { id: "c1", name: "shell" });
    translator.push("session.tool.called", { id: "c1", input: { command: "sleep 9" }, executed: false });
    translator.push("session.tool.progress", { id: "c1", metadata: { output: "tick" } });
    translator.push("session.tool.called", { id: "c2", input: { pattern: "x" }, executed: false });
    const out = translator.push("session.execution.interrupted", { reason: "user" });
    expect(out).toEqual([
      { type: "tool-end", tool: expect.objectContaining({ id: "c1", name: "bash", status: "error", output: "tick", endedAt: 7 }) },
      { type: "tool-end", tool: expect.objectContaining({ id: "c2", status: "error", output: "Interrupted." }) },
    ]);
    expect(translator.running.size).toBe(0);
    expect(translator.outcome).toEqual({ status: "interrupted", texts: [] });
  });

  it("emits only the tail a text.ended carries beyond its deltas", () => {
    const translator = new OpenCode2TurnTranslator();
    began(translator);
    translator.push("session.text.started", part());
    const live = translator.push("session.text.delta", { ...part(), delta: "Hel" });
    expect(live.map((event) => event.type)).toEqual(["assistant-start", "assistant-delta"]);
    const out = translator.push("session.text.ended", { ...part(), text: "Hello world" });
    expect(out.map((event) => event.type)).toEqual(["assistant-delta", "assistant-end"]);
    expect(out[0]).toMatchObject({ delta: "lo world" });
    expect(ends(out, "assistant-end")[0].message.text).toBe("Hello world");
    // A repeat of the end and a late delta change nothing.
    expect(translator.push("session.text.ended", { ...part(), text: "Hello world" })).toEqual([]);
    expect(translator.push("session.text.delta", { ...part(), delta: "!" })).toEqual([]);
  });

  it("shows a text that arrives only in text.ended", () => {
    const translator = new OpenCode2TurnTranslator();
    began(translator);
    const out = translator.push("session.text.ended", { ...part(), text: "whole" });
    expect(out.map((event) => event.type)).toEqual(["assistant-start", "assistant-delta", "assistant-end"]);
    translator.push("session.execution.succeeded", {});
    expect(translator.outcome?.texts).toEqual(["whole"]);
  });

  it("puts the reasoning before a text on that text's message", () => {
    const translator = new OpenCode2TurnTranslator();
    began(translator);
    translator.push("session.reasoning.started", part());
    const thinking = translator.push("session.reasoning.delta", { ...part(), delta: "hmm" });
    expect(thinking.map((event) => event.type)).toEqual(["assistant-start", "assistant-thinking"]);
    translator.push("session.reasoning.ended", { ...part(), text: "hmm, ok" });
    translator.push("session.text.started", part());
    const out = translator.push("session.text.ended", { ...part(), text: "answer" });
    expect(ends(out, "assistant-end")[0].message).toMatchObject({ text: "answer", thinking: "hmm, ok" });
    expect(ends(out, "assistant-end")[0].message.id).toBe((thinking[0] as { id: string }).id);
  });

  it("keeps a text part of another message or ordinal as a reply of its own", () => {
    const translator = new OpenCode2TurnTranslator();
    began(translator);
    translator.push("session.text.delta", { ...part(0), delta: "one" });
    const out = translator.push("session.text.delta", { ...part(1), delta: "two" });
    expect(out.map((event) => event.type)).toEqual(["assistant-end", "assistant-start", "assistant-delta"]);
    translator.push("session.execution.succeeded", {});
    expect(translator.outcome?.texts).toEqual(["one", "two"]);
  });

  it("closes the open text before a tool and names the tool from its input event", () => {
    const translator = new OpenCode2TurnTranslator();
    began(translator);
    translator.push("session.text.delta", { ...part(), delta: "looking" });
    translator.push("session.tool.input.started", { id: "c1", name: "glob" });
    const out = translator.push("session.tool.called", { id: "c1", input: { pattern: "*.ts" }, executed: false });
    expect(out.map((event) => event.type)).toEqual(["assistant-end", "tool-start"]);
    expect(ends(out, "tool-start")[0].tool).toMatchObject({ id: "c1", name: "find", args: { pattern: "*.ts" } });
    expect(translator.running.get("c1")).toBeDefined();
  });

  it("makes a tool update only for new, non-empty printed output", () => {
    const translator = new OpenCode2TurnTranslator();
    began(translator);
    translator.push("session.tool.input.started", { id: "c1", name: "shell" });
    translator.push("session.tool.called", { id: "c1", input: { command: "ls" }, executed: false });
    expect(translator.push("session.tool.progress", { id: "c1", metadata: { shellID: "sh_1" } })).toEqual([]);
    expect(translator.push("session.tool.progress", { id: "c1", metadata: { output: "" } })).toEqual([]);
    expect(translator.push("session.tool.progress", { id: "c1", metadata: { output: "a" } })).toEqual([{ type: "tool-update", id: "c1", output: "a" }]);
    expect(translator.push("session.tool.progress", { id: "c1", metadata: { output: "a" } })).toEqual([]);
    expect(translator.push("session.tool.progress", { id: "nope", metadata: { output: "b" } })).toEqual([]);
  });

  it("makes up the tool start when a tool ends without one", () => {
    const translator = new OpenCode2TurnTranslator(() => 3);
    began(translator);
    translator.push("session.text.delta", { ...part(), delta: "x" });
    translator.push("session.tool.input.started", { id: "c1", name: "shell" });
    const out = translator.push("session.tool.success", { id: "c1", content: [{ type: "text", text: "hi" }], metadata: { exit: 2 } });
    expect(out.map((event) => event.type)).toEqual(["assistant-end", "tool-start", "tool-end"]);
    expect(ends(out, "tool-end")[0].tool).toMatchObject({ id: "c1", name: "bash", status: "done", output: "hi\n[exit code 2]", endedAt: 3 });
  });

  it("writes files as bracketed names, an edit as its patches, a failure as its content or message", () => {
    const translator = new OpenCode2TurnTranslator();
    began(translator);
    translator.push("session.tool.input.started", { id: "r", name: "read" });
    const read = translator.push("session.tool.success", { id: "r", content: [{ type: "text", text: "see" }, { type: "file", uri: "file:///x.png", mime: "image/png", name: "x.png" }, { type: "file", uri: "file:///y.png", mime: "image/png" }] });
    expect(ends(read, "tool-end")[0].tool.output).toBe("see\n[x.png]\n[file:///y.png]");
    translator.push("session.tool.input.started", { id: "e", name: "edit" });
    const edit = translator.push("session.tool.success", { id: "e", content: [{ type: "text", text: "Edited" }], metadata: { files: [{ file: "a", patch: "P1" }, { file: "b", patch: "P2" }] } });
    expect(ends(edit, "tool-end")[0].tool.output).toBe("P1\n\nP2");
    translator.push("session.tool.input.started", { id: "f1", name: "read" });
    expect(ends(translator.push("session.tool.failed", { id: "f1", error: { type: "tool", message: "boom" }, content: [{ type: "text", text: "partial output" }] }), "tool-end")[0].tool).toMatchObject({ status: "error", output: "partial output" });
    translator.push("session.tool.input.started", { id: "f2", name: "read" });
    expect(ends(translator.push("session.tool.failed", { id: "f2", error: { type: "tool", message: "boom" } }), "tool-end")[0].tool).toMatchObject({ status: "error", output: "boom" });
  });

  it("bounds a huge tool output to its latest 128 KiB", () => {
    const translator = new OpenCode2TurnTranslator();
    began(translator);
    translator.push("session.tool.input.started", { id: "c", name: "shell" });
    translator.push("session.tool.called", { id: "c", input: { command: "yes" }, executed: false });
    const big = "x".repeat(200 * 1024);
    const live = translator.push("session.tool.progress", { id: "c", metadata: { output: big } });
    const end = translator.push("session.tool.success", { id: "c", content: [{ type: "text", text: big }] });
    for (const output of [(live[0] as { output: string }).output, ends(end, "tool-end")[0].tool.output as string]) {
      expect(output.startsWith("[Earlier output truncated")).toBe(true);
      expect(Buffer.byteLength(output)).toBeLessThan(129 * 1024);
    }
  });

  it("tells about a retry and a compaction", () => {
    const translator = new OpenCode2TurnTranslator();
    began(translator);
    expect(translator.push("session.retry.scheduled", { attempt: 2, at: 1, error: { type: "api", message: "overloaded" } })).toEqual([
      { type: "notice", message: "OpenCode is retrying (attempt 2): overloaded", level: "warning" },
    ]);
    expect(translator.push("session.compaction.ended", {})).toEqual([
      { type: "notice", message: "OpenCode compacted the conversation to fit its context window.", level: "info" },
    ]);
  });

  it("ignores events that are not the turn's", () => {
    const translator = new OpenCode2TurnTranslator();
    began(translator);
    for (const type of ["session.inbox.enqueued", "session.instructions.updated", "session.synthetic", "session.usage.updated", "session.shell.started", "session.renamed", "permission.asked", "form.created"]) {
      expect(translator.push(type, { id: "x" })).toEqual([]);
    }
    expect(translator.outcome).toBeUndefined();
  });

  it("stops after the outcome", () => {
    const translator = new OpenCode2TurnTranslator();
    began(translator);
    translator.push("session.execution.succeeded", {});
    expect(translator.push("session.text.delta", { ...part(), delta: "late" })).toEqual([]);
    expect(translator.abandon("failed", "late")).toEqual([]);
    expect(translator.outcome).toEqual({ status: "completed", texts: [] });
  });

  it("abandons an interrupted turn and closes its text and tools", () => {
    const translator = new OpenCode2TurnTranslator(() => 9);
    began(translator);
    translator.push("session.tool.called", { id: "c1", input: {}, executed: false });
    translator.push("session.text.delta", { ...part(), delta: "so far" });
    const out = translator.abandon("interrupted");
    expect(out.map((event) => event.type)).toEqual(["assistant-end", "tool-end"]);
    expect(ends(out, "tool-end")[0].tool.output).toBe("Interrupted.");
    expect(translator.outcome).toEqual({ status: "interrupted", texts: ["so far"] });
  });

  it("abandons a failed turn with the reason, or the step's error", () => {
    const a = new OpenCode2TurnTranslator();
    began(a);
    a.push("session.tool.called", { id: "c1", input: {}, executed: false });
    expect(ends(a.abandon("failed", "server died"), "tool-end")[0].tool.output).toBe("The turn ended before the tool did.");
    expect(a.outcome).toEqual({ status: "failed", error: "server died", texts: [] });
    const b = new OpenCode2TurnTranslator();
    b.push("session.step.failed", { error: { message: "step broke" } });
    b.abandon("failed", "server died");
    expect(b.outcome?.error).toBe("step broke");
  });
});

describe("toolCall2", () => {
  it("names OpenCode 2's tools as Tau's cards do", () => {
    expect(toolCall2("shell", { command: "ls" })).toEqual({ name: "bash", args: { command: "ls" } });
    expect(toolCall2("glob", { pattern: "*" })).toEqual({ name: "find", args: { pattern: "*" } });
    expect(toolCall2("list", {}).name).toBe("ls");
    expect(toolCall2("websearch", {}).name).toBe("web_search");
    expect(toolCall2("webfetch", {}).name).toBe("webfetch");
    expect(toolCall2("read", { path: "/a" })).toEqual({ name: "read", args: { path: "/a" } });
    expect(toolCall2("tau_preview_open", { url: "u" })).toEqual({ name: "mcp__tau__preview_open", args: { url: "u" } });
    expect(toolCall2("read", { filePath: "/a" }).args).toEqual({ filePath: "/a", path: "/a" });
  });
});
