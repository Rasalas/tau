import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { ThreadRuntimeEvent } from "tau/host-extension";
import { addUsage, boundedToolOutput, MAX_TOOL_OUTPUT_BYTES, SdkTurnTranslator } from "./sdk-events.js";

const SESSION = "123e4567-e89b-42d3-a456-426614174000";
const frame = <T extends object>(value: T): SDKMessage => ({ uuid: "u", session_id: SESSION, ...value }) as unknown as SDKMessage;
const init = (model = "claude-opus-5") => frame({ type: "system", subtype: "init", model, claude_code_version: "2.1.263", apiKeySource: "none" });
const messageStart = (parent: string | null = null) => frame({ type: "stream_event", parent_tool_use_id: parent, event: { type: "message_start", message: {} } });
const textDelta = (text: string, parent: string | null = null) => frame({ type: "stream_event", parent_tool_use_id: parent, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const thinkingDelta = (thinking: string) => frame({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } } });
const assistant = (content: unknown[], parent: string | null = null) => frame({ type: "assistant", parent_tool_use_id: parent, message: { role: "assistant", content } });
const toolResult = (id: string, content: unknown, isError = false) => frame({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
const success = (extra: object = {}) => frame({
  type: "result", subtype: "success", is_error: false, num_turns: 3, result: "Done.", total_cost_usd: 0.25,
  usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 15000, cache_creation_input_tokens: 500 },
  modelUsage: { "claude-opus-5": { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 30000, cacheCreationInputTokens: 900, costUSD: 0.2, contextWindow: 200000, webSearchRequests: 0, maxOutputTokens: 32000 } },
  ...extra,
});

function run(frames: SDKMessage[], translator = new SdkTurnTranslator(() => 42, () => "a1")): { events: ThreadRuntimeEvent[]; translator: SdkTurnTranslator } {
  const events = frames.flatMap((message) => translator.push(message));
  return { events, translator };
}

describe("SdkTurnTranslator", () => {
  it("streams the main loop's text, opens tool cards from the whole assistant message and closes them on the result", () => {
    let ids = 0;
    const translator = new SdkTurnTranslator(() => 42, () => `a${++ids}`);
    const { events } = run([
      init(),
      messageStart(),
      thinkingDelta("hm"),
      textDelta("Looking"),
      textDelta("."),
      assistant([{ type: "thinking", thinking: "hm" }, { type: "text", text: "Looking." }, { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } }]),
      toolResult("tool-1", [{ type: "text", text: "file.txt" }]),
      messageStart(),
      textDelta("Done."),
      assistant([{ type: "text", text: "Done." }]),
      success(),
    ], translator);
    expect(events).toEqual([
      { type: "assistant-start", id: "a1", timestamp: 42 },
      { type: "assistant-thinking", id: "a1", delta: "hm" },
      { type: "assistant-delta", id: "a1", delta: "Looking" },
      { type: "assistant-delta", id: "a1", delta: "." },
      { type: "assistant-end", message: { id: "a1", role: "assistant", text: "Looking.", thinking: "hm", timestamp: 42 } },
      { type: "tool-start", tool: { id: "tool-1", name: "Bash", args: { command: "ls" }, status: "running", startedAt: 42 } },
      { type: "tool-end", tool: { id: "tool-1", name: "Bash", args: { command: "ls" }, status: "done", output: "file.txt", startedAt: 42, endedAt: 42 } },
      { type: "assistant-start", id: "a2", timestamp: 42 },
      { type: "assistant-delta", id: "a2", delta: "Done." },
      { type: "assistant-end", message: { id: "a2", role: "assistant", text: "Done.", timestamp: 42 } },
    ]);
    expect(translator.running.size).toBe(0);
    expect(translator.facts).toEqual({ model: "claude-opus-5", claudeCodeVersion: "2.1.263", apiKeySource: "none" });
    expect(translator.outcome).toEqual({
      texts: ["Looking.", "Done."],
      // Per-model totals cover sub-agents and compaction too; the SDK's own cost estimate wins.
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 30000, cacheWriteTokens: 900, totalTokens: 32400, costUsd: 0.25, turns: 1 },
      // The context window holds what the main loop's last call read.
      contextUsage: { tokens: 16500, contextWindow: 200000, percent: 8.3 },
    });
  });

  it("keeps sub-agent narration out but shows their tool calls, and opens no row for a tool-only message", () => {
    const { events, translator } = run([
      messageStart("task-1"),
      textDelta("sub-agent thinking aloud", "task-1"),
      assistant([{ type: "text", text: "sub-agent says" }, { type: "tool_use", id: "tool-2", name: "Read", input: { file_path: "a.ts" } }], "task-1"),
      messageStart(),
      assistant([{ type: "tool_use", id: "task-1", name: "Task", input: { prompt: "look" } }]),
      toolResult("tool-2", "contents", true),
      success({ result: "" }),
    ]);
    expect(events).toEqual([
      { type: "tool-start", tool: { id: "tool-2", name: "Read", args: { file_path: "a.ts" }, status: "running", startedAt: 42 } },
      { type: "tool-start", tool: { id: "task-1", name: "Task", args: { prompt: "look" }, status: "running", startedAt: 42 } },
      { type: "tool-end", tool: { id: "tool-2", name: "Read", args: { file_path: "a.ts" }, status: "error", output: "contents", startedAt: 42, endedAt: 42 } },
    ]);
    expect(translator.running.has("task-1")).toBe(true);
    expect(translator.outcome?.texts).toEqual([]);
  });

  it("ignores the resume handshake, records an error result, and closes an unknown tool without a name", () => {
    const handshake = run([init(), success({ num_turns: 0, result: "" })]);
    expect(handshake.translator.outcome).toBeUndefined();

    const failed = run([init(), frame({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, errors: ["API error", "log in again"], total_cost_usd: 0, usage: {} })]);
    expect(failed.translator.outcome).toMatchObject({ error: "API error\nlog in again", usage: { turns: 1, costUsd: 0 } });

    // A stopped turn comes back as an error result with an aborted reason or a diagnostic; that is an interruption, not a failure.
    const stopped = run([init(), frame({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"], terminal_reason: "aborted_tools", total_cost_usd: 0.01, usage: {} })]);
    expect(stopped.translator.outcome).toMatchObject({ interrupted: true, usage: { costUsd: 0.01 } });
    expect(stopped.translator.outcome?.error).toBeUndefined();
    const diagnosticOnly = run([frame({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, errors: ["[ede_diagnostic] result_type=user"], total_cost_usd: 0, usage: {} })]);
    expect(diagnosticOnly.translator.outcome).toMatchObject({ interrupted: true });

    const orphan = run([toolResult("ghost", "x")]);
    expect(orphan.events).toEqual([{ type: "tool-end", tool: { id: "ghost", name: "tool", args: {}, status: "done", output: "x", startedAt: 42, endedAt: 42 } }]);
  });

  it("turns compaction, denied tools and a rejected usage window into notices, once per window", () => {
    const now = 1_000_000_000_000;
    const translator = new SdkTurnTranslator(() => now);
    const rejected = frame({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: now / 1000 + 2 * 3600 + 14 * 60 } });
    const { events } = run([
      frame({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 150000, post_tokens: 20000 } }),
      frame({ type: "system", subtype: "permission_denied", tool_name: "Bash", reason: "plan mode" }),
      rejected,
      rejected,
      frame({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour" } }),
    ], translator);
    expect(events).toEqual([
      { type: "notice", message: "Claude compacted the conversation (150,000 → 20,000 tokens).", level: "info" },
      { type: "notice", message: "Claude was not allowed to run Bash: plan mode", level: "warning" },
      { type: "notice", message: "Claude usage limit reached; this turn waits until the limit resets. It resumes in about 2 h 14 min.", level: "warning" },
    ]);
  });

  it("names the limit a rejected usage window stopped the turn with", () => {
    const now = 1_000_000_000_000;
    const translator = new SdkTurnTranslator(() => now);
    run([
      frame({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: now / 1000 + 3600 } }),
      frame({ type: "result", subtype: "success", is_error: true, num_turns: 1, result: "You've hit your limit", total_cost_usd: 0, usage: {} }),
    ], translator);
    expect(translator.outcome).toMatchObject({ error: "You've hit your limit", limit: { resetsAt: now + 3_600_000 } });

    const blocked = new SdkTurnTranslator(() => now);
    run([frame({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, errors: ["blocked"], terminal_reason: "blocking_limit", total_cost_usd: 0, usage: {} })], blocked);
    expect(blocked.outcome).toMatchObject({ error: "blocked", limit: {} });
  });

  it("bounds tool output to the host's limit and sums usage", () => {
    const long = "x".repeat(MAX_TOOL_OUTPUT_BYTES + 10);
    const bounded = boundedToolOutput(long);
    expect(bounded.startsWith("[Earlier tool output truncated")).toBe(true);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThan(MAX_TOOL_OUTPUT_BYTES + 200);
    expect(addUsage(
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 10, costUsd: 0.5, turns: 1 },
      { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, totalTokens: 100, costUsd: 0.25, turns: 1 },
    )).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44, totalTokens: 110, costUsd: 0.75, turns: 2 });
  });
});
