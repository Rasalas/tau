import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
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
  it.each([false, true])("preserves a final API failure in a success envelope with is_error=%s", (is_error) => {
    const { translator } = run([
      assistant([{ type: "text", text: "Looking." }]),
      success({ is_error, terminal_reason: "api_error", api_error_status: 400, result: "  API Error: 400 Request rejected by a safeguard.\n" }),
    ]);
    expect(translator.outcome).toMatchObject({ error: "API Error: 400 Request rejected by a safeguard.", texts: ["Looking."], usage: { costUsd: 0.25 } });
    expect(translator.outcome?.interrupted).toBeUndefined();
  });

  it("does not confuse a zero-turn terminal failure with a resume handshake", () => {
    const { translator } = run([success({ num_turns: 0, terminal_reason: "api_error", result: "API Error: 500 Could not start." })]);
    expect(translator.outcome?.error).toBe("API Error: 500 Could not start.");
  });

  it("uses a failure message when the final result repeats an ordinary reply", () => {
    const { translator } = run([success({ terminal_reason: "api_error", result: "I found three files." })]);
    expect(translator.outcome?.error).toBe("Claude gave up after repeated API errors.");
    expect(translator.outcome?.texts).toEqual([]);
  });

  it.each([
    "api_error", "blocking_limit", "rapid_refill_breaker", "prompt_too_long", "image_error", "model_error",
    "malformed_tool_use_exhausted", "max_turns", "budget_exhausted", "structured_output_retry_exhausted",
    "tool_deferred_unavailable", "turn_setup_failed",
  ] satisfies Array<NonNullable<SDKResultMessage["terminal_reason"]>>)("fails an unflagged terminal %s", (terminal_reason) => {
    const { translator } = run([success({ terminal_reason, result: "" })]);
    expect(translator.outcome?.error).toBeTruthy();
    expect(translator.outcome?.interrupted).toBeUndefined();
  });

  it.each(["completed", "stop_hook_prevented", "hook_stopped", "tool_deferred", "background_requested"] satisfies Array<NonNullable<SDKResultMessage["terminal_reason"]>>)("preserves the non-failure terminal reason %s", (terminal_reason) => {
    const { translator } = run([success({ terminal_reason })]);
    expect(translator.outcome?.texts).toEqual(["Done."]);
    expect(translator.outcome?.error).toBeUndefined();
  });

  it.each(["aborted_streaming", "aborted_tools"])("interrupts an unflagged success envelope with %s", (terminal_reason) => {
    const { translator } = run([success({ terminal_reason })]);
    expect(translator.outcome).toMatchObject({ interrupted: true });
    expect(translator.outcome?.error).toBeUndefined();
  });

  it("keeps diagnostic-only terminal API failures as errors and hides internal diagnostics", () => {
    const failed = (errors: string[]) => frame({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "api_error", num_turns: 1, errors, usage: {} });
    const diagnostic = "[ede_diagnostic] result_type=user last_content_type=n/a";
    const { translator } = run([failed([diagnostic])]);
    expect(translator.outcome?.error).toBe("Claude gave up after repeated API errors.");
    expect(translator.outcome?.interrupted).toBeUndefined();
    const mixed = run([failed([diagnostic, "Tool execution failed: EACCES"])]);
    expect(mixed.translator.outcome?.error).toBe("Tool execution failed: EACCES");
  });

  it("preserves rejected-window resets for an unflagged API error and recognizes HTTP 429 without a window", () => {
    const end = success({ terminal_reason: "api_error", api_error_status: 429, result: "API Error: 429 Too many requests." });
    const limited = run([frame({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 3600 } }), end]);
    expect(limited.translator.outcome).toMatchObject({ error: "API Error: 429 Too many requests.", limit: { resetsAt: 3_600_000 } });
    expect(run([end]).translator.outcome).toMatchObject({ limit: {} });
    const overloaded = run([success({ api_error_status: 529, result: "API Error: 529 Overloaded." })]);
    expect(overloaded.translator.outcome?.error).toBe("API Error: 529 Overloaded.");
    expect(overloaded.translator.outcome?.limit).toBeUndefined();
  });

  it("keeps context exhaustion distinct from a usage window for unflagged terminal results", () => {
    const { translator } = run([success({ terminal_reason: "prompt_too_long", result: "Prompt is too long" })]);
    expect(translator.outcome?.error).toContain("The context window is full.");
    expect(translator.outcome?.limit).toBeUndefined();
  });

  it("reports compaction while the CLI summarizes context, and clears it when the status ends", () => {
    const translator = new SdkTurnTranslator(() => 42);
    expect(translator.push(frame({ type: "system", subtype: "status", status: "compacting" }))).toEqual([
      { type: "context-compaction", running: true },
    ]);
    expect(translator.push(frame({ type: "system", subtype: "status", status: null }))).toEqual([
      { type: "context-compaction", running: false },
    ]);
  });

  it("closes a failed call as an error with the reason the CLI gave, unwrapped", () => {
    const { events } = run([
      assistant([{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/repo/missing.ts" } }]),
      toolResult("tool-1", "<tool_use_error>File does not exist.</tool_use_error>", true),
      assistant([{ type: "tool_use", id: "tool-2", name: "Bash", input: { command: "ls missing", description: "List it" } }]),
      toolResult("tool-2", "Exit code 1\nls: missing: No such file or directory", true),
    ]);
    expect(events.filter((event) => event.type === "tool-end").map((event) => event.type === "tool-end" && [event.tool.status, event.tool.output])).toEqual([
      ["error", "File does not exist."],
      ["error", "Exit code 1\nls: missing: No such file or directory"],
    ]);
  });

  it("stamps a streamed message with the time it began, so a steer sent while it streams stays below it", () => {
    let now = 100;
    const translator = new SdkTurnTranslator(() => now, () => "a1");
    const events = [messageStart(), textDelta("Look")].flatMap((message) => translator.push(message));
    now = 900;
    events.push(...translator.push(assistant([{ type: "text", text: "Looking." }])));
    expect(events.filter((event) => event.type === "assistant-start" || event.type === "assistant-end")).toEqual([
      { type: "assistant-start", id: "a1", timestamp: 100 },
      { type: "assistant-end", message: { id: "a1", role: "assistant", text: "Looking.", timestamp: 100 } },
    ]);
  });

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
      tallies: [{ provider: "anthropic", model: "claude-opus-5", inputTokens: 1200, outputTokens: 300, cacheReadTokens: 30000, cacheWriteTokens: 900, totalTokens: 32400, costUsd: 0.25, turns: 1 }],
      // Without a call's own usage, the result's stands in for the context.
      contextUsage: { tokens: 16700, contextWindow: 200000, percent: 8.4 },
    });
  });

  it("measures the context by the main loop's last call, not the turn's sum or a sub-agent's call", () => {
    const call = (content: unknown[], usage: object, parent: string | null = null) => frame({ type: "assistant", parent_tool_use_id: parent, message: { role: "assistant", content, usage } });
    const { translator } = run([
      call([{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } }], { input_tokens: 10, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 2_000, output_tokens: 300 }),
      toolResult("tool-1", "ok"),
      call([{ type: "text", text: "Done." }], { input_tokens: 5, cache_read_input_tokens: 122_300, cache_creation_input_tokens: 400, output_tokens: 95 }),
      call([{ type: "text", text: "sub-agent" }], { input_tokens: 5, cache_read_input_tokens: 900_000, output_tokens: 1 }, "task-1"),
      // The result sums every call of the turn: 4.1m here, past any window.
      success({ usage: { input_tokens: 40, output_tokens: 9_000, cache_read_input_tokens: 4_000_000, cache_creation_input_tokens: 100_000 }, modelUsage: { "claude-opus-5": { inputTokens: 40, outputTokens: 9_000, cacheReadInputTokens: 4_000_000, cacheCreationInputTokens: 100_000, costUSD: 1, contextWindow: 1_000_000, webSearchRequests: 0, maxOutputTokens: 64000 } } }),
    ]);
    expect(translator.outcome?.contextUsage).toEqual({ tokens: 122_800, contextWindow: 1_000_000, percent: 12.3 });
  });

  it("reads the prompt cache's lifetime from what the last writing call stored", () => {
    const call = (usage: object, parent: string | null = null) => frame({ type: "assistant", parent_tool_use_id: parent, message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage } });
    const ttl = (...calls: object[]) => run([...calls.map((usage) => call(usage)), success({ modelUsage: { "m": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 1, costUSD: 1, contextWindow: 200_000, webSearchRequests: 0, maxOutputTokens: 1 } } })]).translator.outcome?.promptCacheTtlMs;
    const wrote = (hour: number, five: number) => ({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: hour + five, cache_creation: { ephemeral_1h_input_tokens: hour, ephemeral_5m_input_tokens: five } });
    expect(ttl(wrote(2_000, 300))).toBe(60 * 60_000);
    expect(ttl(wrote(0, 300))).toBe(5 * 60_000);
    // A call that wrote nothing leaves the lifetime of the one before it.
    expect(ttl(wrote(0, 300), wrote(0, 0))).toBe(5 * 60_000);
    expect(ttl(wrote(0, 0))).toBeUndefined();
    expect(ttl({ input_tokens: 1, output_tokens: 1 })).toBeUndefined();
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

  it("turns compaction into a divider, and denied tools and a rejected usage window into notices, once per window", () => {
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
      { type: "assistant-end", message: { id: `claude-compaction-${now}`, role: "notice", text: "Context compacted", timestamp: now, compaction: { tokensBefore: 150000, tokensAfter: 20000 } } },
      { type: "notice", message: "Claude was not allowed to run Bash: plan mode", level: "warning" },
      { type: "notice", message: "Claude usage limit reached; this turn waits until the limit resets. It resumes in about 2 h 14 min.", level: "warning" },
    ]);
  });

  it("shows a hook's reason once, skips info lines, and ends a prompt the hook dropped without a reply", () => {
    const reason = "Prompt dropped by a hook: Deploys are frozen until Monday.";
    const translator = new SdkTurnTranslator(() => 42);
    const { events } = run([
      frame({ type: "system", subtype: "informational", content: "Started in the background: agent-1", level: "info", uuid: "u1" }),
      frame({ type: "system", subtype: "informational", content: reason, level: "warning", prevent_continuation: true, uuid: "u2" }),
      frame({ type: "result", subtype: "success", is_error: false, num_turns: 0, result: reason, total_cost_usd: 0, usage: {} }),
    ], translator);
    expect(events).toEqual([{ type: "assistant-end", message: { id: "claude-informational-u2", role: "notice", text: reason, timestamp: 42 } }]);
    expect(translator.outcome).toMatchObject({ texts: [] });
    expect(translator.outcome?.error).toBeUndefined();
  });

  it("still ignores an empty result a resumed session sends before the turn", () => {
    const translator = new SdkTurnTranslator(() => 42);
    run([frame({ type: "result", subtype: "success", is_error: false, num_turns: 0, result: "", total_cost_usd: 0, usage: {} })], translator);
    expect(translator.outcome).toBeUndefined();
  });

  it("names the limit a rejected usage window stopped the turn with", () => {
    const now = 1_000_000_000_000;
    const translator = new SdkTurnTranslator(() => now);
    run([
      frame({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: now / 1000 + 3600 } }),
      frame({ type: "result", subtype: "success", is_error: true, num_turns: 1, result: "You've hit your limit", total_cost_usd: 0, usage: {} }),
    ], translator);
    expect(translator.outcome).toMatchObject({ error: "You've hit your limit", limit: { resetsAt: now + 3_600_000 } });

  });

  it("takes a blocking_limit with an allowed window for a full context, and with a rejected one for a usage limit", () => {
    const now = 1_000_000_000_000;
    const ended = frame({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 189, errors: ["Prompt is too long"], terminal_reason: "blocking_limit", total_cost_usd: 0, usage: {} });
    const full = new SdkTurnTranslator(() => now);
    run([frame({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour" } }), ended], full);
    expect(full.outcome?.error).toBe("Prompt is too long\nThe context window is full. Compact the conversation or start a new thread.");
    expect(full.outcome).not.toHaveProperty("limit");

    const bare = new SdkTurnTranslator(() => now);
    run([ended], bare);
    expect(bare.outcome).not.toHaveProperty("limit");

    const limited = new SdkTurnTranslator(() => now);
    run([frame({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: now / 1000 + 3600 } }), ended], limited);
    expect(limited.outcome).toMatchObject({ error: "Prompt is too long", limit: { resetsAt: now + 3_600_000 } });
  });

  describe("the update a newer model writes before a tool call", () => {
    const plan = "Planning the check";
    const update = "Found it: the memory file is the cause.";
    const tool = { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } };
    const thought = (thinking: string) => ({ type: "thinking", thinking });
    // The SDK reports one snapshot per completed content block, all under the message id.
    const snapshots = (model: string, blocks: unknown[]) => blocks.map((block) => frame({ type: "assistant", parent_tool_use_id: null, message: { id: "msg-1", model, role: "assistant", content: [block] } }));
    const rows = (messages: SDKMessage[]) => {
      let count = 0;
      const translator = new SdkTurnTranslator(() => 42, () => `a${count++}`);
      const latest = new Map<string, { text: string; thinking?: string }>();
      for (const event of run(messages, translator).events) {
        if (event.type === "assistant-end") latest.set(event.message.id, { text: event.message.text, ...(event.message.thinking ? { thinking: event.message.thinking } : {}) });
      }
      return [...latest.values()];
    };

    it.each(["claude-opus-5-5", "claude-fable-5-1"])("shows the second of two thoughts before a tool call from %s as text", (model) => {
      expect(rows(snapshots(model, [thought(plan), thought(update), tool]))).toEqual([{ text: "", thinking: plan }, { text: update }]);
    });

    it("does the same when one message carries all of its blocks", () => {
      const message = frame({ type: "assistant", parent_tool_use_id: null, message: { id: "msg-1", model: "claude-opus-5-5", role: "assistant", content: [thought(plan), thought(update), tool] } });
      expect(rows([message])).toEqual([{ text: update, thinking: plan }]);
    });

    it.each([
      ["a model before 5.1", "claude-opus-5", [thought(plan), thought(update), tool]],
      ["an older model", "claude-sonnet-4-6", [thought(plan), thought(update), tool]],
      ["a lone thought", "claude-opus-5-5", [thought(plan), tool]],
      ["an empty second thought", "claude-opus-5-5", [thought(plan), thought(" \n "), tool]],
      ["an empty first thought", "claude-opus-5-5", [thought(" \n "), thought(update), tool]],
      ["a text block between", "claude-opus-5-5", [thought(plan), thought(update), { type: "text", text: "Now." }, tool]],
    ] as const)("keeps thoughts as thoughts for %s", (_name, model, blocks) => {
      const kept = rows(snapshots(model, [...blocks]));
      expect(kept.every((row) => row.text !== update)).toBe(true);
      expect(kept.some((row) => row.thinking === update || row.thinking === plan)).toBe(true);
    });
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

  it("splits a turn over the models it called, the SDK's cost spread by their share, and keeps the plan's windows it saw", () => {
    const { translator } = run([
      init("claude-sonnet-5"),
      frame({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.81, resetsAt: 1_790_000_000 } }),
      success({
        total_cost_usd: 0.3,
        modelUsage: {
          "claude-haiku-4-5": { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.05, contextWindow: 200000 },
          "claude-sonnet-5": { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 500, cacheCreationInputTokens: 0, costUSD: 0.1, contextWindow: 200000 },
        },
      }),
    ]);
    const tallies = translator.outcome?.tallies ?? [];
    expect(tallies.map((tally) => [tally.model, tally.turns, Math.round(tally.costUsd * 100)])).toEqual([["claude-haiku-4-5", 0, 10], ["claude-sonnet-5", 1, 20]]);
    expect(translator.facts.rateLimits).toEqual([{ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.81, resetsAt: 1_790_000_000 }]);
  });
});
