#!/usr/bin/env node
// A stand-in for `codex app-server` that replays the recorded comparison turn
// (turn-fixture.mjs) on every `turn/start`. Both apps drive it through their
// own Codex integration, so no model, account or network is involved.
// Env: COMPARE_TURN_FILE (required for turns), COMPARE_FAKE_CODEX_LOG (optional).
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

export const FAKE_CODEX_VERSION = "0.154.0";
const MODEL = "gpt-5.6-luna";

const log = (entry) => {
  if (!process.env.COMPARE_FAKE_CODEX_LOG) return;
  try { appendFileSync(process.env.COMPARE_FAKE_CODEX_LOG, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`); } catch { /* logging is best effort */ }
};

const model = {
  id: MODEL,
  model: MODEL,
  displayName: "GPT-5.6 Luna (replay)",
  description: "Replays the recorded comparison turn.",
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }],
  inputModalities: ["text"],
  supportsPersonality: false,
};

function threadInfo(threadId, cwd) {
  const now = Math.floor(Date.now() / 1000);
  return {
    thread: {
      id: threadId,
      sessionId: threadId,
      cliVersion: FAKE_CODEX_VERSION,
      createdAt: now,
      updatedAt: now,
      cwd,
      ephemeral: false,
      modelProvider: "openai",
      preview: "",
      source: "appServer",
      status: { type: "idle" },
      turns: [],
      path: null,
    },
    model: MODEL,
    modelProvider: "openai",
    cwd,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    reasoningEffort: "low",
  };
}

/** Codex's notifications for one neutral event list; pure, so tests can check it. */
export function codexNotifications(turn, { threadId, turnId, cwd = "/tmp" }) {
  const out = [];
  let text;
  const tools = new Map();
  const closeText = (at) => {
    if (!text) return;
    out.push({ at, method: "item/completed", params: { threadId, turnId, completedAtMs: 0, item: { type: "agentMessage", id: text.id, text: text.parts.join("") } } });
    text = undefined;
  };
  let reasoning;
  let failure = null;
  const closeReasoning = (at) => {
    if (!reasoning) return;
    out.push({ at, method: "item/completed", params: { threadId, turnId, completedAtMs: 0, item: { type: "reasoning", id: reasoning.id, summary: [reasoning.parts.join("")], content: [] } } });
    reasoning = undefined;
  };
  out.push({ at: 0, method: "turn/started", params: { threadId, turn: { id: turnId, items: [], status: "inProgress", error: null } } });
  let messageCount = 0;
  for (const event of turn.events) {
    if (event.kind === "text") {
      closeReasoning(event.at);
      if (!text) {
        text = { id: `msg-${++messageCount}`, parts: [] };
        out.push({ at: event.at, method: "item/started", params: { threadId, turnId, startedAtMs: 0, item: { type: "agentMessage", id: text.id, text: "" } } });
      }
      text.parts.push(event.delta);
      out.push({ at: event.at, method: "item/agentMessage/delta", params: { threadId, turnId, itemId: text.id, delta: event.delta } });
      continue;
    }
    closeText(event.at);
    if (event.kind === "thinking") {
      if (!reasoning || reasoning.id !== event.id) {
        closeReasoning(event.at);
        reasoning = { id: event.id, parts: [] };
        out.push({ at: event.at, method: "item/started", params: { threadId, turnId, startedAtMs: 0, item: { type: "reasoning", id: event.id, summary: [], content: [] } } });
      }
      reasoning.parts.push(event.delta);
      out.push({ at: event.at, method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, itemId: event.id, delta: event.delta, summaryIndex: 0 } });
      continue;
    }
    closeReasoning(event.at);
    if (event.kind === "error") {
      failure = { message: event.message, codexErrorInfo: null, additionalDetails: null };
      out.push({ at: event.at, method: "error", params: { threadId, turnId, error: failure, willRetry: false } });
      continue;
    }
    if (event.kind === "tool-start") {
      const item = { type: "commandExecution", id: event.id, command: event.command, cwd, commandActions: [], status: "inProgress", aggregatedOutput: null, processId: null };
      tools.set(event.id, { item, output: [] });
      out.push({ at: event.at, method: "item/started", params: { threadId, turnId, startedAtMs: 0, item } });
    } else if (event.kind === "tool-output") {
      tools.get(event.id).output.push(event.chunk);
      out.push({ at: event.at, method: "item/commandExecution/outputDelta", params: { threadId, turnId, itemId: event.id, delta: event.chunk } });
    } else if (event.kind === "tool-end") {
      const tool = tools.get(event.id);
      const item = { ...tool.item, status: "completed", aggregatedOutput: tool.output.join(""), exitCode: event.exitCode, durationMs: 100 };
      out.push({ at: event.at, method: "item/completed", params: { threadId, turnId, completedAtMs: 0, item } });
    }
  }
  closeText(turn.durationMs);
  closeReasoning(turn.durationMs);
  out.push({ at: turn.durationMs, method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], status: failure ? "failed" : "completed", error: failure } } });
  return out;
}

function main() {
  const args = process.argv.slice(2);
  log({ argv: args });
  if (args.includes("--version") || args[0] === "-V") {
    process.stdout.write(`codex-cli ${FAKE_CODEX_VERSION}\n`);
    return;
  }
  if (args[0] === "login" && args[1] === "status") {
    process.stdout.write("Logged in using an API key\n");
    return;
  }
  if (args[0] !== "app-server") {
    process.stderr.write(`fake codex: unsupported command ${args.join(" ")}\n`);
    process.exitCode = 2;
    return;
  }

  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const threads = new Map();
  const timers = new Set();
  let turnFile;
  const loadTurn = () => {
    turnFile ??= JSON.parse(readFileSync(process.env.COMPARE_TURN_FILE, "utf8"));
    return turnFile;
  };

  const play = (threadId, turnId, cwd) => {
    const started = Date.now();
    const schedule = codexNotifications(loadTurn(), { threadId, turnId, cwd });
    let index = 0;
    const step = () => {
      const now = Date.now() - started;
      while (index < schedule.length && schedule[index].at <= now) {
        const { method, params } = schedule[index++];
        const stamp = params.item ? (method === "item/started" ? { startedAtMs: Date.now() } : { completedAtMs: Date.now() }) : {};
        write({ method, params: { ...params, ...stamp } });
      }
      if (index < schedule.length) {
        const timer = setTimeout(() => { timers.delete(timer); step(); }, Math.max(0, schedule[index].at - (Date.now() - started)));
        timers.add(timer);
      } else {
        log({ event: "turn-done", threadId, turnId, ms: Date.now() - started, notifications: schedule.length });
      }
    };
    step();
  };

  const handlers = {
    initialize: () => ({ userAgent: `codex_cli_rs/${FAKE_CODEX_VERSION} (compare-harness)`, codexHome: process.env.CODEX_HOME ?? "/tmp", platformFamily: "unix", platformOs: "macos" }),
    "account/read": () => ({ account: { type: "apiKey" }, requiresOpenaiAuth: false }),
    "model/list": () => ({ data: [model], nextCursor: null }),
    "skills/list": (params) => ({ data: (params?.cwds ?? []).map((cwd) => ({ cwd, skills: [], errors: [] })) }),
    "thread/start": (params) => {
      const id = randomUUID();
      threads.set(id, params?.cwd ?? "/tmp");
      write({ method: "thread/started", params: { thread: threadInfo(id, params?.cwd ?? "/tmp").thread } });
      return threadInfo(id, params?.cwd ?? "/tmp");
    },
    "thread/resume": (params) => {
      threads.set(params.threadId, params?.cwd ?? "/tmp");
      return threadInfo(params.threadId, params?.cwd ?? "/tmp");
    },
    "turn/start": (params) => {
      const turnId = randomUUID();
      setImmediate(() => play(params.threadId, turnId, threads.get(params.threadId) ?? "/tmp"));
      return { turn: { id: turnId, items: [], status: "inProgress", error: null } };
    },
    "turn/interrupt": () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      return {};
    },
  };

  createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === undefined) return;
    log({ method: message.method, id: message.id ?? null });
    if (message.id === undefined) return;
    const handler = handlers[message.method];
    if (!handler) {
      write({ id: message.id, error: { code: -32601, message: `fake codex: ${message.method} is not recorded` } });
      return;
    }
    try {
      write({ id: message.id, result: handler(message.params) });
    } catch (error) {
      write({ id: message.id, error: { code: -32603, message: String(error?.message ?? error) } });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
