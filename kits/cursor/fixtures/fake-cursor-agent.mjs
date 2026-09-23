#!/usr/bin/env node
// A stand-in `cursor-agent` for tests and test instances: `--version`,
// `about --format json`, `update`, and `acp`, an ACP server over stdio that
// speaks the methods Tau uses (cursor.com/docs/cli/acp). What the prompt text
// contains picks the scenario; sessions persist under CURSOR_DATA_DIR so a
// second process can load one. FAKE_CURSOR_LOG names a file that receives
// every message Tau sent, one JSON line each.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const env = process.env;
if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(`${env.FAKE_CURSOR_VERSION ?? "2026.09.18-fake000"}\n`);
  process.exit(0);
}
if (args[0] === "about") {
  const signedOut = Boolean(env.FAKE_CURSOR_SIGNED_OUT);
  process.stdout.write(`${JSON.stringify({ cliVersion: env.FAKE_CURSOR_VERSION ?? "2026.09.18-fake000", userEmail: signedOut ? null : "tester@example.invalid", subscriptionTier: "pro" })}\n`);
  process.exit(0);
}
if (args[0] === "update") {
  process.stdout.write("Cursor Agent is up to date.\n");
  process.exit(0);
}
if (args.at(-1) !== "acp") {
  process.stderr.write(`fake cursor-agent: unexpected arguments ${JSON.stringify(args)}\n`);
  process.exit(2);
}

const dataDir = env.CURSOR_DATA_DIR || join(env.HOME ?? ".", ".fake-cursor");
const sessionsFile = join(dataDir, "fake-sessions.json");
const readSessions = () => { try { return JSON.parse(readFileSync(sessionsFile, "utf8")); } catch { return {}; } };
const saveSession = (id, value) => { mkdirSync(dataDir, { recursive: true }); writeFileSync(sessionsFile, JSON.stringify({ ...readSessions(), [id]: value })); };

const MODELS = [
  { value: "default", name: "Auto" },
  { value: "composer-2", name: "Composer 2" },
  { value: "gpt-5.4", name: "GPT-5.4" },
];
const EFFORTS = [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }];
const MODES = [
  { id: "agent", name: "Agent", description: "Full tool access" },
  { id: "plan", name: "Plan", description: "Plan, read-only" },
  { id: "ask", name: "Ask", description: "Q&A, read-only" },
];
const state = { model: "default", effort: "medium", mode: "agent", sessionId: undefined, mcpServers: [], history: [] };

function modelOptions(model) {
  return model === "gpt-5.4" ? [{ type: "select", id: "reasoning", name: "Reasoning", category: "thought_level", currentValue: state.effort, options: EFFORTS }] : [];
}
const configOptions = () => [
  { type: "select", id: "model", name: "Model", category: "model", currentValue: state.model, options: MODELS },
  ...modelOptions(state.model),
];
const setup = () => ({ sessionId: state.sessionId, modes: { currentModeId: state.mode, availableModes: MODES }, configOptions: configOptions() });

let nextId = 1000;
const pending = new Map();
const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const notify = (method, params) => write({ method, params });
const update = (value) => notify("session/update", { sessionId: state.sessionId, update: value });
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); write({ id, method, params }); });
const log = (message) => { if (env.FAKE_CURSOR_LOG) appendFileSync(env.FAKE_CURSOR_LOG, `${JSON.stringify(message)}\n`); };
let cancelled;

async function prompt(params) {
  const text = (params.prompt ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const images = (params.prompt ?? []).filter((block) => block.type === "image").length;
  state.history.push({ role: "user", text });
  let reply = `pong from ${state.model}${state.model === "gpt-5.4" ? ` (${state.effort})` : ""} in ${state.mode} mode${images ? ` with ${images} image(s)` : ""}`;
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about it." } });
  if (/\bpermission\b/u.test(text)) {
    update({ sessionUpdate: "tool_call", toolCallId: "shell-1", title: "Run `echo hi`", kind: "execute", status: "pending", rawInput: { command: "echo hi" } });
    const answer = await ask("session/request_permission", { sessionId: state.sessionId, toolCall: { toolCallId: "shell-1", title: "Run `echo hi`", kind: "execute", rawInput: { command: "echo hi" } }, options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ] });
    const chosen = answer?.outcome?.optionId ?? answer?.outcome?.outcome ?? "none";
    const allowed = chosen.startsWith("allow");
    update({ sessionUpdate: "tool_call_update", toolCallId: "shell-1", status: allowed ? "completed" : "failed", rawOutput: allowed ? { stdout: "hi\n" } : "Rejected by the user." });
    reply = `permission ${chosen}`;
  }
  if (/\bquestion\b/u.test(text)) {
    const answer = await ask("cursor/ask_question", { toolCallId: "ask-1", title: "Scope", questions: [
      { id: "scope", prompt: "Which scope?", options: [{ id: "workspace", label: "Workspace" }, { id: "session", label: "Session" }] },
      { id: "extras", prompt: "Which extras?", allowMultiple: true, options: [{ id: "tests", label: "Tests" }, { id: "docs", label: "Docs" }] },
    ] });
    reply = `answers ${JSON.stringify(answer)}`;
  }
  if (/\bplan\b/u.test(text)) {
    const answer = await ask("cursor/create_plan", { toolCallId: "plan-1", name: "Tidy the tabs", overview: "Keep the layout.", plan: "1. Read the tab code.\n2. Change the sizing.", todos: [{ id: "1", content: "Read", status: "pending" }] });
    reply = `plan ${answer?.outcome?.outcome ?? "?"}`;
  }
  if (/\btodos\b/u.test(text)) {
    notify("cursor/update_todos", { toolCallId: "todo-1", merge: false, todos: [{ id: "1", content: "Read the code", status: "completed" }, { id: "2", content: "Write the fix", status: "in_progress" }] });
  }
  if (/\btool\b/u.test(text)) {
    update({ sessionUpdate: "tool_call", toolCallId: "read-1", title: "Read package.json", kind: "read", status: "in_progress", rawInput: { path: "package.json" } });
    update({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "{ \"name\": \"demo\" }" } }] });
  }
  if (/\bmcp\b/u.test(text)) reply = `mcp ${state.mcpServers.map((server) => `${server.name}:${server.type ?? "stdio"}`).join(",") || "none"}`;
  if (/\bhistory\b/u.test(text)) reply = `history ${state.history.length}`;
  if (/\btransport\b/u.test(text)) reply = "Error: ConnectError: [unavailable] upstream connect error";
  if (/\bsleep\b/u.test(text)) {
    await new Promise((resolve) => { cancelled = resolve; });
    cancelled = undefined;
    saveSession(state.sessionId, state.history);
    return { stopReason: "cancelled" };
  }
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
  update({ sessionUpdate: "usage_update", used: 1200, size: 200000 });
  state.history.push({ role: "assistant", text: reply });
  saveSession(state.sessionId, state.history);
  return { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
}

const handlers = {
  initialize: (params) => ({
    protocolVersion: 1,
    agentInfo: { name: "cursor-agent", version: env.FAKE_CURSOR_VERSION ?? "2026.09.18-fake000" },
    authMethods: [{ id: "cursor_login", name: "Cursor login" }],
    agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: false } },
    _meta: { echoedCapabilities: params?.clientCapabilities ?? null },
  }),
  authenticate: () => {
    if (env.FAKE_CURSOR_SIGNED_OUT) throw Object.assign(new Error("Authentication required: run agent login."), { code: -32000 });
    return {};
  },
  "session/new": (params) => {
    state.sessionId = `fake-${Date.now().toString(36)}`;
    state.mcpServers = params?.mcpServers ?? [];
    state.history = [];
    saveSession(state.sessionId, []);
    update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "compress", description: "Summarize the conversation" }] });
    return setup();
  },
  "session/load": (params) => {
    const stored = readSessions()[params?.sessionId];
    if (!stored) throw Object.assign(new Error(`Session not found: ${params?.sessionId}`), { code: -32002 });
    state.sessionId = params.sessionId;
    state.mcpServers = params?.mcpServers ?? [];
    state.history = stored;
    for (const entry of stored) update({ sessionUpdate: entry.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: entry.text } });
    return { modes: setup().modes, configOptions: configOptions() };
  },
  "session/set_mode": (params) => { state.mode = params.modeId; return {}; },
  "session/set_config_option": (params) => {
    if (params.configId === "model") state.model = params.value;
    else if (params.configId === "reasoning") state.effort = params.value;
    else if (params.configId === "mode") state.mode = params.value;
    return { configOptions: configOptions() };
  },
  "session/prompt": prompt,
  "cursor/list_available_models": () => ({ models: MODELS.map((model) => ({ ...model, configOptions: modelOptions(model.value) })) }),
};

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  log(message);
  if (message.method === undefined && pending.has(message.id)) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve(message.result ?? { error: message.error });
    return;
  }
  if (message.method === "session/cancel") { cancelled?.(); return; }
  if (message.id === undefined) return;
  const handler = handlers[message.method];
  if (!handler) { write({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } }); return; }
  try {
    write({ id: message.id, result: (await handler(message.params)) ?? {} });
  } catch (error) {
    write({ id: message.id, error: { code: error.code ?? -32603, message: error.message } });
  }
});
lines.on("close", () => process.exit(0));
