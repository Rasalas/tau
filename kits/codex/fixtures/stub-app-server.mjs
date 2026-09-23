// A stand-in for `codex app-server`: it answers the handshake, account, model
// and thread requests and replays turns recorded from codex-cli 0.154.0
// (app-server-frames.json). A prompt containing `[scenario:<name>]` picks the
// recording; `interrupt` stops at its approval and waits for `turn/interrupt`,
// `crash` exits mid-turn. `elicitation`, `permissions` and `question` are
// written from the protocol's schema (codex-cli 0.156.1), not recorded.
// STUB_LOG names a file every client message is appended to; STUB_THREADS a
// file of thread ids that survive a restart.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app-server-frames.json"), "utf8"));
const log = process.env.STUB_LOG;
const threadsFile = process.env.STUB_THREADS;
const threads = new Set(threadsFile && existsSync(threadsFile) ? JSON.parse(readFileSync(threadsFile, "utf8")) : []);
const pending = new Map();
let nextRequest = 0;
let turns = 0;
let waiting;
let interrupted = false;

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function remember(id) {
  threads.add(id);
  if (threadsFile) writeFileSync(threadsFile, JSON.stringify([...threads]));
}
function ask(method, params) {
  const id = nextRequest++;
  send({ method, id, params });
  return new Promise((resolve) => pending.set(id, resolve));
}
function fill(value, ids) {
  return JSON.parse(JSON.stringify(value).replaceAll("{thread}", ids.thread).replaceAll("{turn}", ids.turn).replaceAll("{cwd}", ids.cwd));
}
function threadInfo(id, cwd) {
  return { thread: { id, path: null, cwd, cliVersion: "0.154.0" }, model: "gpt-5.6-luna", modelProvider: "openai", cwd, reasoningEffort: "low", approvalPolicy: "never", sandbox: { type: "dangerFullAccess" } };
}

async function play(name, ids) {
  for (const frame of fill(fixture.scenarios[name], ids)) {
    if (frame.id !== undefined) {
      const answer = await ask(frame.method, frame.params);
      if (log) appendFileSync(log, `${JSON.stringify({ answered: frame.method, result: answer })}\n`);
      continue;
    }
    send(frame);
  }
  if (name === "interrupt") {
    if (!interrupted) await new Promise((resolve) => { waiting = resolve; });
    interrupted = false;
    send({ method: "turn/completed", params: { threadId: ids.thread, turn: { id: ids.turn, items: [], status: "interrupted", error: null } } });
  }
}

const cwds = new Map();
async function handle(message) {
  if (log) appendFileSync(log, `${JSON.stringify(message)}\n`);
  if (message.method === undefined && pending.has(message.id)) {
    pending.get(message.id)(message.result ?? message.error);
    pending.delete(message.id);
    return;
  }
  const { id, method, params = {} } = message;
  if (id === undefined) return;
  switch (method) {
    case "initialize": return send({ id, result: { userAgent: "stub", codexHome: process.env.CODEX_HOME ?? "/stub/.codex", platformFamily: "unix", platformOs: "macos" } });
    // A `signed-out` file in the home stands for a CLI nobody logged in to.
    case "account/read": return send({ id, result: { account: process.env.CODEX_HOME && existsSync(join(process.env.CODEX_HOME, "signed-out")) ? null : { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: true } });
    // Shaped like codex-cli 0.156's `GetAccountRateLimitsResponse`; the params are logged for the test.
    case "account/rateLimits/read": return send({ id, result: JSON.parse(readFileSync(new URL("./rate-limits-read.json", import.meta.url), "utf8")) });
    case "model/list": return send({ id, result: { data: fixture.models, nextCursor: null } });
    case "thread/start": {
      const thread = `thread-${process.pid}-${threads.size + 1}`;
      remember(thread);
      cwds.set(thread, params.cwd);
      return send({ id, result: threadInfo(thread, params.cwd) });
    }
    case "thread/resume":
      if (!threads.has(params.threadId)) return send({ id, error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` } });
      cwds.set(params.threadId, params.cwd);
      return send({ id, result: threadInfo(params.threadId, params.cwd) });
    case "turn/start": {
      const turn = `turn-${++turns}`;
      const text = params.input?.find((input) => input.type === "text")?.text ?? "";
      const name = /\[scenario:(\w+)\]/u.exec(text)?.[1] ?? "plain";
      send({ id, result: { turn: { id: turn, items: [], status: "inProgress", error: null } } });
      if (name === "crash") { process.stderr.write("stub: gone\n"); process.exit(3); }
      void play(name, { thread: params.threadId, turn, cwd: cwds.get(params.threadId) ?? "/" });
      return;
    }
    case "turn/steer": return send({ id, result: { turnId: params.expectedTurnId } });
    case "turn/interrupt":
      send({ id, result: {} });
      interrupted = true;
      waiting?.();
      waiting = undefined;
      return;
    default:
      return send({ id, error: { code: -32601, message: `stub has no ${method}` } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => { if (line.trim()) void handle(JSON.parse(line)); }).on("close", () => process.exit(0));
