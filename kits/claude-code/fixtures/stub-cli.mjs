#!/usr/bin/env node
// A stand-in for the CLI the Agent SDK runtime drives, for its login only:
// `--version`, `auth status [--json|--text]`, `auth login [--claudeai|--console]`
// and `auth logout`, in the shapes the real CLI (2.1.280) prints. The login is
// a file in CLAUDE_CONFIG_DIR (or STUB_CLI_HOME); nothing reaches a network.
// STUB_CLI_LOG names a file every call is appended to.
//
// Driven by the Agent SDK (`--input-format stream-json`) it answers the SDK's
// control requests and plays one scripted turn per prompt, with no model: two
// Bash calls (the first fails), a Read the CLI refuses, then "Done.". A prompt
// with `wait <ms>` pauses that long before each step.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const home = process.env.CLAUDE_CONFIG_DIR ?? process.env.STUB_CLI_HOME ?? join(process.cwd(), ".stub-cli");
const file = join(home, "stub-login.json");
if (process.env.STUB_CLI_LOG) appendFileSync(process.env.STUB_CLI_LOG, `${JSON.stringify(args)}\n`);

function status() {
  const stored = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  if (stored) return { loggedIn: true, apiProvider: "firstParty", ...stored, configDirectory: home };
  if (process.env.ANTHROPIC_API_KEY) return { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", configDirectory: home, apiKeySource: "ANTHROPIC_API_KEY" };
  return { loggedIn: false, authMethod: "none", apiProvider: "firstParty", configDirectory: home };
}

function streamTurns() {
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const sessionId = flag("--resume") ?? flag("--session-id") ?? randomUUID();
  const model = "stub-1";
  const send = (frame) => process.stdout.write(`${JSON.stringify({ uuid: randomUUID(), session_id: sessionId, ...frame })}\n`);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const assistant = (content) => send({ type: "assistant", parent_tool_use_id: null, message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content, stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  const result = (id, content, isError = false) => send({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
  const account = { ...status(), tokenSource: "apiKey" };
  let turn = Promise.resolve();

  async function play(prompt) {
    const pause = Math.min(Number(/\bwait\s+(\d+)/u.exec(prompt)?.[1] ?? 150), 60_000);
    const step = async (write) => { await sleep(pause); write(); };
    const id = (n) => `toolu_stub_${randomUUID().slice(0, 8)}_${n}`;
    const [bash, echo, read] = [id(1), id(2), id(3)];
    send({ type: "system", subtype: "init", cwd: process.cwd(), model, claude_code_version: "2.1.280", apiKeySource: "ANTHROPIC_API_KEY", tools: ["Bash", "Read"], mcp_servers: [], permissionMode: "default", slash_commands: [], output_style: "default" });
    await step(() => assistant([{ type: "text", text: "Checking." }, { type: "tool_use", id: bash, name: "Bash", input: { command: "ls stub-missing-folder", description: "List a folder that is not there", timeout: 120000 } }]));
    await step(() => result(bash, "Exit code 1\nls: stub-missing-folder: No such file or directory", true));
    await step(() => assistant([{ type: "tool_use", id: echo, name: "Bash", input: { command: "echo stub-ok", description: "Say ok" } }]));
    await step(() => result(echo, [{ type: "text", text: "stub-ok" }]));
    await step(() => assistant([{ type: "tool_use", id: read, name: "Read", input: { file_path: join(process.cwd(), "stub-missing.ts") } }]));
    await step(() => result(read, "<tool_use_error>File does not exist.</tool_use_error>", true));
    await step(() => assistant([{ type: "text", text: "Done." }]));
    send({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Done.", duration_ms: pause * 7, duration_api_ms: 0, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {}, permission_denials: [] });
  }

  createInterface({ input: process.stdin }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type === "control_request") {
      const response = message.request?.subtype === "initialize"
        ? { commands: [], agents: [], output_style: "default", available_output_styles: ["default"], models: [{ value: model, displayName: "Stub 1", description: "Scripted by the stub CLI" }], account }
        : {};
      send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } });
    } else if (message.type === "user") {
      const content = message.message?.content;
      const prompt = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join(" ") : "";
      turn = turn.then(() => play(prompt));
    }
  }).on("close", () => { void turn.then(() => process.exit(0)); });
}

if (args.includes("--input-format")) {
  streamTurns();
} else if (args[0] === "--version") {
  process.stdout.write("2.1.280 (Claude Code)\n");
} else if (args[0] === "auth" && args[1] === "status") {
  const now = status();
  process.stdout.write(args.includes("--text") ? (now.loggedIn ? `Logged in as ${now.email ?? now.authMethod}\n` : "Not logged in. Run claude auth login to authenticate.\n") : `${JSON.stringify(now, null, 2)}\n`);
  process.exitCode = now.loggedIn ? 0 : 1;
} else if (args[0] === "auth" && args[1] === "login") {
  mkdirSync(home, { recursive: true });
  const login = args.includes("--console")
    ? { authMethod: "api_key", apiKeySource: "/login managed key", email: "stub@example.com", orgName: "Stub Org" }
    : { authMethod: "claude.ai", email: "stub@example.com", orgName: "Stub Org", subscriptionType: "max" };
  process.stdout.write("Opening the sign-in page… (stub: signed in at once)\n");
  writeFileSync(file, JSON.stringify(login));
  process.stdout.write("Login successful.\n");
} else if (args[0] === "auth" && args[1] === "logout") {
  rmSync(file, { force: true });
  process.stdout.write("Successfully logged out from your Anthropic account.\n");
} else {
  process.stderr.write(`stub-cli: ${args.join(" ")} is not stubbed\n`);
  process.exitCode = 2;
}
