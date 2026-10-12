#!/usr/bin/env node
// Scripted SDK peer with real, detached shell work. No model or network.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("2.1.280 (Claude Code)\n"); process.exit(0); }
if (args[0] === "auth") { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" })); process.exit(0); }
const sdk = args.includes("--input-format");
const session = randomUUID();
const send = (frame) => process.stdout.write(`${JSON.stringify({ uuid: randomUUID(), session_id: session, ...frame })}\n`);
function startTree() {
  writeFileSync(process.env.TAU_PROCESS_FIXTURE_ROOT ?? join(process.cwd(), "stub-process-root"), String(process.pid));
  spawn("/bin/sh", ["-c", 'trap "" TERM; sleep 60 & echo "$$ $!" > "$1"; wait', "fixture", process.env.TAU_PROCESS_FIXTURE_PIDS ?? join(process.cwd(), "stub-process-pids")], { detached: true, stdio: "ignore" });
  if (process.env.TAU_PROCESS_FIXTURE_NOISY === "1") setInterval(() => {
    process.stdout.write("fixture output\n".repeat(100));
    process.stderr.write("fixture stderr\n".repeat(100));
  }, 1);
}
if (!sdk) startTree();
createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.type === "control_request") {
    // Deliberately acknowledge interrupt without settling the turn. Tau must
    // close this unresponsive session after its interrupt grace period.
    send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: { commands: [], models: [{ value: "stub-process", displayName: "Process fixture" }], account: { tokenSource: "apiKey" } } } });
  } else if (frame.type === "user") {
    startTree();
    send({ type: "system", subtype: "init", model: "stub-process", tools: ["Bash"], mcp_servers: [], permissionMode: "bypassPermissions" });
    send({ type: "assistant", parent_tool_use_id: null, message: { id: randomUUID(), type: "message", role: "assistant", model: "stub-process", content: [{ type: "tool_use", id: "fixture-bash", name: "Bash", input: { command: "sleep 60", description: "Process lifecycle fixture" } }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  }
}).on("close", () => process.exit(0));
