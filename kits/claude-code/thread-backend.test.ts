import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendPrompt, ExtensionUiAnswer, ThreadRuntimeEvent, UiComposerCommand } from "tau/host-extension";
import { createClaudeCodeRuntimeAdapter, type ClaudeSessionInput } from "./runtime-adapter.js";
import type { ClaudeSdkSession, ResultMessage, SendPriority, UserContent } from "./sdk-session.js";
import { ClaudeRuntimeSessionStore } from "./session-store.js";
import { ClaudeThreadRuntimeBackend, promptContent } from "./thread-backend.js";

const directories: string[] = [];
const commands: UiComposerCommand[] = [{ name: "skill:tdd", source: "skill", description: "Test first" }];
const SESSION = "123e4567-e89b-42d3-a456-426614174000";
const frame = <T extends object>(value: T): SDKMessage => ({ uuid: "u", session_id: SESSION, ...value }) as unknown as SDKMessage;
const init = () => frame({ type: "system", subtype: "init", model: "claude-opus-5" });
const result = (text: string, extra: object = {}) => frame({
  type: "result", subtype: "success", is_error: false, num_turns: 2, result: text, total_cost_usd: 0.1,
  usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: { "claude-opus-5": { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.1, contextWindow: 200000 } },
  ...extra,
}) as ResultMessage;
const turn = (text: string): SDKMessage[] => [
  frame({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: {} } }),
  frame({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } }),
  frame({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text }, { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "a.ts" } }] } }),
  frame({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "export {}" }] } }),
  result(text),
];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function scratchStore(): Promise<{ filePath: string; store: ClaudeRuntimeSessionStore }> {
  const directory = await mkdtemp(join(tmpdir(), "tau-thread-backend-"));
  directories.push(directory);
  const filePath = join(directory, "sessions.json");
  return { filePath, store: new ClaudeRuntimeSessionStore({ filePath }) };
}

type Script = (content: UserContent, priority: SendPriority, input: ClaudeSessionInput) => SDKMessage[] | Promise<SDKMessage[]>;

const abortError = () => Object.assign(new Error("Claude Code session ended before the turn finished."), { name: "AbortError" });

/**
 * A session like the real one: turns run one after another, a steer resolves
 * with the running turn, frames reach the backend's frame route, and closing
 * rejects whatever is pending.
 */
function fakeSession(input: ClaudeSessionInput, script: Script) {
  let closed = false;
  let pending = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let running: Promise<ResultMessage> | undefined;
  const cancels = new Set<(error: Error) => void>();
  const execute = async (content: UserContent, priority: SendPriority): Promise<ResultMessage> => {
    if (closed) throw abortError();
    const frames = await Promise.race([script(content, priority, input), new Promise<never>((_, reject) => cancels.add(reject))]);
    for (const message of frames) input.onMessage(message);
    const last = frames.at(-1);
    if (last?.type !== "result") throw abortError();
    return last as ResultMessage;
  };
  const session = {
    get busy() { return pending > 0; },
    get closed() { return closed; },
    send: vi.fn((content: UserContent, priority: SendPriority): Promise<ResultMessage> => {
      if (closed) return Promise.reject(abortError());
      if (priority === "now" && running) return running;
      pending += 1;
      const run = tail.then(() => execute(content, priority)).finally(() => { pending -= 1; if (running === run) running = undefined; });
      tail = run.catch(() => undefined);
      running = run;
      return run;
    }),
    interrupt: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setEffort: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => []),
    close: vi.fn(async () => {
      if (closed) return;
      closed = true;
      for (const cancel of cancels) cancel(abortError());
      input.onExit(undefined);
    }),
  };
  return session as unknown as ClaudeSdkSession & typeof session;
}

function scriptedAdapter(filePath: string, script: Script) {
  const adapter = createClaudeCodeRuntimeAdapter({ command: "unused", storePath: filePath });
  const opened: ClaudeSessionInput[] = [];
  const sessions: ReturnType<typeof fakeSession>[] = [];
  adapter.openSession = vi.fn((input: ClaudeSessionInput) => {
    opened.push(input);
    const session = fakeSession(input, script);
    sessions.push(session);
    queueMicrotask(() => input.onMessage(init()));
    return session;
  });
  return { adapter, opened, sessions };
}

describe("thread runtime backends", () => {
  it("streams a Claude turn as Tau events, persists the exchange and its usage, and restores both", async () => {
    const { filePath, store } = await scratchStore();
    const { adapter, opened, sessions } = scriptedAdapter(filePath, (content) => turn(`Claude: ${String(content)}`));
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
    const first = await backend.prompt({ text: "$tdd\n    preserve this", identity: { clientTurnId: "turn-1", clientMessageId: "request-1" }, delivery: "prompt", prepared, onAdmitted: admitted });
    expect(sessions[0]?.send).toHaveBeenCalledWith("/tdd \n    preserve this", "next");
    expect(opened[0]).toMatchObject({ cwd: "/repo", started: false, permissionLevel: "full" });
    expect(admitted).toHaveBeenCalledWith(true);
    expect(first).toEqual({ assistantText: "Claude: /tdd \n    preserve this" });
    expect(streamingWhileLive).toBe(true);
    expect(backend.state()).toMatchObject({ streaming: false, idle: true, hasMessages: true, activeTools: [], title: "preserve this", supportsImageInput: true });

    expect(events.map((event) => event.type)).toEqual([
      "turn-started", "queue", "user-message", "assistant-start", "assistant-delta", "assistant-end", "tool-start", "tool-end", "usage", "turn-settled", "queue",
    ]);
    expect(events[2]).toMatchObject({ type: "user-message", message: { role: "user", text: "\n    preserve this", clientMessageId: "request-1", clientTurnId: "turn-1", skill: { name: "tdd" } } });
    expect(events.find((event) => event.type === "turn-settled")).toEqual({ type: "turn-settled", status: "completed" });

    // The second turn rides the same session and resumes nothing.
    await backend.prompt({ text: "again", delivery: "prompt" });
    expect(opened).toHaveLength(1);
    expect(sessions[0]?.send).toHaveBeenCalledTimes(2);
    expect((await store.get("tau-thread"))).toMatchObject({ started: true, attemptCount: 1, lastAttemptOutcome: "started" });

    expect(await backend.transcript()).toMatchObject([
      { role: "user", text: "\n    preserve this", clientMessageId: "request-1", skill: { name: "tdd", command: "/tdd" } },
      { role: "assistant", text: "Claude: /tdd \n    preserve this" },
      { role: "user", text: "again" },
      { role: "assistant", text: "Claude: again" },
    ]);
    expect(backend.catalogView()).toMatchObject({
      model: { provider: "anthropic", id: "claude-opus-5" },
      usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220, costUsd: 0.2, turns: 2 },
      contextUsage: { tokens: 100, contextWindow: 200000 },
    });
    // Beside the model and effort pickers, Claude offers no Pi-shaped capability; every such operation is refused in one place.
    expect(Object.keys(backend.capabilities)).toEqual(["catalogWrite"]);

    await backend.dispose();
    expect(sessions[0]?.close).toHaveBeenCalled();
    const restored = new ClaudeThreadRuntimeBackend("tau-thread", "/repo", { adapter, store: new ClaudeRuntimeSessionStore({ filePath }), commands, projectName: "repo" });
    await restored.start("resume");
    expect((await restored.transcript()).map((message) => message.text)).toEqual(["\n    preserve this", "Claude: /tdd \n    preserve this", "again", "Claude: again"]);
    expect(restored.catalogView().usage).toMatchObject({ totalTokens: 220, costUsd: 0.2, turns: 2 });
    expect(restored.state().title).toBe("preserve this");
    // A resumed thread opens its session with `started` so the CLI resumes the Claude session.
    await restored.prompt({ text: "third", delivery: "prompt" });
    expect(opened[1]).toMatchObject({ started: true, claudeSessionId: opened[0]!.claudeSessionId });
  });

  it("steers the running turn, queues a follow-up behind it, and reports the queue", async () => {
    const { filePath, store } = await scratchStore();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const { adapter, sessions } = scriptedAdapter(filePath, async (content, priority) => {
      if (priority === "now") return [result("joined", { user_message_uuids: [] })];
      if (String(content) === "first") { await firstGate; return turn("one"); }
      return turn("two");
    });
    const events: ThreadRuntimeEvent[] = [];
    const backend = new ClaudeThreadRuntimeBackend("tau-thread", "/repo", { adapter, store, commands, projectName: "repo", onEvent: (event) => { events.push(event); } });
    await backend.start("create");
    const first = backend.prompt({ text: "first", delivery: "prompt" });
    await until(() => backend.state().streaming);
    const followUp = backend.prompt({ text: "second", delivery: "followUp" });
    await until(() => (sessions[0]?.send.mock.calls.length ?? 0) >= 2);
    // A steer returns as soon as it is on its way, so the composer is free again.
    await expect(backend.prompt({ text: "also", delivery: "steer" })).resolves.toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events.filter((event) => event.type === "queue").at(-1)).toEqual({ type: "queue", steering: ["also"], followUp: ["second"] });
    expect(sessions[0]?.send).toHaveBeenNthCalledWith(1, "first", "next");
    expect(sessions[0]?.send).toHaveBeenNthCalledWith(2, "second", "later");
    expect(sessions[0]?.send).toHaveBeenNthCalledWith(3, "also", "now");
    releaseFirst();
    await Promise.all([first, followUp]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const settled = events.filter((event) => event.type === "turn-settled");
    expect(settled).toHaveLength(2);
    expect(events.filter((event) => event.type === "turn-started")).toHaveLength(2);
    expect(events.filter((event) => event.type === "queue").at(-1)).toEqual({ type: "queue", steering: [], followUp: [] });
    expect((await backend.transcript()).map((message) => message.text)).toEqual(["first", "second", "also", "one", "two"]);
  });

  it("interrupts a turn, closes the session when the interrupt is not honoured, and settles it as interrupted", async () => {
    const { filePath, store } = await scratchStore();
    const { adapter, sessions } = scriptedAdapter(filePath, () => new Promise(() => undefined));
    const events: ThreadRuntimeEvent[] = [];
    const backend = new ClaudeThreadRuntimeBackend("tau-thread", "/repo", { adapter, store, commands, projectName: "repo", interruptGraceMs: 50, onEvent: (event) => { events.push(event); } });
    await backend.start("create");
    const pending = backend.prompt({ text: "hang", delivery: "prompt" });
    await until(() => backend.state().streaming && (sessions[0]?.send.mock.calls.length ?? 0) === 1);
    await backend.abort();
    expect(sessions[0]?.interrupt).toHaveBeenCalled();
    expect(sessions[0]?.close).toHaveBeenCalled();
    await expect(pending).resolves.toEqual({});
    expect(events.filter((event) => event.type === "turn-settled")).toEqual([{ type: "turn-settled", status: "interrupted" }]);
    expect(backend.state().streaming).toBe(false);
    // The next prompt opens a fresh process that resumes the same Claude session.
    adapter.openSession = vi.fn((input: ClaudeSessionInput) => fakeSession(input, () => turn("back")));
    await expect(backend.prompt({ text: "back", delivery: "prompt" })).resolves.toEqual({ assistantText: "back" });
    expect(adapter.openSession).toHaveBeenCalledWith(expect.objectContaining({ started: true }));
  });

  it("settles a turn the CLI reports as aborted as interrupted, without a notice or a failed attempt", async () => {
    const { filePath, store } = await scratchStore();
    const { adapter } = scriptedAdapter(filePath, () => [
      frame({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: {} } }),
      frame({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Starting" } } }),
      frame({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"], terminal_reason: "aborted_tools", total_cost_usd: 0.02, usage: {} }),
    ]);
    const events: ThreadRuntimeEvent[] = [];
    const backend = new ClaudeThreadRuntimeBackend("tau-thread", "/repo", { adapter, store, commands, projectName: "repo", onEvent: (event) => { events.push(event); } });
    await backend.start("create");
    await expect(backend.prompt({ text: "long job", delivery: "prompt" })).resolves.toEqual({});
    expect(events.filter((event) => event.type === "notice")).toEqual([]);
    expect(events.filter((event) => event.type === "turn-settled")).toEqual([{ type: "turn-settled", status: "interrupted" }]);
    expect(backend.catalogView().usage).toMatchObject({ costUsd: 0.02, turns: 1 });
    expect((await store.get("tau-thread"))?.lastAttemptOutcome).not.toBe("failed");
  });

  it("settles a broken turn as an error the host hears about, and reports a session that died", async () => {
    const { filePath, store } = await scratchStore();
    const { adapter, sessions } = scriptedAdapter(filePath, () => [init(), frame({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, errors: ["not logged in"], total_cost_usd: 0, usage: {} })]);
    const events: ThreadRuntimeEvent[] = [];
    const backend = new ClaudeThreadRuntimeBackend("tau-thread", "/repo", { adapter, store, commands, projectName: "repo", onEvent: (event) => { events.push(event); } });
    await backend.start("create");
    await expect(backend.prompt({ text: "break", delivery: "prompt" })).rejects.toThrow("not logged in");
    expect(events.filter((event) => event.type === "notice" || event.type === "turn-settled")).toEqual([
      { type: "notice", message: "Claude Code reported an error: not logged in", level: "error" },
      { type: "turn-settled", status: "error" },
    ]);
    expect(backend.state().streaming).toBe(false);
    expect((await store.get("tau-thread"))?.lastAttemptOutcome).toBe("failed");

    // The CLI dies mid-turn: the session rejects the send and reports the exit; the turn settles as an error.
    const input = (adapter.openSession as unknown as { mock: { calls: ClaudeSessionInput[][] } }).mock.calls[0]![0]!;
    sessions[0]!.send = vi.fn(async () => {
      queueMicrotask(() => input.onExit(new Error("process exited with code 1")));
      throw new Error("process exited with code 1");
    }) as never;
    await expect(backend.prompt({ text: "again", delivery: "prompt" })).rejects.toThrow("process exited with code 1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.slice(-3)).toEqual([
      { type: "notice", message: "Claude Code stopped: process exited with code 1", level: "error" },
      { type: "turn-settled", status: "error" },
      { type: "queue", steering: [], followUp: [] },
    ]);
    expect(backend.state().streaming).toBe(false);
  });

  it("recovers a resumed session Claude no longer has by creating it once under the same id", async () => {
    const { filePath, store } = await scratchStore();
    await store.ensure("tau-thread", "/repo");
    await store.markStarted("tau-thread", "/repo");
    const { adapter, opened } = scriptedAdapter(filePath, (_content, _priority, input) => input.started
      ? [frame({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, errors: [`No conversation found with session ID: ${input.claudeSessionId}`], total_cost_usd: 0, usage: {} })]
      : turn("fresh"));
    const backend = new ClaudeThreadRuntimeBackend("tau-thread", "/repo", { adapter, store, commands, projectName: "repo", onEvent: () => undefined });
    await backend.start("resume");
    await expect(backend.prompt({ text: "hello", delivery: "prompt" })).resolves.toEqual({ assistantText: "fresh" });
    expect(opened.map((input) => input.started)).toEqual([true, false]);
    expect(await store.get("tau-thread")).toMatchObject({ createFallbackUsed: true, started: true });
  });

  it("sends images before the text and shows them on the user's row", async () => {
    const { filePath, store } = await scratchStore();
    const { adapter, sessions } = scriptedAdapter(filePath, () => turn("seen"));
    const events: ThreadRuntimeEvent[] = [];
    const backend = new ClaudeThreadRuntimeBackend("tau-thread", "/repo", { adapter, store, commands, projectName: "repo", onEvent: (event) => { events.push(event); } });
    await backend.start("create");
    const attachment = { kind: "image" as const, name: "shot.png", mimeType: "image/png", data: "AAAA", size: 4 };
    await backend.prompt({ text: "what is this?", delivery: "prompt", attachments: [attachment] });
    expect(sessions[0]?.send).toHaveBeenCalledWith(promptContent("what is this?", [attachment]), "next");
    expect(promptContent("what is this?", [attachment])).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "what is this?" },
    ]);
    expect(events.find((event) => event.type === "user-message")).toMatchObject({ message: { images: [{ mimeType: "image/png", data: "AAAA" }] } });
  });

  it("lists the plan's models, and keeps the chosen model and effort for the live session and the next one", async () => {
    const { filePath, store } = await scratchStore();
    const { adapter, opened, sessions } = scriptedAdapter(filePath, () => turn("ok"));
    const infos = [{ value: "opus", displayName: "Opus", description: "", supportedEffortLevels: ["low", "high", "max"] as Array<"low" | "high" | "max"> }, { value: "sonnet", displayName: "Sonnet", description: "" }];
    adapter.probe = vi.fn(async () => ({ models: infos.map((info) => ({ provider: "anthropic", id: info.value, name: info.displayName })), modelInfos: infos, probedAt: 1 }));
    const backend = new ClaudeThreadRuntimeBackend("tau-thread", "/repo", { adapter, store, commands, projectName: "repo", onEvent: () => undefined });
    await backend.start("create");
    // Idle: the shared probe answers; the picker starts at the CLI's default.
    expect(await backend.models()).toEqual([{ provider: "anthropic", id: "opus", name: "Opus" }, { provider: "anthropic", id: "sonnet", name: "Sonnet" }]);
    expect(backend.catalogView()).toMatchObject({ thinkingLevel: "default", thinkingLevels: ["default", "low", "medium", "high", "xhigh", "max"] });

    await backend.prompt({ text: "hello", delivery: "prompt" });
    expect(opened[0]).not.toHaveProperty("model");
    await backend.capabilities.catalogWrite!.setModel("anthropic", "opus");
    await backend.capabilities.catalogWrite!.setThinkingLevel("max");
    expect(sessions[0]?.setModel).toHaveBeenCalledWith("opus");
    expect(sessions[0]?.setEffort).toHaveBeenCalledWith("max");
    expect(backend.catalogView()).toMatchObject({ model: { id: "opus", name: "Opus" }, thinkingLevel: "max", thinkingLevels: ["default", "low", "high", "max"] });
    await expect(backend.capabilities.catalogWrite!.setThinkingLevel("enormous")).rejects.toThrow('knows no effort "enormous"');
    await backend.capabilities.catalogWrite!.setThinkingLevel("default");
    expect(sessions[0]?.setEffort).toHaveBeenLastCalledWith(null);
    await backend.capabilities.catalogWrite!.setThinkingLevel("high");

    // The choice is persisted and opens the next session.
    await backend.dispose();
    const restored = new ClaudeThreadRuntimeBackend("tau-thread", "/repo", { adapter, store: new ClaudeRuntimeSessionStore({ filePath }), commands, projectName: "repo", onEvent: () => undefined });
    await restored.start("resume");
    expect(restored.catalogView()).toMatchObject({ model: { id: "opus" }, thinkingLevel: "high" });
    await restored.prompt({ text: "again", delivery: "prompt" });
    expect(opened[1]).toMatchObject({ model: "opus", effort: "high" });
  });

  it("rejects manual approvals without a dialog surface, before a session is opened", async () => {
    const { filePath, store } = await scratchStore();
    const { adapter, opened } = scriptedAdapter(filePath, () => turn("x"));
    const backend = new ClaudeThreadRuntimeBackend("tau-thread", "/repo", { adapter, store, commands, projectName: "repo", permissionLevel: () => "ask" });
    await backend.start("create");
    await expect(backend.preparePrompt("$tdd inspect", { source: "skill", name: "tdd", command: "/tdd", visibleText: "inspect" })).rejects.toThrow("manual approvals are unsupported");
    expect(opened).toEqual([]);
  });

  it("answers Claude's questions through the workbench and follows a level change on the live session", async () => {
    const { filePath, store } = await scratchStore();
    const asked: BackendPrompt[] = [];
    const answers: ExtensionUiAnswer[] = [
      { value: "Allow for this session" },
      { value: "luxon — zones" },
      { confirmed: false },
      { value: "Compact and continue" },
      { cancelled: true },
    ];
    const ask = vi.fn(async (prompt: BackendPrompt): Promise<ExtensionUiAnswer> => { asked.push(prompt); return answers.shift() ?? { cancelled: true as const }; });
    const results: unknown[] = [];
    const { adapter, opened, sessions } = scriptedAdapter(filePath, async (_content, _priority, input) => {
      const hooks = input.hooks!;
      const signal = new AbortController().signal;
      if (results.length === 0) {
        results.push(await hooks.canUseTool!("Bash", { command: "ls" }, { signal, toolUseID: "t1", requestId: "r1", suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls:*" }], behavior: "allow", destination: "localSettings" }] }));
        results.push(await hooks.canUseTool!("AskUserQuestion", { questions: [{ question: "Which library?", header: "Library", options: [{ label: "date-fns", description: "small" }, { label: "luxon", description: "zones" }] }] }, { signal, toolUseID: "t2", requestId: "r2" }));
        results.push(await hooks.canUseTool!("ExitPlanMode", {}, { signal, toolUseID: "t3", requestId: "r3" }));
        results.push(await hooks.onUserDialog!({ dialogKind: "resume_return", payload: {} }, { signal, requestId: "r4" }));
        results.push(await hooks.onUserDialog!({ dialogKind: "something_new", payload: {} }, { signal, requestId: "r5" }));
        results.push(await hooks.canUseTool!("Write", { file_path: "a.ts" }, { signal, toolUseID: "t6", requestId: "r6" }));
      }
      return turn("ok");
    });
    let level: "ask" | "read-only" = "ask";
    const backend = new ClaudeThreadRuntimeBackend("tau-thread", "/repo", { adapter, store, commands, projectName: "repo", permissionLevel: () => level, ask, onEvent: () => undefined });
    await backend.start("create");
    await backend.prompt({ text: "go", delivery: "prompt" });
    expect(opened[0]).toMatchObject({ permissionLevel: "ask" });
    expect(asked.map((prompt) => prompt.title)).toEqual([
      "Claude wants to run Bash",
      "Which library?",
      "Approve Claude's plan?",
      "This conversation is long. Compact it before continuing?",
      "Claude wants to run Write",
    ]);
    expect(results).toEqual([
      { behavior: "allow", decisionClassification: "user_permanent", updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls:*" }], behavior: "allow", destination: "session" }] },
      { behavior: "allow", decisionClassification: "user_temporary", updatedInput: { questions: expect.any(Array), answers: { "Which library?": "luxon" } } },
      { behavior: "deny", message: expect.stringContaining("did not approve the plan"), decisionClassification: "user_reject" },
      { behavior: "completed", result: "compact" },
      { behavior: "cancelled" },
      { behavior: "deny", message: "The user cancelled the request.", decisionClassification: "user_reject" },
    ]);
    // A level change reaches the live session before the next send instead of a new process.
    level = "read-only";
    await backend.prompt({ text: "look only", delivery: "prompt" });
    expect(sessions[0]?.setPermissionMode).toHaveBeenCalledWith("plan");
    expect(opened).toHaveLength(1);
  });
});
