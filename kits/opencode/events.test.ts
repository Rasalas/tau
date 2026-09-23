import { describe, expect, it } from "vitest";
import type { ThreadRuntimeEvent } from "tau/host-extension";
import { OpenCodeTurnTranslator, sessionUsage, stepContext, toolCall } from "./events.js";
import { recordedTurn, type FakeSession } from "./fixtures/fake-server.js";

const SESSION = { id: "ses_1", directory: "/work/repo" } as FakeSession;

function run(events: ReturnType<typeof recordedTurn>) {
  let clock = 1_000;
  const translator = new OpenCodeTurnTranslator(() => clock++);
  const out: ThreadRuntimeEvent[] = [];
  for (const event of events) out.push(...translator.push(event.type, event.properties));
  return { translator, out };
}

describe("OpenCodeTurnTranslator on turns recorded from opencode 1.18.32", () => {
  it("streams the reasoning and the reply of a one-word turn and ends it on idle", () => {
    const { translator, out } = run(recordedTurn("reply", SESSION));
    expect(out.map((event) => event.type)).toEqual(["assistant-start", "assistant-thinking", "assistant-thinking", "assistant-thinking", "assistant-delta", "assistant-end"]);
    const end = out.at(-1) as Extract<ThreadRuntimeEvent, { type: "assistant-end" }>;
    expect(end.message).toMatchObject({ role: "assistant", text: "ok", thinking: "The user wants exactly one word reply." });
    expect(translator.outcome).toEqual({ status: "completed", texts: ["ok"] });
    expect(translator.model).toEqual({ providerID: "opencode", modelID: "mimo-v2.6-flash-free" });
    expect(translator.lastStep).toMatchObject({ total: 13052 });
  });

  it("never echoes the user's own prompt", () => {
    const { out } = run(recordedTurn("reply", SESSION));
    expect(JSON.stringify(out)).not.toContain("Reply with exactly one word");
  });

  it("shows a command as one bash card with its live and final output", () => {
    const events = recordedTurn("tool", SESSION).filter((event) => !event.type.startsWith("permission."));
    const { translator, out } = run(events);
    const tools = out.filter((event) => event.type.startsWith("tool-"));
    expect(tools.map((event) => event.type)).toEqual(["tool-start", "tool-update", "tool-end"]);
    expect(tools[0]).toMatchObject({ tool: { id: "call_3f25a8a8ee1a419fa999c4d7", name: "bash", args: { command: "echo hi" }, status: "running" } });
    expect(tools[2]).toMatchObject({ tool: { status: "done", output: "hi\n" } });
    // The reasoning before the tool is a message of its own; the reply after it another.
    expect(out.filter((event) => event.type === "assistant-end").map((event) => (event as { message: { text: string } }).message.text)).toEqual(["", "done"]);
    expect(translator.outcome?.texts).toEqual(["done"]);
  });

  it("takes an idle before the session was busy as an earlier turn's", () => {
    const translator = new OpenCodeTurnTranslator();
    translator.push("session.status", { sessionID: "ses_1", status: { type: "idle" } });
    expect(translator.outcome).toBeUndefined();
    translator.push("session.status", { sessionID: "ses_1", status: { type: "busy" } });
    translator.push("session.idle", { sessionID: "ses_1" });
    expect(translator.outcome).toEqual({ status: "completed", texts: [] });
  });

  it("ends an aborted turn as interrupted and closes its running tools", () => {
    const translator = new OpenCodeTurnTranslator(() => 5);
    translator.push("message.updated", { info: { id: "msg_a", sessionID: "ses_1", role: "assistant" } });
    translator.push("message.part.updated", { part: { id: "p", messageID: "msg_a", sessionID: "ses_1", type: "tool", tool: "bash", callID: "c1", state: { status: "running", input: { command: "sleep 9" }, time: { start: 1 } } } });
    translator.push("message.updated", { info: { id: "msg_a", sessionID: "ses_1", role: "assistant", error: { name: "MessageAbortedError", data: { message: "Aborted" } } } });
    const out = translator.push("session.status", { sessionID: "ses_1", status: { type: "idle" } });
    expect(out).toEqual([{ type: "tool-end", tool: expect.objectContaining({ id: "c1", status: "error", output: "Interrupted." }) }]);
    expect(translator.outcome?.status).toBe("interrupted");
  });

  it("fails a turn with the provider's error", () => {
    const translator = new OpenCodeTurnTranslator();
    translator.push("session.status", { sessionID: "ses_1", status: { type: "busy" } });
    translator.push("session.error", { sessionID: "ses_1", error: { name: "APIError", data: { message: "403 Forbidden" } } });
    translator.push("session.idle", { sessionID: "ses_1" });
    expect(translator.outcome).toEqual({ status: "failed", error: "403 Forbidden", texts: [] });
  });

  it("warns while OpenCode retries a provider", () => {
    const translator = new OpenCodeTurnTranslator();
    expect(translator.push("session.status", { sessionID: "ses_1", status: { type: "retry", attempt: 2, message: "rate limited", next: 1 } }))
      .toEqual([{ type: "notice", message: "OpenCode is retrying (attempt 2): rate limited", level: "warning" }]);
  });
});

describe("OpenCode's words in Tau's", () => {
  it("names tools the way Tau's cards read them", () => {
    expect(toolCall("read", { filePath: "/a.ts" })).toEqual({ name: "read", args: { filePath: "/a.ts", path: "/a.ts" } });
    expect(toolCall("list", { path: "src" })).toEqual({ name: "ls", args: { path: "src" } });
    expect(toolCall("tau_spawn_thread", { title: "x" })).toEqual({ name: "mcp__tau__spawn_thread", args: { title: "x" } });
  });

  it("counts a session's tokens with reasoning as output, and the last step against the window", () => {
    expect(sessionUsage({ input: 100, output: 5, reasoning: 3, cache: { read: 50, write: 2 } }, 0.01, 2))
      .toEqual({ inputTokens: 100, outputTokens: 8, cacheReadTokens: 50, cacheWriteTokens: 2, totalTokens: 160, costUsd: 0.01, turns: 2 });
    expect(stepContext({ total: 13052 }, 200000)).toEqual({ tokens: 13052, contextWindow: 200000, percent: 7 });
    expect(stepContext({ total: 10 }, undefined)).toBeUndefined();
  });
});
