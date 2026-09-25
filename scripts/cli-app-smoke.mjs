// `tau app <path>` against a real headless host: the command line finds the
// host through `<userData>/host.json`, asks Workspace Kit to open a folder, and
// either an attached client gets the request or the request waits for the
// window the command line starts. Everything lives in temp folders; the app it
// would start is a stand-in script. Needs `npm run build` first.
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOST_ENTRY = join(ROOT, "dist-electron", "main", "headless.js");
const CLI = join(ROOT, "bin", "tau.mjs");

const guard = setTimeout(() => { console.error("✗ the smoke ran into its 120s guard"); process.exit(1); }, 120_000);
guard.unref();
const fail = (message) => { console.error(`✗ ${message}`); process.exit(1); };
const step = (name, detail = "") => console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(50);
  }
  fail(`timed out waiting for ${message}`);
}

if (!existsSync(HOST_ENTRY) || !existsSync(join(ROOT, "dist-kits", "manifest.json"))) fail("run `npm run build` first");

const temp = realpathSync(mkdtempSync(join(tmpdir(), "tau-cli-smoke-")));
const workspace = join(temp, "workspace");
const target = join(temp, "target");
const userData = join(temp, "userdata");
const home = join(temp, "home");
for (const folder of [workspace, target, userData, home]) execFileSync("mkdir", ["-p", folder]);
execFileSync("git", ["init", "-q", "-b", "main", workspace]);
execFileSync("git", ["init", "-q", "-b", "main", target]);
const tokenPath = join(temp, "host-token");
const launchedMarker = join(temp, "launched");
const standIn = join(temp, "tau-app");
writeFileSync(standIn, `#!/bin/sh\necho "\${TAU_USER_DATA}" > "${launchedMarker}"\n`);
chmodSync(standIn, 0o755);

const host = spawn(process.execPath, [HOST_ENTRY], {
  cwd: ROOT,
  env: {
    ...process.env,
    HOME: home,
    TAU_WORKSPACE: workspace,
    TAU_USER_DATA: userData,
    TAU_HOST_LISTEN: "127.0.0.1:0",
    TAU_HOST_TOKEN_FILE: tokenPath,
    TAU_WORKTREES_DIR: join(temp, "worktrees"),
    TAU_NO_WATCH: "1",
    TAU_NO_RUNTIME_UPDATES: "1",
    PI_CODING_AGENT_SESSION_DIR: join(temp, "pi-sessions"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let hostOutput = "";
host.stdout.on("data", (chunk) => { hostOutput += String(chunk); });
host.stderr.on("data", (chunk) => { hostOutput += String(chunk); });

/** A socket client that counts as a window: no `auxiliary` in its hello. */
async function attachClient(url, token) {
  const socket = new WebSocket(url);
  const pushes = [];
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === "push") { pushes.push(frame.push.event); return; }
    const id = frame.type === "response" ? frame.response.id : frame.id;
    const waiter = pending.get(id);
    pending.delete(id);
    if (frame.type === "response" && frame.response.error) waiter?.reject(new Error(frame.response.error.message));
    else waiter?.resolve(frame.type === "response" ? frame.response.result : frame.reply);
  });
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
  let counter = 0;
  const send = (frame, id) => new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify(frame)); });
  await send({ type: "hello", id: "hello", hello: { protocol: 1, token, profile: "desktop" } }, "hello");
  return {
    pushes,
    call: (extensionId, command, input) => {
      const id = `r${++counter}`;
      return send({ type: "request", request: { id, method: "host-extension", params: [extensionId, command, input] } }, id);
    },
    close: () => socket.close(),
  };
}

/** Asynchronous on purpose: a blocked smoke would stop draining the host's output pipe. */
async function cli(args) {
  const { stdout } = await promisify(execFile)(process.execPath, [CLI, ...args], {
    cwd: temp,
    env: { ...process.env, TAU_USER_DATA: userData, TAU_APP: standIn },
    encoding: "utf8",
  });
  return stdout.trim();
}

try {
  await waitFor(() => /listening on (ws:\/\/\S+)/u.test(hostOutput), "the host to listen");
  const url = hostOutput.match(/listening on (ws:\/\/\S+)/u)[1];
  // The window's supervisor writes this; here the smoke plays the supervisor.
  writeFileSync(join(userData, "host.json"), JSON.stringify({ pid: host.pid, url, tokenPath, startedAt: Date.now(), version: "smoke" }));
  const token = readFileSync(tokenPath, "utf8").trim();
  step("headless host", url);

  // Nothing bootstrapped this host yet, as after a start without a window:
  // the command line starts it itself.
  const alone = await cli(["app", "target"]);
  if (!/without a window/u.test(alone)) fail(`expected the command line to open a window, said: ${alone}`);
  await waitFor(() => existsSync(launchedMarker), "the stand-in app to start");
  if (readFileSync(launchedMarker, "utf8").trim() !== userData) fail("the app was not started with the instance's TAU_USER_DATA");
  const window = await attachClient(url, token);
  const waiting = await window.call("tau.workspace", "take-open-request");
  if (waiting?.displayPath !== target) fail(`the waiting request named ${JSON.stringify(waiting)}`);
  step("no window: the app starts and takes the waiting request", waiting.displayPath);

  const opened = await cli(["app", target]);
  if (opened !== `Opened ${target} in Tau.`) fail(`the command line said: ${opened}`);
  await waitFor(() => window.pushes.some((event) => event.type === "extension-event" && event.name === "open-request"), "the open request push");
  const pushed = window.pushes.find((event) => event.name === "open-request").payload;
  if (pushed.displayPath !== target || !pushed.workspaceId.startsWith("ws1_")) fail(`the push carried ${JSON.stringify(pushed)}`);
  step("a window attached: it gets the request", `${pushed.workspaceId} ${pushed.displayPath}`);
  window.close();

  const refused = await cli(["app", join(temp, "missing")]).then(() => undefined, (error) => String(error.stderr));
  if (!refused?.includes("is not a folder")) fail(`a missing folder was not refused: ${refused}`);
  step("a missing folder is refused");
  console.log("\ncli app smoke passed");
} finally {
  host.kill("SIGTERM");
  await wait(300);
  if (host.exitCode === null) host.kill("SIGKILL");
  await rm(temp, { recursive: true, force: true });
}
