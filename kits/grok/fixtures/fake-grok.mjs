#!/usr/bin/env node
// A stand-in `grok` CLI for tests and test instances: `--version`, `models`,
// and `agent stdio`, an ACP server over stdio shaped after what Grok Build's
// own client expects (models in initialize["_meta"], set_model with a reasoning
// effort, xAI's prompt_complete notification, ask_user_question and
// exit_plan_mode requests, turn_completed usage). Words in the prompt pick the
// scenario; sessions persist under GROK_HOME so a second process can load one.
// FAKE_GROK_LOG names a file that receives every message Tau sent.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const env = process.env;
const signedOut = Boolean(env.FAKE_GROK_SIGNED_OUT);
if (args.includes("--version")) {
  process.stdout.write(`grok ${env.FAKE_GROK_VERSION ?? "0.9.12"}\n`);
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write(signedOut
    ? "You are not logged in. Run `grok login`.\n"
    : "You are logged in with grok.com.\nDefault model: grok-4.6\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.6-fast\n");
  process.exit(0);
}
const agentAt = args.indexOf("agent");
if (agentAt < 0 || args.at(-1) !== "stdio") {
  process.stderr.write(`fake grok: unexpected arguments ${JSON.stringify(args)}\n`);
  process.exit(2);
}

const home = env.GROK_HOME || join(env.HOME ?? ".", ".grok");
const sessionsFile = join(home, "fake-sessions.json");
const readSessions = () => { try { return JSON.parse(readFileSync(sessionsFile, "utf8")); } catch { return {}; } };
const saveSession = (id, value) => { mkdirSync(home, { recursive: true }); writeFileSync(sessionsFile, JSON.stringify({ ...readSessions(), [id]: value })); };

const EFFORTS = [
  { id: "high", value: "high", label: "High Effort", default: true },
  { id: "low", value: "low", label: "Low Effort", default: false },
];
const state = { model: "grok-4.6", effort: "high", sessionId: undefined, mcpServers: [], history: [] };
const modelState = () => ({
  currentModelId: state.model,
  availableModels: [
    { modelId: "grok-4.6", name: "Grok 4.6", _meta: { totalContextTokens: 500000, supportsReasoningEffort: true, reasoningEffort: state.model === "grok-4.6" ? state.effort : "high", reasoningEfforts: EFFORTS } },
    { modelId: "grok-4.6-fast", name: "Grok 4.6 Fast", _meta: { totalContextTokens: 2000000, supportsReasoningEffort: false } },
  ],
});
const commands = [
  { name: "compact", description: "Summarize the conversation" },
  { name: "always-approve", description: "Approve everything" },
  { name: "context", description: "Show context usage" },
];

let nextId = 1000;
const pending = new Map();
const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const notify = (method, params) => write({ method, params });
const update = (value) => notify("session/update", { sessionId: state.sessionId, update: value });
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); write({ id, method, params }); });
const log = (message) => { if (env.FAKE_GROK_LOG) appendFileSync(env.FAKE_GROK_LOG, `${JSON.stringify(message)}\n`); };
let cancelled;
const NEVER = Symbol("never");

async function prompt(params) {
  const text = (params.prompt ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const promptId = params["_meta"]?.promptId;
  state.history.push({ role: "user", text });
  let reply = `pong from ${state.model}${state.model === "grok-4.6" ? ` (${state.effort})` : ""}`;
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about it." } });
  if (/\bpermission\b/u.test(text)) {
    update({ sessionUpdate: "tool_call", toolCallId: "shell-1", title: "run_terminal_command", kind: "execute", status: "pending", rawInput: { command: "echo hi" } });
    const answer = await ask("session/request_permission", { sessionId: state.sessionId, toolCall: { toolCallId: "shell-1", title: "Run `echo hi`", kind: "execute", rawInput: { command: "echo hi" } }, options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ] });
    const chosen = answer?.outcome?.optionId ?? answer?.outcome?.outcome ?? "none";
    const allowed = chosen.startsWith("allow");
    update({ sessionUpdate: "tool_call_update", toolCallId: "shell-1", status: allowed ? "completed" : "failed", rawOutput: allowed ? { stdout: "hi\n" } : "Rejected by the user." });
    reply = `permission ${chosen}`;
  }
  if (/\bquestion\b/u.test(text)) {
    const answer = await ask("_x.ai/ask_user_question", { method: "x.ai/ask_user_question", params: { sessionId: state.sessionId, toolCallId: "ask-1", mode: "default", questions: [
      { question: "Which scope?", options: [{ label: "Workspace" }, { label: "Session", preview: "Only this session" }] },
      { question: "Which extras?", multiSelect: true, options: [{ label: "Tests" }, { label: "Docs" }] },
    ] } });
    reply = `answers ${JSON.stringify(answer)}`;
  }
  if (/\bplan\b/u.test(text)) {
    const planFile = join(home, "sessions", "repo", state.sessionId, "plan.md");
    update({ sessionUpdate: "tool_call", toolCallId: "enter-1", title: "enter_plan_mode", kind: "other", status: "completed", rawInput: { variant: "EnterPlanMode" } });
    update({ sessionUpdate: "tool_call", toolCallId: "write-1", title: "write_file", kind: "edit", status: "completed", rawInput: { file_path: planFile, content: "# Tidy the tabs\n\n1. Read the tab code.\n2. Change the sizing." } });
    const answer = await ask("_x.ai/exit_plan_mode", { sessionId: state.sessionId, toolCallId: "exit-1", ...(env.FAKE_GROK_PLAN_CONTENT ? { planContent: env.FAKE_GROK_PLAN_CONTENT } : {}) });
    reply = `plan ${answer?.outcome ?? "?"}`;
  }
  if (/\btool\b/u.test(text)) {
    update({ sessionUpdate: "tool_call", toolCallId: "read-1", title: "read_file", kind: "read", status: "in_progress", rawInput: { path: "package.json" } });
    update({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "{ \"name\": \"demo\" }" } }] });
  }
  if (/\bmcp\b/u.test(text)) reply = `mcp ${state.mcpServers.map((server) => `${server.name}:${server.type ?? "stdio"}`).join(",") || "none"}`;
  if (/\bhistory\b/u.test(text)) reply = `history ${state.history.length}`;
  if (/\bargs\b/u.test(text)) reply = `args ${args.join(" ")}`;
  if (/\bsleep\b/u.test(text)) {
    await new Promise((resolve) => { cancelled = resolve; });
    cancelled = undefined;
    saveSession(state.sessionId, state.history);
    return { stopReason: "cancelled" };
  }
  if (/\bratelimit\b/u.test(text)) {
    notify("_x.ai/session/prompt_complete", { sessionId: state.sessionId, promptId, stopReason: "rate_limit", agentResult: null });
    return NEVER;
  }
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
  update({ sessionUpdate: "usage_update", used: 1200, size: 500000 });
  update({ sessionUpdate: "turn_completed", prompt_id: promptId, usage: { inputTokens: 1000, outputTokens: 20, cachedReadTokens: 400, cacheCreationTokens: 0, reasoningTokens: 5, costUsdTicks: 25_000_000 } });
  state.history.push({ role: "assistant", text: reply });
  saveSession(state.sessionId, state.history);
  // Grok sometimes answers a prompt only through its own notification.
  if (/\bsilent\b/u.test(text)) {
    notify("_x.ai/session/prompt_complete", { sessionId: state.sessionId, promptId, stopReason: "end_turn", agentResult: null });
    return NEVER;
  }
  return { stopReason: "end_turn", _meta: { promptId } };
}

const handlers = {
  initialize: () => ({
    protocolVersion: 1,
    agentInfo: { name: "grok", version: env.FAKE_GROK_VERSION ?? "0.9.12" },
    authMethods: [{ id: "cached_token", name: "Grok login" }, { id: "xai.api_key", name: "xAI API key" }],
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, promptCapabilities: { image: true, embeddedContext: false } },
    _meta: { modelState: modelState(), availableCommands: commands },
  }),
  authenticate: (params) => {
    if (params?.methodId === "xai.api_key" && !env.XAI_API_KEY) throw Object.assign(new Error("XAI_API_KEY is not set."), { code: -32000 });
    if (params?.methodId === "cached_token" && signedOut) throw Object.assign(new Error("Not authenticated: run grok login."), { code: -32000 });
    return {};
  },
  "session/new": (params) => {
    state.sessionId = `fake-${Date.now().toString(36)}`;
    state.mcpServers = params?.mcpServers ?? [];
    state.history = [];
    saveSession(state.sessionId, []);
    update({ sessionUpdate: "available_commands_update", availableCommands: commands });
    return { sessionId: state.sessionId, models: modelState() };
  },
  "session/load": (params) => {
    const stored = readSessions()[params?.sessionId];
    if (!stored) throw Object.assign(new Error(`Session not found: ${params?.sessionId}`), { code: -32002 });
    state.sessionId = params.sessionId;
    state.mcpServers = params?.mcpServers ?? [];
    state.history = stored;
    for (const entry of stored) update({ sessionUpdate: entry.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: entry.text } });
    return { models: modelState() };
  },
  "session/set_model": (params) => {
    if (!modelState().availableModels.some((model) => model.modelId === params.modelId)) throw Object.assign(new Error(`Unknown model ${params.modelId}`), { code: -32602 });
    state.model = params.modelId;
    state.effort = typeof params["_meta"]?.reasoningEffort === "string" ? params["_meta"].reasoningEffort : "high";
    return {};
  },
  "session/prompt": prompt,
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
    const result = await handler(message.params);
    if (result !== NEVER) write({ id: message.id, result: result ?? {} });
  } catch (error) {
    write({ id: message.id, error: { code: error.code ?? -32603, message: error.message } });
  }
});
lines.on("close", () => process.exit(0));
