// Drives the host as its own process, the way a window does (ADR 0021):
// start it, work in it, drop the client the way a closed window does, adopt
// the same host from a second supervisor, survive a kill, and stop it.
// No Electron and no model: what is under test is the process, not the UI.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAIN = join(ROOT, "dist-electron", "main");
const HOST_ENTRY = join(MAIN, "headless.js");
const PROTOCOL = 1;
const steps = [];

const guard = setTimeout(() => {
  console.error("✗ the smoke ran into its 180s guard");
  process.exit(1);
}, 180_000);
guard.unref();

function step(name, detail = "") {
  steps.push(name);
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(50);
  }
  fail(`timed out waiting for ${message}`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A client of the host, exactly as the window's renderer is one. */
function createClient(url, token) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let counter = 0;
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)));
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("the host closed the connection"));
    pending.clear();
  });
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data);
    if (frame.type === "push") return;
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
    opened,
    hello: () => {
      const id = `h${++counter}`;
      return send({ type: "hello", id, hello: { protocol: PROTOCOL, token } }, id);
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

if (!existsSync(HOST_ENTRY)) {
  console.log("Building (npm run build)…");
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
}

const { HostProcessSupervisor, readHostDescriptor } = await import(pathToFileURL(join(MAIN, "host-process-supervisor.js")).href);

const workspace = mkdtempSync(join(tmpdir(), "tau-window-host-smoke-"));
const userData = mkdtempSync(join(tmpdir(), "tau-window-host-userdata-"));
const home = mkdtempSync(join(tmpdir(), "tau-window-host-home-"));
execFileSync("git", ["init", "-b", "main", workspace], { stdio: "ignore" });
writeFileSync(join(workspace, "README.md"), "# window host smoke\n");

const options = () => ({
  entry: HOST_ENTRY,
  execPath: process.execPath,
  userData,
  workspace,
  version: "smoke-1",
  restartDelayMs: 50,
  env: {
    ...process.env,
    HOME: home,
    TAU_NO_EXTENSIONS: "1",
    PI_CODING_AGENT_SESSION_DIR: join(home, "pi-sessions"),
  },
});

let supervisor = new HostProcessSupervisor(options());
let adopting;
let passed = false;

try {
  const running = await supervisor.start();
  if (running.adopted) fail("the first start adopted a host that should not exist");
  step("host started", `pid ${running.pid} on ${running.url}`);

  const descriptor = await readHostDescriptor(userData);
  if (descriptor?.pid !== running.pid) fail("host.json does not name the host that was started");
  step("host.json written", `${descriptor.url}, version ${descriptor.version}`);

  const first = createClient(running.url, running.token);
  await first.opened;
  await first.hello();
  await first.request("bootstrap");
  await first.request("rename-thread", ["Survived the window"]);
  step("a client worked in it", "bootstrap and a renamed thread");

  // The window closes: its client goes, the host stays.
  await first.close();
  await wait(250);
  if (!alive(running.pid)) fail("the host stopped when its client disconnected");
  step("the host outlived its client");

  // A window that opens later adopts the host instead of starting a second one.
  adopting = new HostProcessSupervisor(options());
  const adopted = await adopting.start();
  if (!adopted.adopted || adopted.pid !== running.pid) fail(`the second window started its own host (${adopted.pid})`);
  const second = createClient(adopted.url, adopted.token);
  await second.opened;
  await second.hello();
  const bootstrap = await second.request("bootstrap");
  // The title travels in the thread index and the detail; either proves the
  // adopted host still holds the work the first client left behind.
  if (!JSON.stringify(bootstrap).includes("Survived the window")) fail("the adopted host lost the renamed thread");
  step("a new client adopted the running host", "the renamed thread is still there");
  await second.close();

  // A host that dies is replaced, on the port its clients already know.
  process.kill(running.pid, "SIGKILL");
  await waitFor(async () => (await readHostDescriptor(userData))?.pid !== running.pid, "a restarted host");
  const restarted = await readHostDescriptor(userData);
  if (!alive(restarted.pid)) fail("the restarted host is not running");
  if (restarted.url !== running.url) fail(`the restarted host moved to ${restarted.url}`);
  const third = createClient(restarted.url, adopted.token);
  await third.opened;
  await third.hello();
  await third.request("bootstrap");
  await third.close();
  step("a killed host was restarted", `pid ${restarted.pid} on the same port`);

  await adopting.stop();
  adopting = undefined;
  await waitFor(() => !alive(restarted.pid), "the host to stop");
  if (await readHostDescriptor(userData)) fail("host.json outlived the host it named");
  step("stopped on request", "host.json removed");

  console.log(`\nwindow host smoke passed: ${steps.length} steps`);
  passed = true;
} finally {
  await supervisor?.stop().catch(() => undefined);
  await adopting?.stop().catch(() => undefined);
  await rm(workspace, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  // A supervisor watches its child; nothing here has anything left to wait for.
  process.exit(passed ? 0 : 1);
}
