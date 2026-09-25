import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendPrompt, ExtensionUiAnswer, HostExecutionPolicy, RuntimePermissionLevel, ThreadRuntimeEvent } from "tau/host-extension";
import { fakeAgent, until, type FakeAgent } from "../_acp/fake.js";
import { createCursorRuntimeAdapter } from "./runtime-adapter.js";
import { openCursorSession } from "./session.js";
import { CursorSessionStore } from "./session-store.js";
import { CursorThreadRuntimeBackend, cursorMode } from "./thread-backend.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function scratchStore(): Promise<CursorSessionStore> {
  const directory = await mkdtemp(join(tmpdir(), "tau-cursor-backend-"));
  directories.push(directory);
  return new CursorSessionStore({ filePath: join(directory, "sessions.json") });
}

const MODES = { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }, { id: "ask", name: "Ask" }] };
function options(model: string, effort = "medium") {
  return [
    { type: "select", id: "model", name: "Model", category: "model", currentValue: model, options: [{ value: "default", name: "Auto" }, { value: "gpt-5.4", name: "GPT-5.4" }] },
    ...(model === "gpt-5.4" ? [{ type: "select", id: "reasoning", name: "Reasoning", category: "thought_level", currentValue: effort, options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] }] : []),
  ];
}

/** An in-process Cursor agent: handshake, sessions and settings; each test scripts `session/prompt`. */
function cursorAgent(extras: { stored?: string[]; replay?: string } = {}): FakeAgent & { state: { model: string; effort: string; mode: string } } {
  const agent = fakeAgent();
  const state = { model: "default", effort: "medium", mode: "agent" };
  agent.respond("initialize", () => ({ protocolVersion: 1, authMethods: [{ id: "cursor_login", name: "Cursor" }], agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } }));
  agent.respond("authenticate", () => ({}));
  agent.respond("session/new", () => {
    agent.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-new", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compress", description: "Summarize" }] } } });
    return { sessionId: "s-new", modes: MODES, configOptions: options(state.model) };
  });
  agent.respond("session/load", (params) => {
    const id = (params as { sessionId: string }).sessionId;
    if (!extras.stored?.includes(id)) return { error: { code: -32002, message: `Session not found: ${id}` } };
    if (extras.replay) agent.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: extras.replay } } } });
    return { modes: MODES, configOptions: options(state.model) };
  });
  agent.respond("session/set_mode", (params) => { state.mode = (params as { modeId: string }).modeId; return {}; });
  agent.respond("session/set_config_option", (params) => {
    const { configId, value } = params as { configId: string; value: string };
    if (configId === "model") state.model = value;
    if (configId === "reasoning") state.effort = value;
    return { configOptions: options(state.model, state.effort) };
  });
  return Object.assign(agent, { state });
}

const update = (agent: FakeAgent, value: object, sessionId = "s-new") => agent.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });

/** Sends a request as the agent and resolves with Tau's answer. */
async function agentAsks(agent: FakeAgent, id: number, method: string, params: object): Promise<Record<string, unknown>> {
  agent.send({ jsonrpc: "2.0", id, method, params });
  await until(() => agent.received.some((message) => message.id === id && message.method === undefined));
  const answer = agent.received.find((message) => message.id === id && message.method === undefined)!;
  return (answer.result ?? answer.error) as Record<string, unknown>;
}

function harness(store: CursorSessionStore, agents: FakeAgent[], settings: { level?: RuntimePermissionLevel; ask?: (prompt: BackendPrompt) => Promise<ExtensionUiAnswer>; policy?: () => Promise<HostExecutionPolicy> } = {}) {
  const events: ThreadRuntimeEvent[] = [];
  let opened = 0;
  const backend = new CursorThreadRuntimeBackend("thread", "/repo", {
    adapter: createCursorRuntimeAdapter(),
    store,
    openSession: (input) => {
      const agent = agents[opened++]!;
      return openCursorSession({ command: "cursor-agent", env: {}, clientVersion: "1.0.0", spawn: () => agent.process, ...input, timeouts: { cancelMs: 100 } });
    },
    storedModels: async () => [{ id: "default", name: "Auto", efforts: [] }, { id: "gpt-5.4", name: "GPT-5.4", efforts: ["low", "high"] }],
    onEvent: (event) => events.push(event),
    ...(settings.ask ? { ask: settings.ask } : {}),
    permissionLevel: () => settings.level ?? "full",
    ...(settings.policy ? { executionPolicy: settings.policy } : {}),
    now: (() => { let clock = 1_000; return () => clock++; })(),
  });
  return { backend, events };
}

describe("CursorThreadRuntimeBackend", () => {
  it("creates a session on the first turn, applies model, effort and mode, and streams text and tools", async () => {
    const agent = cursorAgent();
    agent.respond("session/prompt", () => {
      update(agent, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } });
      update(agent, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a.ts", kind: "read", status: "in_progress", rawInput: { path: "a.ts" } });
      update(agent, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "text" });
      update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `pong ${agent.state.model} ${agent.state.effort} ${agent.state.mode}` } });
      update(agent, { sessionUpdate: "usage_update", used: 50, size: 1_000 });
      return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } };
    });
    const store = await scratchStore();
    const { backend, events } = harness(store, [agent]);
    await backend.start("create");
    await backend.capabilities.catalogWrite!.setModel("cursor", "gpt-5.4");
    await backend.capabilities.catalogWrite!.setThinkingLevel("high");
    const result = await backend.prompt({ text: "hello", delivery: "prompt" });
    expect(result.assistantText).toBe("pong gpt-5.4 high agent");
    expect(events.filter((event) => event.type === "tool-end")).toHaveLength(1);
    expect(events.at(-2)).toMatchObject({ type: "turn-settled", status: "completed" });
    expect(backend.composerCommands()).toEqual([{ name: "compress", description: "Summarize", source: "prompt" }]);
    expect(backend.catalogView()).toMatchObject({ model: { provider: "cursor", id: "gpt-5.4", name: "GPT-5.4" }, thinkingLevel: "high", thinkingLevels: ["default", "low", "high"], usage: { inputTokens: 10, turns: 1 }, contextUsage: { tokens: 50, contextWindow: 1_000 } });
    const initialize = agent.received.find((message) => message.method === "initialize")!;
    expect(initialize.params).toMatchObject({ clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, _meta: { parameterizedModelPicker: true } } });
    const record = await store.get("thread");
    expect(record).toMatchObject({ acpSessionId: "s-new", model: "gpt-5.4", effort: "high", observedModel: "gpt-5.4" });
    expect(record?.messages.filter((message) => message.text).map((message) => `${message.role}: ${message.text}`)).toEqual(["user: hello", "assistant: pong gpt-5.4 high agent"]);
    await backend.dispose();
  });

  it("loads the stored session after a restart without showing the replay, and starts anew when Cursor lost it", async () => {
    const store = await scratchStore();
    await store.ensure("thread", "/repo");
    await store.setAcpSession("thread", "/repo", "s-old");
    const agent = cursorAgent({ stored: ["s-old"], replay: "old answer" });
    agent.respond("session/prompt", (params) => {
      update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fresh" } }, (params as { sessionId: string }).sessionId);
      return { stopReason: "end_turn" };
    });
    const { backend, events } = harness(store, [agent]);
    await backend.start("resume");
    expect(await backend.prompt({ text: "again", delivery: "prompt" })).toEqual({ assistantText: "fresh" });
    expect(agent.received.some((message) => message.method === "session/load")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("old answer");
    await backend.dispose();

    const lost = cursorAgent();
    lost.respond("session/prompt", () => ({ stopReason: "end_turn" }));
    await store.setAcpSession("thread", "/repo", "s-gone");
    const second = harness(store, [lost]);
    await second.backend.start("resume");
    await second.backend.prompt({ text: "once more", delivery: "prompt" });
    expect(second.events).toContainEqual({ type: "notice", message: "Cursor no longer has this conversation; a new one starts here.", level: "warning" });
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
    for (const [level, id] of [["full", 7], ["read-only", 8], ["ask", 9]] as const) {
      const agent = cursorAgent();
      agent.respond("session/prompt", async () => { answers.push((await agentAsks(agent, id, "session/request_permission", request)).outcome); return { stopReason: "end_turn" }; });
      const ask = vi.fn(async (): Promise<ExtensionUiAnswer> => ({ value: "Allow for this thread" }));
      const { backend } = harness(await scratchStore(), [agent], { level, ask });
      await backend.prompt({ text: "go", delivery: "prompt" });
      if (level === "ask") expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: "Run `rm x`", message: "rm x", options: ["Allow", "Allow for this thread", "Deny"] }));
      else expect(ask).not.toHaveBeenCalled();
      expect(agent.state.mode).toBe(level === "read-only" ? "ask" : "agent");
      await backend.dispose();
    }
    expect(answers).toEqual([
      { outcome: "selected", optionId: "allow-once" },
      { outcome: "selected", optionId: "reject-once" },
      { outcome: "selected", optionId: "allow-always" },
    ]);
  });

  it("pages Cursor's questions and answers with option ids", async () => {
    const agent = cursorAgent();
    let answer: unknown;
    agent.respond("session/prompt", async () => {
      answer = await agentAsks(agent, 11, "cursor/ask_question", { toolCallId: "q", title: "Scope", questions: [
        { id: "scope", prompt: "Which scope?", options: [{ id: "ws", label: "Workspace" }, { id: "se", label: "Session" }] },
        { id: "extras", prompt: "Which extras?", allowMultiple: true, options: [{ id: "tests", label: "Tests" }, { id: "docs", label: "Docs" }] },
      ] });
      return { stopReason: "end_turn" };
    });
    const prompts: BackendPrompt[] = [];
    const ask = async (prompt: BackendPrompt): Promise<ExtensionUiAnswer> => { prompts.push(prompt); return { value: prompts.length === 1 ? "Session" : "1,2" }; };
    const { backend } = harness(await scratchStore(), [agent], { level: "ask", ask });
    await backend.prompt({ text: "ask me", delivery: "prompt" });
    expect(prompts.map((prompt) => prompt.kind)).toEqual(["select", "input"]);
    expect(prompts[0]!.extras?.["tau.questionnaire"]).toMatchObject({ index: 0, questions: [{ question: "Which scope?", multiSelect: false }, { question: "Which extras?", multiSelect: true }] });
    expect(answer).toEqual({ outcome: { outcome: "answered", answers: [{ questionId: "scope", selectedOptionIds: ["se"] }, { questionId: "extras", selectedOptionIds: ["tests", "docs"] }] } });
    await backend.dispose();
  });

  it("shows a created plan as a plan card and the to-do list as a tool card", async () => {
    const agent = cursorAgent();
    let accepted: unknown;
    agent.respond("session/prompt", async () => {
      accepted = await agentAsks(agent, 12, "cursor/create_plan", { toolCallId: "p", name: "Tidy tabs", overview: "Keep the layout.", plan: "1. Read.\n2. Change.", todos: [] });
      agent.send({ jsonrpc: "2.0", method: "cursor/update_todos", params: { toolCallId: "td", merge: false, todos: [{ id: "1", content: "Read", status: "completed" }, { id: "2", content: "Change", status: "pending" }] } });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { stopReason: "end_turn" };
    });
    const { backend, events } = harness(await scratchStore(), [agent]);
    await backend.capabilities.mode!.set("plan");
    await backend.prompt({ text: "plan it", delivery: "prompt" });
    expect(agent.state.mode).toBe("plan");
    expect(accepted).toEqual({ outcome: { outcome: "accepted" } });
    const plan = events.find((event) => event.type === "assistant-end");
    expect(plan).toMatchObject({ message: { text: "<proposed_plan>\n# Tidy tabs\n\nKeep the layout.\n\n1. Read.\n2. Change.\n</proposed_plan>" } });
    expect(events.find((event) => event.type === "tool-end")).toMatchObject({ tool: { name: "Update todos", status: "done", output: "- [x] Read\n- [ ] Change" } });
    await backend.dispose();
  });

  it("fails a turn whose only reply is Cursor's transport diagnostic", async () => {
    const agent = cursorAgent();
    agent.respond("session/prompt", () => {
      update(agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Error: ConnectError: [unavailable] upstream" } });
      return { stopReason: "end_turn" };
    });
    const { backend, events } = harness(await scratchStore(), [agent]);
    await backend.prompt({ text: "hi", delivery: "prompt" });
    expect(events.find((event) => event.type === "turn-settled")).toEqual({ type: "turn-settled", status: "error", error: "Cursor could not reach its server: Error: ConnectError: [unavailable] upstream" });
    await backend.dispose();
  });

  it("stops the running turn for a steer and runs the steer next", async () => {
    const agent = cursorAgent();
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

  it("refuses a prompt in a project that limits its network, before Cursor starts", async () => {
    const policy: HostExecutionPolicy = { network: "loopback", allowHosts: [], reasons: ["This project deploys to a server."], sources: ["tau.servers"] };
    const { backend } = harness(await scratchStore(), [], { policy: async () => policy });
    await backend.start("create");
    await expect(backend.prompt({ text: "hi", delivery: "prompt" })).rejects.toThrow("This project deploys to a server. Cursor cannot enforce that limit, so it does not run here.");
    expect(await backend.transcript()).toEqual([]);
  });

  it("maps thread mode and access level onto Cursor's modes", () => {
    const modes = [{ value: "agent", name: "Agent" }, { value: "plan", name: "Plan" }, { value: "ask", name: "Ask" }];
    expect(cursorMode("plan", "full", modes)).toBe("plan");
    expect(cursorMode("default", "read-only", modes)).toBe("ask");
    expect(cursorMode("default", "ask", modes)).toBe("agent");
    expect(cursorMode("default", "full", [{ value: "code", name: "Code" }])).toBe("code");
  });
});
