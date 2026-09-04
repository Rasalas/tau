// Drives a headless Tau host over the socket transport: hello, bootstrap, a
// prompt, a disconnect, and a reconnect that replays the pushes missed in
// between. Node 22 has WebSocket globally, so the client here is plain Node.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOST_ENTRY = join(ROOT, "dist-electron", "main", "headless.js");
const PROTOCOL = 1;
const steps = [];

// Nothing here should take minutes; a hang is a failure, not a wait.
const guard = setTimeout(() => {
  console.error("✗ the smoke ran into its 120s guard");
  process.exit(1);
}, 120_000);
guard.unref();

function step(name, detail = "") {
  steps.push(name);
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** A minimal protocol client: one socket, hello, requests by id, pushes by seq. */
function createClient(url, token) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const pushes = [];
  let counter = 0;
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)));
  });
  socket.addEventListener("close", () => {
    // A refused hello is answered by a close, so nothing may stay pending.
    for (const waiter of pending.values()) waiter.reject(new Error("the host closed the connection"));
    pending.clear();
  });
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data);
    if (frame.type === "push") { pushes.push(frame.push); return; }
    const id = frame.type === "response" ? frame.response.id : frame.id;
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    if (frame.type === "hello-reply") waiter.resolve(frame.reply);
    else if (frame.response.error) waiter.reject(new Error(`${frame.response.error.code}: ${frame.response.error.message}`));
    else waiter.resolve(frame.response.result);
  });
  const send = (frame, id) => new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify(frame));
  });
  return {
    pushes,
    opened,
    hello: (lastSeq) => {
      const id = `h${++counter}`;
      return send({ type: "hello", id, hello: { protocol: PROTOCOL, token, ...(lastSeq === undefined ? {} : { lastSeq }) } }, id);
    },
    request: (method, params = []) => {
      const id = `r${++counter}`;
      return send({ type: "request", request: { id, method, params } }, id);
    },
    close: () => new Promise((resolve) => {
      socket.addEventListener("close", () => resolve());
      socket.close();
    }),
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(50);
  }
  fail(`timed out waiting for ${message}`);
}

if (!existsSync(HOST_ENTRY)) {
  console.log("Building the host entry (tsc -p tsconfig.electron.json)…");
  execFileSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.electron.json"], { cwd: ROOT, stdio: "inherit" });
}

const workspace = await mkdtemp(join(tmpdir(), "tau-remote-smoke-"));
const userData = mkdtempSync(join(tmpdir(), "tau-remote-userdata-"));
const tokenHome = mkdtempSync(join(tmpdir(), "tau-remote-home-"));
execFileSync("git", ["init", "-b", "main", workspace], { stdio: "ignore" });
writeFileSync(join(workspace, "README.md"), "# remote host smoke\n");

const host = spawn(process.execPath, [HOST_ENTRY], {
  cwd: ROOT,
  env: {
    ...process.env,
    HOME: tokenHome,
    TAU_WORKSPACE: workspace,
    TAU_USER_DATA: userData,
    TAU_HOST_LISTEN: "127.0.0.1:0",
    TAU_NO_EXTENSIONS: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let hostOutput = "";
host.stdout.on("data", (chunk) => { hostOutput += String(chunk); });
host.stderr.on("data", (chunk) => { hostOutput += String(chunk); });
host.on("exit", (code) => { if (code !== 0 && code !== null) fail(`the host exited with ${code}\n${hostOutput}`); });

try {
  await waitFor(() => /listening on (ws:\/\/\S+)/u.test(hostOutput), "the host to listen");
  const url = hostOutput.match(/listening on (ws:\/\/\S+)/u)[1];
  const token = execFileSync("cat", [join(tokenHome, ".tau", "host-token")], { encoding: "utf8" }).trim();
  step("host started headless", url);

  const rejected = createClient(url, "wrong-token");
  await rejected.opened;
  const refusal = await rejected.hello().then(() => "accepted", () => "closed");
  if (refusal !== "closed") fail("a wrong token was accepted");
  step("a wrong token is refused");

  const client = createClient(url, token);
  await client.opened;
  const hello = await client.hello();
  if (hello.protocol !== PROTOCOL) fail(`unexpected protocol ${hello.protocol}`);
  step("hello", `protocol ${hello.protocol}, capabilities ${hello.capabilities.join(", ")}`);

  const bootstrap = await client.request("bootstrap");
  if (!bootstrap?.project?.cwd) fail("bootstrap carried no project");
  step("bootstrap", `cwd ${bootstrap.project.cwd}`);

  const extensions = await client.request("host-extensions");
  step("host-extensions", `${extensions.length} listed`);

  // Whether a model answers depends on credentials; the plumbing does not.
  await client.request("prompt", ["Say hello.", undefined, undefined, "smoke-1", undefined]).catch(() => undefined);
  await waitFor(() => client.pushes.length > 0, "a push after the prompt");
  step("send-prompt", `${client.pushes.length} push(es), last seq ${client.pushes.at(-1).seq}`);
  await client.request("abort", [undefined]).catch(() => undefined);

  const lastSeq = client.pushes.at(-1).seq;
  await client.close();
  step("disconnected", `at seq ${lastSeq}`);

  // Something happens while nobody is listening; the host keeps it for replay.
  const detached = createClient(url, token);
  await detached.opened;
  await detached.hello();
  await detached.request("rename-thread", ["Replayed while away"]).catch(() => undefined);
  await waitFor(() => detached.pushes.some((push) => push.seq > lastSeq), "a push while the first client is away");
  await detached.close();

  const resumed = createClient(url, token);
  await resumed.opened;
  const replay = await resumed.hello(lastSeq);
  if (replay.resync) fail("the host asked for a resync although the buffer still reached back");
  if (replay.missed.length === 0) fail("no missed pushes were replayed");
  const sequences = replay.missed.map((push) => push.seq);
  if (sequences[0] !== lastSeq + 1) fail(`replay started at ${sequences[0]} instead of ${lastSeq + 1}`);
  step("reconnected with lastSeq", `replayed ${sequences.length} push(es): ${sequences.join(", ")}`);

  // A client the buffer cannot repair (here: one past the host's sequence)
  // is told to refetch instead of being handed a hole.
  const stale = await resumed.hello(10_000);
  if (!stale.resync) fail("a client outside the replay window should be told to resync");
  step("resync path", `resync: true, nextSeq ${stale.nextSeq}`);
  await resumed.close();

  console.log(`\nremote host smoke passed: ${steps.length} steps`);
} finally {
  host.kill("SIGTERM");
  await wait(200);
  host.kill("SIGKILL");
  await rm(workspace, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
  await rm(tokenHome, { recursive: true, force: true });
}
