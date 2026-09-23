import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendPrompt, ExtensionUiAnswer, RuntimePermissionLevel, ThreadRuntimeEvent } from "tau/host-extension";
import { fakeAgent, until, type FakeAgent } from "../_acp/fake.js";
import { createGrokRuntimeAdapter } from "./runtime-adapter.js";
import { openGrokSession } from "./session.js";
import { GrokSessionStore } from "./session-store.js";
import { GrokThreadRuntimeBackend, PLAN_INSTRUCTIONS } from "./thread-backend.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function scratchStore(): Promise<GrokSessionStore> {
  const directory = await mkdtemp(join(tmpdir(), "tau-grok-backend-"));
  directories.push(directory);
  return new GrokSessionStore({ filePath: join(directory, "sessions.json") });
}

const EFFORTS = [{ id: "high", value: "high", default: true }, { id: "low", value: "low" }];
function models(current: string, effort: string) {
  return {
    currentModelId: current,
    availableModels: [
      { modelId: "grok-4.6", name: "Grok 4.6", _meta: { supportsReasoningEffort: true, reasoningEffort: current === "grok-4.6" ? effort : "high", reasoningEfforts: EFFORTS } },
      { modelId: "grok-4.6-fast", name: "Grok 4.6 Fast" },
    ],
  };
}

/** An in-process Grok agent: handshake, sessions and set_model; each test scripts `session/prompt`. */
function grokAgent(extras: { stored?: string[]; replay?: string } = {}): FakeAgent & { state: { model: string; effort: string } } {
  const agent = fakeAgent();
  const state = { model: "grok-4.6", effort: "high" };
  agent.respond("initialize", () => ({
    protocolVersion: 1,
    authMethods: [{ id: "cached_token", name: "Grok" }],
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, promptCapabilities: { image: true } },
    _meta: { availableCommands: [{ name: "compact", description: "Summarize" }, { name: "always-approve" }] },
  }));
  agent.respond("authenticate", () => ({}));
  agent.respond("session/new", () => ({ sessionId: "s-new", models: models(state.model, state.effort) }));
  agent.respond("session/load", (params) => {
    const id = (params as { sessionId: string }).sessionId;
    if (!extras.stored?.includes(id)) return { error: { code: -32002, message: `Session not found: ${id}` } };
    if (extras.replay) agent.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: extras.replay } } } });
    return { models: models(state.model, state.effort) };
  });
  agent.respond("session/set_model", (params) => {
    const { modelId, _meta } = params as { modelId: string; _meta?: { reasoningEffort?: string } };
    state.model = modelId;
    state.effort = _meta?.reasoningEffort ?? "high";
    return {};
  });
  return Object.assign(agent, { state });
}

const update = (agent: FakeAgent, value: object, sessionId = "s-new") => agent.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
const promptText = (params: unknown) => ((params as { prompt: Array<{ type: string; text?: string }> }).prompt).filter((block) => block.type === "text").map((block) => block.text).join("\n");

/** Sends a request as the agent and resolves with Tau's answer. */
async function agentAsks(agent: FakeAgent, id: number, method: string, params: object): Promise<Record<string, unknown>> {
  agent.send({ jsonrpc: "2.0", id, method, params });
  await until(() => agent.received.some((message) => message.id === id && message.method === undefined));
  const answer = agent.received.find((message) => message.id === id && message.method === undefined)!;
  return (answer.result ?? answer.error) as Record<string, unknown>;
}

function harness(store: GrokSessionStore, agents: FakeAgent[], settings: { level?: () => RuntimePermissionLevel; ask?: (prompt: BackendPrompt) => Promise<ExtensionUiAnswer>; grokHome?: string } = {}) {
  const events: ThreadRuntimeEvent[] = [];
  const spawned: string[][] = [];
  let opened = 0;
  const backend = new GrokThreadRuntimeBackend("thread", "/repo", {
    adapter: createGrokRuntimeAdapter(),
    store,
    billing: "subscription",
    ...(settings.grokHome ? { grokHome: settings.grokHome } : {}),
    openSession: (input) => {
      const agent = agents[opened++]!;
      spawned.push(input.agentArgs);
      return openGrokSession({ command: "grok", args: input.agentArgs, cwd: input.cwd, env: {}, clientVersion: "1.0.0", spawn: () => agent.process, onUpdate: input.onUpdate, onPermission: input.onPermission, onElicitation: input.onElicitation, onExit: input.onExit, timeouts: { cancelMs: 100 } });
    },
    storedModels: async () => [{ id: "grok-4.6", name: "Grok 4.6", efforts: ["high", "low"] }, { id: "grok-4.6-fast", name: "Grok 4.6 Fast", efforts: [] }],
    onEvent: (event) => events.push(event),
    ...(settings.ask ? { ask: settings.ask } : {}),
    permissionLevel: settings.level ?? (() => "full"),
    now: (() => { let clock = 1_000; return () => clock++; })(),
  });
  return { backend, events, spawned };
}

describe("GrokThreadRuntimeBackend", () => {
  it("creates a session on the first turn, sets model and effort, streams, and keeps each turn's usage", async () => {
    const agent = grokAgent();
    agent.respond("session/prompt", (params) => {
      update(agent, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } });
      update(agent, { sessionUpdate: "tool_call", toolCallId: "t1", title: "read_file", kind: "read", status: "in_progress", rawInput: { path: "a.ts" } });
      update(agent, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "text" });
      update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `pong ${agent.state.model} ${agent.state.effort}` } });
      update(agent, { sessionUpdate: "usage_update", used: 50, size: 1_000 });
      update(agent, { sessionUpdate: "turn_completed", prompt_id: (params as { _meta: { promptId: string } })["_meta"].promptId, usage: { inputTokens: 1000, outputTokens: 20, cachedReadTokens: 400, cacheCreationTokens: 0, costUsdTicks: 25_000_000 } });
      return { stopReason: "end_turn" };
    });
    const store = await scratchStore();
    const { backend, events, spawned } = harness(store, [agent]);
    await backend.start("create");
    await backend.capabilities.catalogWrite!.setThinkingLevel("low");
    const result = await backend.prompt({ text: "hello", delivery: "prompt" });
    expect(result.assistantText).toBe("pong grok-4.6 low");
    expect(spawned).toEqual([["agent", "--always-approve", "stdio"]]);
    expect(agent.received.find((message) => message.method === "session/set_model")?.params).toEqual({ sessionId: "s-new", modelId: "grok-4.6", _meta: { reasoningEffort: "low" } });
    expect(events.filter((event) => event.type === "tool-end")).toHaveLength(1);
    // Commands that would go around Tau are not offered.
    expect(backend.composerCommands()).toEqual([{ name: "compact", description: "Summarize", source: "prompt" }]);
    expect(backend.catalogView()).toMatchObject({
      model: { provider: "xai", id: "grok-4.6", name: "Grok 4.6" }, thinkingLevel: "low", thinkingLevels: ["default", "high", "low"],
      usage: { inputTokens: 600, cacheReadTokens: 400, outputTokens: 20, turns: 1, costUsd: 0.0025 }, contextUsage: { tokens: 50, contextWindow: 1_000 },
    });
    const record = await store.get("thread");
    expect(record).toMatchObject({ acpSessionId: "s-new", effort: "low", observedModel: "grok-4.6" });
    expect(record?.usageTurns).toEqual([{ provider: "xai", model: "grok-4.6", billing: "subscription", inputTokens: 600, outputTokens: 20, cacheReadTokens: 400, cacheWriteTokens: 0, totalTokens: 1020, costUsd: 0.0025, turns: 1, at: expect.any(Number) }]);

    // Same model and effort: nothing to set again. Another model goes without an effort it does not have.
    await backend.prompt({ text: "again", delivery: "prompt" });
    expect(agent.received.filter((message) => message.method === "session/set_model")).toHaveLength(1);
    await backend.capabilities.catalogWrite!.setModel("xai", "grok-4.6-fast");
    await backend.prompt({ text: "fast", delivery: "prompt" });
    expect(agent.received.filter((message) => message.method === "session/set_model").at(-1)?.params).toEqual({ sessionId: "s-new", modelId: "grok-4.6-fast" });
    expect((await store.get("thread"))?.effort).toBeUndefined();
    await backend.dispose();
  });

  it("loads the stored session after a restart without showing the replay, and starts anew when Grok lost it", async () => {
    const store = await scratchStore();
    await store.ensure("thread", "/repo");
    await store.setAcpSession("thread", "/repo", "s-old");
    const agent = grokAgent({ stored: ["s-old"], replay: "old answer" });
    agent.respond("session/prompt", (params) => {
      update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fresh" } }, (params as { sessionId: string }).sessionId);
      return { stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 1 } };
    });
    const { backend, events } = harness(store, [agent]);
    await backend.start("resume");
    expect(await backend.prompt({ text: "again", delivery: "prompt" })).toEqual({ assistantText: "fresh" });
    expect(agent.received.some((message) => message.method === "session/load")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("old answer");
    // No turn_completed: the prompt's own usage counts.
    expect((await store.get("thread"))?.usageTurns?.[0]).toMatchObject({ inputTokens: 7, outputTokens: 1, costUsd: 0 });
    await backend.dispose();

    const lost = grokAgent();
    lost.respond("session/prompt", () => ({ stopReason: "end_turn" }));
    await store.setAcpSession("thread", "/repo", "s-gone");
    const second = harness(store, [lost]);
    await second.backend.start("resume");
    await second.backend.prompt({ text: "once more", delivery: "prompt" });
    expect(second.events).toContainEqual({ type: "notice", message: "Grok no longer has this conversation; a new one starts here.", level: "warning" });
    expect((await store.get("thread"))?.acpSessionId).toBe("s-new");
    await second.backend.dispose();
  });

  it("answers permissions by access level: full allows, read-only rejects, ask shows the dialog", async () => {
    const request = { sessionId: "s-new", toolCall: { toolCallId: "sh", title: "Run `rm x`", kind: "execute", rawInput: { command: "rm x" } }, options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ] };
    const answers: unknown[] = [];
    const args: string[][] = [];
    for (const [level, id] of [["full", 7], ["read-only", 8], ["ask", 9]] as const) {
      const agent = grokAgent();
      agent.respond("session/prompt", async () => { answers.push((await agentAsks(agent, id, "session/request_permission", request)).outcome); return { stopReason: "end_turn" }; });
      const ask = vi.fn(async (): Promise<ExtensionUiAnswer> => ({ value: "Allow for this thread" }));
      const { backend, spawned } = harness(await scratchStore(), [agent], { level: () => level, ask });
      await backend.prompt({ text: "go", delivery: "prompt" });
      args.push(...spawned);
      if (level === "ask") expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: "Run `rm x`", message: "rm x", options: ["Allow", "Allow for this thread", "Deny"] }));
      else expect(ask).not.toHaveBeenCalled();
      await backend.dispose();
    }
    expect(answers).toEqual([
      { outcome: "selected", optionId: "allow-once" },
      { outcome: "selected", optionId: "reject-once" },
      { outcome: "selected", optionId: "allow-always" },
    ]);
    expect(args).toEqual([["agent", "--always-approve", "stdio"], ["--permission-mode", "default", "agent", "stdio"], ["--permission-mode", "default", "agent", "stdio"]]);
  });

  it("restarts the agent under new permissions and loads its session again", async () => {
    const first = grokAgent();
    first.respond("session/prompt", () => ({ stopReason: "end_turn" }));
    const second = grokAgent({ stored: ["s-new"] });
    second.respond("session/prompt", () => ({ stopReason: "end_turn" }));
    let level: RuntimePermissionLevel = "full";
    const { backend, spawned } = harness(await scratchStore(), [first, second], { level: () => level, ask: async () => ({ cancelled: true }) });
    await backend.prompt({ text: "one", delivery: "prompt" });
    level = "ask";
    await backend.prompt({ text: "two", delivery: "prompt" });
    expect(spawned).toEqual([["agent", "--always-approve", "stdio"], ["--permission-mode", "default", "agent", "stdio"]]);
    expect(second.received.find((message) => message.method === "session/load")?.params).toMatchObject({ sessionId: "s-new" });
    await backend.dispose();
  });

  it("pages Grok's questions and answers with labels", async () => {
    const agent = grokAgent();
    let answer: unknown;
    agent.respond("session/prompt", async () => {
      answer = await agentAsks(agent, 11, "_x.ai/ask_user_question", { method: "x.ai/ask_user_question", params: { sessionId: "s-new", toolCallId: "q", mode: "default", questions: [
        { question: "Which scope?", options: [{ label: "Workspace" }, { label: "Session" }] },
        { question: "Which extras?", multiSelect: true, options: [{ label: "Tests" }, { label: "Docs" }] },
      ] } });
      return { stopReason: "end_turn" };
    });
    const prompts: BackendPrompt[] = [];
    const ask = async (prompt: BackendPrompt): Promise<ExtensionUiAnswer> => { prompts.push(prompt); return { value: prompts.length === 1 ? "Session" : "2" }; };
    const { backend } = harness(await scratchStore(), [agent], { level: () => "ask", ask });
    await backend.prompt({ text: "ask me", delivery: "prompt" });
    expect(prompts.map((prompt) => prompt.kind)).toEqual(["select", "input"]);
    expect(answer).toEqual({ outcome: "accepted", answers: { "Which scope?": ["Session"], "Which extras?": ["Docs"] } });
    await backend.dispose();
  });

  it("plans read-only: the instruction goes with the prompt, the plan file becomes a plan card, Grok's own window is closed", async () => {
    const agent = grokAgent();
    let exit: unknown;
    let sent = "";
    agent.respond("session/prompt", async (params) => {
      sent = promptText(params);
      update(agent, { sessionUpdate: "tool_call", toolCallId: "w", title: "write_file", kind: "edit", status: "completed", rawInput: { file_path: "/shadow/sessions/repo/s-new/plan.md", content: "# Tidy tabs\n\n1. Read.\n2. Change." } });
      exit = await agentAsks(agent, 12, "_x.ai/exit_plan_mode", { sessionId: "s-new", toolCallId: "x" });
      return { stopReason: "end_turn" };
    });
    const { backend, events, spawned } = harness(await scratchStore(), [agent], { grokHome: "/shadow" });
    await backend.capabilities.mode!.set("plan");
    await backend.prompt({ text: "plan the tabs", delivery: "prompt" });
    expect(spawned).toEqual([["--permission-mode", "default", "agent", "stdio"]]);
    expect(sent).toBe(`plan the tabs\n${PLAN_INSTRUCTIONS}`);
    expect(exit).toMatchObject({ outcome: "abandoned" });
    expect(events.find((event) => event.type === "assistant-end")).toMatchObject({ message: { text: "<proposed_plan>\n# Tidy tabs\n\n1. Read.\n2. Change.\n</proposed_plan>" } });
    // The visible message is the user's own text.
    expect((await backend.transcript())[0]?.text).toBe("plan the tabs");
    await backend.dispose();
  });

  it("refuses /always-approve and fails a turn at the plan's limit", async () => {
    const agent = grokAgent();
    agent.respond("session/prompt", (params) => {
      agent.send({ jsonrpc: "2.0", method: "_x.ai/session/prompt_complete", params: { sessionId: "s-new", promptId: (params as { _meta: { promptId: string } })["_meta"].promptId, stopReason: "rate_limit" } });
      return new Promise(() => undefined);
    });
    const { backend, events } = harness(await scratchStore(), [agent]);
    await expect(backend.prompt({ text: "/always-approve", delivery: "prompt" })).rejects.toThrow(/access level/u);
    await expect(backend.prompt({ text: "hi", delivery: "prompt" })).rejects.toThrow(/usage limit/u);
    expect(events.find((event) => event.type === "turn-settled")).toMatchObject({ status: "error", error: "Grok usage limit reached. Try again later." });
    await backend.dispose();
  });

  it("stops the running turn for a steer and runs the steer next", async () => {
    const agent = grokAgent();
    let cancelled!: () => void;
    const stopped = new Promise<void>((resolve) => { cancelled = resolve; });
    let prompts = 0;
    agent.respond("session/prompt", async () => {
      prompts += 1;
      if (prompts === 1) { await stopped; return { stopReason: "cancelled" }; }
      update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "steered" } });
      return { stopReason: "end_turn" };
    });
    const { backend, events } = harness(await scratchStore(), [agent]);
    const first = backend.prompt({ text: "work long", delivery: "prompt" });
    await until(() => agent.received.some((message) => message.method === "session/prompt"));
    void until(() => agent.received.some((message) => message.method === "session/cancel")).then(cancelled);
    const steer = backend.prompt({ text: "do this instead", delivery: "steer" });
    await first;
    expect(await steer).toEqual({ assistantText: "steered" });
    expect(events.filter((event) => event.type === "turn-settled").map((event) => (event as { status: string }).status)).toEqual(["interrupted", "completed"]);
    await backend.dispose();
  });
});
