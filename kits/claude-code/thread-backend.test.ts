import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadRuntimeEvent, UiComposerCommand } from "tau/host-extension";
import { ClaudeRuntimeSessionStore } from "./session-store.js";
import { ClaudeThreadRuntimeBackend } from "./thread-backend.js";
import { createClaudeCodeRuntimeAdapter } from "./runtime-adapter.js";

const directories: string[] = [];
const commands: UiComposerCommand[] = [{ name: "skill:tdd", source: "skill", description: "Test first" }];
const SESSION = "123e4567-e89b-42d3-a456-426614174000";
const frame = <T extends object>(value: T): SDKMessage => ({ uuid: "u", session_id: SESSION, ...value }) as unknown as SDKMessage;
const turn = (text: string): SDKMessage[] => [
  frame({ type: "system", subtype: "init", model: "claude-opus-5" }),
  frame({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: {} } }),
  frame({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } }),
  frame({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text }, { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "a.ts" } }] } }),
  frame({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "export {}" }] } }),
  frame({
    type: "result", subtype: "success", is_error: false, num_turns: 2, result: text, total_cost_usd: 0.1,
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { "claude-opus-5": { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.1, contextWindow: 200000 } },
  }),
];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function scratchStore(): Promise<{ filePath: string; store: ClaudeRuntimeSessionStore }> {
  const directory = await mkdtemp(join(tmpdir(), "tau-thread-backend-"));
  directories.push(directory);
  const filePath = join(directory, "sessions.json");
  return { filePath, store: new ClaudeRuntimeSessionStore({ filePath }) };
}

/** An adapter whose `stream` replays scripted frames; `sendPrompt` is the awaited view of the same turn. */
function scriptedAdapter(filePath: string, frames: (text: string) => SDKMessage[]) {
  const adapter = createClaudeCodeRuntimeAdapter({ command: "unused", storePath: filePath });
  const streamed: string[] = [];
  adapter.stream = vi.fn(async (input, onMessage) => {
    streamed.push(input.text);
    for (const message of frames(input.text)) onMessage(message);
    return { assistantText: input.text };
  });
  return { adapter, streamed };
}

describe("thread runtime backends", () => {
  it("streams a Claude turn as Tau events, persists the exchange and its usage, and restores both", async () => {
    const { filePath, store } = await scratchStore();
    const { adapter, streamed } = scriptedAdapter(filePath, (text) => turn(`Claude: ${text}`));
    const events: ThreadRuntimeEvent[] = [];
    let streamingWhileLive: boolean | undefined;
    const backend = new ClaudeThreadRuntimeBackend("tau-thread", "/repo", {
      adapter,
      store,
      commands,
      projectName: "repo",
      permissionLevel: () => "full",
      now: () => 42,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "tool-start") streamingWhileLive = backend.state().streaming;
      },
    });

    await backend.start("create");
    expect(backend.turnReporting).toBe("streamed");
    const prepared = await backend.preparePrompt("$tdd\n    preserve this", { source: "skill", name: "tdd", command: "/tdd", visibleText: "\n    preserve this" });
    expect(prepared).toMatchObject({ backendKind: "claude-code", visibleText: "\n    preserve this", runtimeText: "/tdd \n    preserve this", skill: { name: "tdd", command: "/tdd" } });
    const admitted = vi.fn();
    const result = await backend.prompt({ text: "$tdd\n    preserve this", identity: { clientTurnId: "turn-1", clientMessageId: "request-1" }, delivery: "prompt", prepared, onAdmitted: admitted });
    expect(streamed).toEqual(["/tdd \n    preserve this"]);
    expect(admitted).toHaveBeenCalledWith(true);
    expect(result).toEqual({ assistantText: "Claude: /tdd \n    preserve this" });
    expect(streamingWhileLive).toBe(true);
    expect(backend.state()).toMatchObject({ streaming: false, idle: true, hasMessages: true, activeTools: [], title: "preserve this" });

    expect(events.map((event) => event.type)).toEqual([
      "turn-started", "user-message", "assistant-start", "assistant-delta", "assistant-end", "tool-start", "tool-end", "usage", "turn-settled",
    ]);
    expect(events[1]).toMatchObject({ type: "user-message", message: { role: "user", text: "\n    preserve this", clientMessageId: "request-1", clientTurnId: "turn-1", skill: { name: "tdd" } } });
    expect(events.at(-1)).toEqual({ type: "turn-settled", status: "completed" });
    expect(await backend.transcript()).toMatchObject([
      { role: "user", text: "\n    preserve this", clientMessageId: "request-1", skill: { name: "tdd", command: "/tdd" } },
      { role: "assistant", text: "Claude: /tdd \n    preserve this" },
    ]);
    expect(backend.catalogView()).toMatchObject({
      model: { provider: "anthropic", id: "claude-opus-5" },
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, costUsd: 0.1, turns: 1 },
      contextUsage: { tokens: 100, contextWindow: 200000 },
    });
    // Claude offers no Pi-shaped capability at all; every such operation is refused in one place.
    expect(backend.capabilities).toEqual({});

    const restored = new ClaudeThreadRuntimeBackend("tau-thread", "/repo", { adapter, store: new ClaudeRuntimeSessionStore({ filePath }), commands, projectName: "repo" });
    await restored.start("resume");
    expect(await restored.transcript()).toMatchObject([
      { role: "user", text: "\n    preserve this", clientMessageId: "request-1" },
      { role: "assistant", text: "Claude: /tdd \n    preserve this" },
    ]);
    expect(restored.catalogView().usage).toEqual({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 110, costUsd: 0.1, turns: 1 });
    expect(restored.state().title).toBe("preserve this");
  });

  it("settles an aborted turn as interrupted and a broken one as an error the host hears about", async () => {
    const { filePath, store } = await scratchStore();
    const adapter = createClaudeCodeRuntimeAdapter({ command: "unused", storePath: filePath });
    const events: ThreadRuntimeEvent[] = [];
    const backend = new ClaudeThreadRuntimeBackend("tau-thread", "/repo", { adapter, store, commands, projectName: "repo", onEvent: (event) => { events.push(event); } });
    await backend.start("create");

    adapter.stream = vi.fn(async () => { throw Object.assign(new Error("Claude Code request aborted."), { name: "AbortError" }); });
    await expect(backend.prompt({ text: "stop me", delivery: "prompt" })).resolves.toEqual({});
    expect(events.at(-1)).toEqual({ type: "turn-settled", status: "interrupted" });

    adapter.stream = vi.fn(async () => { throw new Error("Claude Code reported an error: not logged in"); });
    await expect(backend.prompt({ text: "break", delivery: "prompt" })).rejects.toThrow("not logged in");
    expect(events.slice(-2)).toEqual([
      { type: "notice", message: "Claude Code reported an error: not logged in", level: "error" },
      { type: "turn-settled", status: "error" },
    ]);
    expect(backend.state().streaming).toBe(false);
  });

  it("rejects manual approvals during prompt preparation before transport use", async () => {
    const { filePath, store } = await scratchStore();
    const { adapter, streamed } = scriptedAdapter(filePath, turn);
    const backend = new ClaudeThreadRuntimeBackend("tau-thread", "/repo", { adapter, store, commands, projectName: "repo", permissionLevel: () => "ask" });
    await backend.start("create");
    await expect(backend.preparePrompt("$tdd inspect", { source: "skill", name: "tdd", command: "/tdd", visibleText: "inspect" })).rejects.toThrow("manual approvals are unsupported");
    expect(streamed).toEqual([]);
  });
});
