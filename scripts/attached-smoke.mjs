#!/usr/bin/env node
// Attached mode, end to end: a real `pi` TUI owns the session, Tau is only a
// client on its bridge socket, and the kits' prebuilt Pi halves do their work
// inside that process. Nothing here runs Tau's host.
//
// The session lives under `.tau-dev/`, never in the user's `~/.pi/agent/sessions`,
// and the prompt edits a file in a throwaway git repository, not in this checkout.
//
// Usage: node scripts/attached-smoke.mjs [--model <provider/id>] [--keep]
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH = join(ROOT, ".tau-dev", "attached-smoke");
const REPO = join(SCRATCH, "repo");
const SESSIONS = join(SCRATCH, "pi-sessions");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const DESCRIPTORS = join(AGENT_DIR, "tau-bridge", "sessions");
const PROTOCOL = 1;
const CHECKPOINT_ENTRY = "tau.turn-checkpoint.v1";
const TITLE_KIT = "tau.thread-titles";
const EXPECT = "/usr/bin/expect";

const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 || !process.argv[at + 1] ? fallback : process.argv[at + 1];
};
const MODEL = option("model", "openai-codex/gpt-5.6-luna");
const [PROVIDER, MODEL_ID] = [MODEL.slice(0, MODEL.indexOf("/")), MODEL.slice(MODEL.indexOf("/") + 1)];

const steps = [];
const step = (name, detail = "") => { steps.push(name); console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`); };
const fail = (message) => { console.error(`✗ ${message}`); process.exitCode = 1; throw new Error(message); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await wait(200);
  }
}

/**
 * A scratch repository that looks to Pi like any project with a
 * `.pi/extensions/`: the bridge is a real copy there, and the three folders its
 * relative imports and `piKitsRoot` reach are symlinks back into the checkout.
 */
async function prepareWorkspace() {
  if (!existsSync(join(ROOT, "dist-kits", "manifest.json"))) fail("dist-kits/ is missing — run `npm run build` first");
  if (!existsSync(EXPECT)) fail(`${EXPECT} is missing; the Pi TUI needs a pty and this script has no other way to open one`);
  await rm(SCRATCH, { recursive: true, force: true });
  await mkdir(join(REPO, ".pi", "extensions"), { recursive: true });
  await mkdir(SESSIONS, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", REPO], { stdio: "ignore" });
  await writeFile(join(REPO, "README.md"), "# attached smoke\n");
  execFileSync("git", ["-C", REPO, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=smoke@tau.test", "-c", "user.name=Attached Smoke", "-C", REPO, "commit", "-qm", "initial"], { stdio: "ignore" });
  await writeFile(join(REPO, ".pi", "extensions", "tau-session-bridge.ts"),
    await readFile(join(ROOT, ".pi", "extensions", "tau-session-bridge.ts"), "utf8"));
  for (const name of ["src", "node_modules", "dist-kits"]) await symlink(join(ROOT, name), join(REPO, name));
  await writeFile(join(REPO, ".git", "info", "exclude"), "src\nnode_modules\ndist-kits\n.pi\n");
  step("scratch workspace", REPO);
}

/** A newline-framed client of the Pi bridge: hello, commands by id, events. */
function bridgeClient(descriptor) {
  const socket = connect(descriptor.socketPath);
  const pending = new Map();
  const events = [];
  let buffer = "";
  let counter = 0;
  const opened = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      if (frame.type === "event") { events.push(frame.event); continue; }
      if (frame.type === "snapshot") continue;
      const waiter = pending.get(frame.id);
      if (!waiter) continue;
      pending.delete(frame.id);
      if (frame.type === "ready") waiter.resolve(frame.snapshot);
      else if (frame.ok) waiter.resolve(frame.result);
      else waiter.reject(new Error(frame.error));
    }
  });
  const send = (frame) => new Promise((resolve, reject) => {
    pending.set(frame.id, { resolve, reject });
    socket.write(`${JSON.stringify(frame)}\n`);
  });
  const envelope = () => ({
    protocolVersion: PROTOCOL, id: `c${++counter}`, epoch: descriptor.epoch, expectedSessionId: descriptor.sessionId,
  });
  return {
    opened,
    events,
    hello: () => send({ ...envelope(), type: "hello", token: descriptor.token }),
    command: (command) => send({ ...envelope(), type: "command", ...command }),
    close: () => socket.destroy(),
  };
}

/** Every entry of the session file the Pi process is writing. */
async function sessionEntries(file) {
  return (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

let pi;
let descriptor;
try {
  await prepareWorkspace();

  const startedAt = Date.now();
  // The TUI needs a pty, and macOS `script` needs one on its own stdin, which a
  // spawned script has not got. `expect` allocates the pty itself and then just
  // waits: nothing is ever typed into the terminal, the bridge socket drives it.
  const command = [join(ROOT, "node_modules", ".bin", "pi"), "--approve", "--model", MODEL].map((part) => `{${part}}`).join(" ");
  pi = spawn(EXPECT, ["-c", `set timeout -1; spawn -noecho ${command}; expect eof`], {
    cwd: REPO,
    env: { ...process.env, PI_CODING_AGENT_SESSION_DIR: SESSIONS, TERM: "xterm-256color" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let terminal = "";
  pi.stdout.on("data", (chunk) => { terminal += String(chunk); });
  pi.stderr.on("data", (chunk) => { terminal += String(chunk); });
  pi.on("exit", (code) => { if (descriptor === undefined) console.error(`pi exited early with ${code}`); });

  descriptor = await waitFor(async () => {
    for (const name of await readdir(DESCRIPTORS).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      const candidate = JSON.parse(await readFile(join(DESCRIPTORS, name), "utf8").catch(() => "null") || "null");
      if (candidate?.cwd === REPO && candidate.startedAt >= startedAt) return candidate;
    }
    return undefined;
  }, `the Pi bridge to announce itself (terminal so far: ${terminal.length} bytes)`, 60_000);
  step("pi TUI owns the session", `pid ${descriptor.pid}, session ${descriptor.sessionId}`);

  const client = bridgeClient(descriptor);
  await client.opened;
  const ready = await client.hello();
  if (ready.sessionId !== descriptor.sessionId) fail("the bridge answered for another session");
  step("attached over the bridge socket", "Tau is a client, not the owner");

  // Both kits' Pi halves are loaded from `dist-kits/<id>/pi.cjs`; the workspace
  // one answers a command only a loaded half can answer.
  const checkpointsBefore = await client.command({ command: "extension", extensionId: "tau.workspace", name: "checkpoints" });
  if (!Array.isArray(checkpointsBefore?.checkpoints)) fail("Workspace Kit's Pi half did not answer");
  step("Workspace Kit's Pi half answers", `restoreSupported: ${checkpointsBefore.restoreSupported}`);

  await client.command({
    command: "prompt",
    text: "Use the write tool to create a file hello.txt in the current directory whose only content is the word pong. Then stop; do not explain.",
    clientTurnId: "attached-smoke-1",
    clientMessageId: "attached-smoke-1",
  });
  step("prompt sent through the bridge", MODEL);

  await waitFor(() => client.events.some((event) => event.type === "agent_settled"), "the run to settle");
  const written = await readFile(join(REPO, "hello.txt"), "utf8").catch(() => undefined);
  if (written === undefined) fail("the model did not write hello.txt");
  step("the agent edited a file", `hello.txt: ${JSON.stringify(written.trim())}`);

  const checkpoint = await waitFor(async () => {
    const entries = await sessionEntries(descriptor.sessionFile);
    return entries.find((entry) => entry.customType === CHECKPOINT_ENTRY)?.data;
  }, "Workspace Kit's checkpoint entry in the session file", 60_000);
  step("checkpoint entry in the session file", `${CHECKPOINT_ENTRY}, before ${checkpoint.beforeSnapshotId}`);

  const title = await client.command({ command: "extension", extensionId: TITLE_KIT, name: "generate", input: { provider: PROVIDER, modelId: MODEL_ID, force: true } });
  if (!title?.title) fail("Thread Title Generator's Pi half returned no title");
  step("Thread Title Generator titled the thread", JSON.stringify(title.title));

  const named = await waitFor(async () => {
    const entries = await sessionEntries(descriptor.sessionFile);
    return entries.find((entry) => entry.type === "session_info" && entry.name === title.title);
  }, "the title in the session file", 20_000);
  step("the title is in the session file", `${named.type}: ${named.name}`);

  if (!descriptor.sessionFile.startsWith(SESSIONS)) fail(`the session was written outside ${SESSIONS}`);
  step("the session stayed under .tau-dev", descriptor.sessionFile);

  client.close();
  console.log(`\nattached smoke passed: ${steps.length} steps`);
} finally {
  // Only ever the process this script started: the descriptor names it.
  if (descriptor?.pid) { try { process.kill(descriptor.pid, "SIGTERM"); } catch { /* already gone */ } }
  await wait(500);
  pi?.kill("SIGTERM");
  await wait(200);
  pi?.kill("SIGKILL");
  if (!process.argv.includes("--keep")) await rm(SCRATCH, { recursive: true, force: true });
  else console.log(`kept ${SCRATCH}`);
}
