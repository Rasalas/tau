// A stand-in for `codex app-server`: it answers the handshake, account, model
// and thread requests and replays turns recorded from codex-cli 0.154.0
// (app-server-frames.json). A prompt containing `[scenario:<name>]` picks the
// recording; `interrupt` stops at its approval and waits for `turn/interrupt`,
// `crash` exits mid-turn. `elicitation`, `permissions` and `question` are
// written from the protocol's schema (codex-cli 0.156.1), not recorded.
// `computeruse` exercises openai/form negotiation verified with 0.160.0.
// STUB_LOG names a file every client message is appended to; STUB_THREADS a
// file of thread ids that survive a restart. Logins are the protocol's own
// (codex-cli 0.156.1): a ChatGPT login or a device code is completed by
// visiting the local page the stub serves, an API key `sk-stub-good` is
// taken and any other refused; a `signed-out` file in CODEX_HOME is the state.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
let openaiForms = false;

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
  if (name === "native") {
    const child = "native-child";
    send({ method: "thread/started", params: { thread: { id: child, source: { subAgent: { thread_spawn: { parent_thread_id: ids.thread, agent_nickname: "Reviewer" } } } } } });
    send({ method: "item/agentMessage/delta", params: { threadId: child, turnId: "child-turn", itemId: "child-message", delta: "Child answer" } });
    send({ method: "turn/completed", params: { threadId: child, turn: { id: "child-turn", status: "completed" } } });
    name = "plain";
  }
  if (name === "computeruse") {
    // Codex only advertises openai/form to MCP servers after client opt-in.
    if (openaiForms) {
      const method = "mcpServer/elicitation/request";
      const answer = await ask(method, {
        threadId: ids.thread, turnId: ids.turn, serverName: "computer-use",
        mode: "openai/form", message: "Allow access to Tau Control Test?",
        requestedSchema: { type: "object", properties: {} },
        _meta: { codex_approval_kind: "mcp_tool_call" },
      });
      if (log) appendFileSync(log, `${JSON.stringify({ answered: method, result: answer })}\n`);
    }
    send({ method: "turn/completed", params: { threadId: ids.thread, turn: { id: ids.turn, items: [], status: "completed", error: null } } });
    return;
  }
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

const home = process.env.CODEX_HOME;
let signedOutHere = false;
const signedOut = () => home ? existsSync(join(home, "signed-out")) : signedOutHere;
const accountKind = () => home && existsSync(join(home, "stub-account")) ? readFileSync(join(home, "stub-account"), "utf8").trim() : "chatgpt";
function signIn(kind) {
  if (!home) { signedOutHere = false; return; }
  mkdirSync(home, { recursive: true });
  rmSync(join(home, "signed-out"), { force: true });
  writeFileSync(join(home, "stub-account"), kind);
}
function signOut() {
  if (!home) { signedOutHere = true; return; }
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "signed-out"), "");
}
function account() {
  if (signedOut()) return null;
  return accountKind() === "apiKey" ? { type: "apiKey" } : { type: "chatgpt", email: "stub@example.com", planType: "pro" };
}

/** One pending browser or device login: a page on 127.0.0.1 completes it. */
const logins = new Map();
async function startLogin(type) {
  const loginId = `login-${logins.size + 1}`;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path !== "/oauth/authorize" && path !== "/device") { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<p>Signed in to the stub. Return to Tau.</p>");
    finishLogin(loginId, true);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  logins.set(loginId, server);
  return type === "chatgpt"
    ? { type, loginId, authUrl: `${url}/oauth/authorize?state=${loginId}` }
    : { type, loginId, verificationUrl: `${url}/device`, userCode: "STUB-CODE" };
}
function finishLogin(loginId, success) {
  const server = logins.get(loginId);
  if (!server) return;
  logins.delete(loginId);
  server.close();
  if (success) signIn("chatgpt");
  send({ method: "account/login/completed", params: { loginId, success, error: success ? null : "Login was cancelled.", onboardingEntrypoint: null } });
  if (success) send({ method: "account/updated", params: { authMode: "chatgpt" } });
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
    case "initialize":
      openaiForms = params.capabilities?.mcpServerOpenaiFormElicitation === true || params.capabilities?.extensions?.["openai/form"] !== undefined;
      return send({ id, result: { userAgent: "stub", codexHome: process.env.CODEX_HOME ?? "/stub/.codex", platformFamily: "unix", platformOs: "macos" } });
    // A `signed-out` file in the home stands for a CLI nobody logged in to.
    case "account/read": return send({ id, result: { account: account(), requiresOpenaiAuth: true } });
    case "account/login/start":
      if (params.type === "apiKey") {
        if (params.apiKey !== "sk-stub-good") return send({ id, error: { code: -32600, message: "The API key was refused." } });
        signIn("apiKey");
        send({ id, result: { type: "apiKey" } });
        return send({ method: "account/login/completed", params: { loginId: null, success: true, error: null, onboardingEntrypoint: null } });
      }
      if (params.type !== "chatgpt" && params.type !== "chatgptDeviceCode") return send({ id, error: { code: -32602, message: `stub has no login ${params.type}` } });
      return send({ id, result: await startLogin(params.type) });
    case "account/login/cancel":
      if (!logins.has(params.loginId)) return send({ id, result: { status: "notFound" } });
      finishLogin(params.loginId, false);
      return send({ id, result: { status: "canceled" } });
    case "account/logout":
      signOut();
      return send({ id, result: {} });
    // Shaped like codex-cli 0.156's `GetAccountRateLimitsResponse`; the params are logged for the test.
    case "account/rateLimits/read":
      if (params.excludeResetCreditDetails !== false) return send({ id, error: { code: -32602, message: "Expected reset-credit details" } });
      return send({ id, result: JSON.parse(readFileSync(new URL("./rate-limits-read.json", import.meta.url), "utf8")) });
    case "account/rateLimitResetCredit/consume":
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(params.idempotencyKey)) return send({ id, error: { code: -32602, message: "Missing idempotency key" } });
      return send({ id, result: { outcome: "reset" } });
    case "model/list": return send({ id, result: { data: process.env.STUB_MODELS ? JSON.parse(readFileSync(process.env.STUB_MODELS, "utf8")) : fixture.models, nextCursor: null } });
    case "thread/settings/update": return send({ id, result: {} });
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
