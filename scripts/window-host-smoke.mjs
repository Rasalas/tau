// Drives the host as its own process, the way a window does (ADR 0021):
// start it, work in it, drop the client the way a closed window does, adopt
// the same host from a second supervisor, survive a kill, and stop it. Then
// the same host as a system service, through the fake service manager: the
// service takes over from the window's host, a window adopts it and leaves it
// running, an update restarts it once without a loop, and an uninstall hands
// the window back a host of its own.
// No Electron and no model: what is under test is the process, not the UI.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  execFileSync(process.execPath, [join(ROOT, "scripts", "build.mjs")], { cwd: ROOT, stdio: "inherit" });
}

const { HostProcessSupervisor, readHostDescriptor } = await import(pathToFileURL(join(MAIN, "host-process-supervisor.js")).href);
const { HostServiceManager } = await import(pathToFileURL(join(MAIN, "host-service.js")).href);

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
const serviceSupervisors = [];
let serviceHome;
let serviceUserData;

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
  // A window asks for its themes and kit bundles beside its bootstrap, not after it.
  await first.request("list-user-themes", [workspace]);
  step("a call before the bootstrap waited for the host to start");
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

  if (process.platform === "win32") step("service phase skipped", "the fake service manager does not fake Task Scheduler");
  else await servicePhase();

  console.log(`\nwindow host smoke passed: ${steps.length} steps`);
  passed = true;
} finally {
  await supervisor?.stop().catch(() => undefined);
  await adopting?.stop().catch(() => undefined);
  for (const instance of serviceSupervisors) await instance.stop().catch(() => undefined);
  await stopFakeServices().catch(() => undefined);
  // A stopped host may still flush its last log line into userData.
  const gone = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
  await rm(workspace, gone);
  await rm(userData, gone);
  await rm(home, gone);
  if (serviceHome) await rm(serviceHome, gone);
  if (serviceUserData) await rm(serviceUserData, gone);
  // A supervisor watches its child; nothing here has anything left to wait for.
  process.exit(passed ? 0 : 1);
}

function serviceEnv() {
  return {
    ...process.env,
    HOME: serviceHome,
    TAU_NO_EXTENSIONS: "1",
    PI_CODING_AGENT_SESSION_DIR: join(serviceHome, "pi-sessions"),
    TAU_SERVICE_UNIT_DIR: join(serviceHome, "units"),
    TAU_SERVICE_CONTROL: join(ROOT, "scripts", "fake-service-manager.mjs"),
  };
}

function serviceManager() {
  return new HostServiceManager({ execPath: process.execPath, entry: HOST_ENTRY, userData: serviceUserData, env: serviceEnv(), home: serviceHome });
}

/** A window's supervisor with the service of its userData, as `window-host.ts` builds it. */
function serviceSupervisor(version, extra = {}) {
  const manager = serviceManager();
  const instance = new HostProcessSupervisor({
    entry: HOST_ENTRY,
    execPath: process.execPath,
    userData: serviceUserData,
    workspace,
    version,
    restartDelayMs: 50,
    serviceCheckMs: 200,
    serviceStartTimeoutMs: 30_000,
    env: serviceEnv(),
    service: { installed: () => manager.installed(), start: () => manager.start(), restart: () => manager.restart(), repair: () => manager.install() },
    ...extra,
  });
  serviceSupervisors.push(instance);
  return instance;
}

function fakeCalls() {
  try { return readFileSync(join(serviceHome, "units", ".fake-calls.log"), "utf8").trim().split("\n"); } catch { return []; }
}

/** Any host the fake service manager started and nobody stopped. */
async function stopFakeServices() {
  if (!serviceHome) return;
  let state = {};
  try { state = JSON.parse(readFileSync(join(serviceHome, "units", ".fake-state.json"), "utf8")); } catch { return; }
  for (const entry of Object.values(state)) if (entry?.pid && alive(entry.pid)) process.kill(entry.pid, "SIGTERM");
}

async function servicePhase() {
  serviceHome = mkdtempSync(join(tmpdir(), "tau-service-smoke-home-"));
  serviceUserData = mkdtempSync(join(tmpdir(), "tau-service-smoke-userdata-"));
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

  const window = serviceSupervisor(version);
  const own = await window.start();
  if (own.adopted || own.service) fail("a window without a service installed did not start its own host");
  const client = createClient(own.url, own.token);
  await client.opened;
  await client.hello();
  const before = await client.request("service-status");
  if (!before.supported || before.installed) fail(`unexpected service status before install: ${JSON.stringify(before)}`);
  step("service: not installed", `${before.manager} ${before.label}`);

  // The window's own host installs the service; the host it starts takes over.
  await client.request("service-install").catch(() => undefined);
  await waitFor(() => window.descriptor?.service !== undefined && window.descriptor.pid !== own.pid, "the window to follow the service host");
  const served = await readHostDescriptor(serviceUserData);
  if (!served?.service || served.pid === own.pid) fail(`host.json does not name a service host: ${JSON.stringify(served)}`);
  if (alive(own.pid)) fail("the window's own host still runs beside the service host");
  if (served.url !== own.url) fail(`the service host did not keep the port: ${served.url} instead of ${own.url}`);
  // Its host is gone, and a closed socket fires no second close event to wait for.
  void client.close();
  const serviceClient = createClient(served.url, own.token);
  await serviceClient.opened;
  await serviceClient.hello();
  const status = await serviceClient.request("service-status");
  if (!status.installed || !status.running || !status.serving || status.stale) fail(`unexpected service status after install: ${JSON.stringify(status)}`);
  await serviceClient.request("bootstrap");
  await serviceClient.close();
  step("service: installed, took over the window's host", `pid ${served.pid} on the same port`);

  // A second window adopts the service host, and quitting it leaves it running.
  const second = serviceSupervisor(version);
  const adopted = await second.start();
  if (!adopted.adopted || adopted.pid !== served.pid || !adopted.service) fail("a second window did not adopt the service host");
  await second.stop();
  await window.stop();
  if (!alive(served.pid)) fail("stopping a window stopped the service host");
  if (!(await readHostDescriptor(serviceUserData))) fail("stopping a window removed the service host's host.json");
  step("service: windows adopt it and leave it running");

  // A window of another version: one restart, one repair, then a host of its own. No loop.
  const callsBefore = fakeCalls().length;
  const other = serviceSupervisor("0.0.0-other", { serviceStartTimeoutMs: 20_000 });
  const fallback = await other.start();
  const calls = fakeCalls().slice(callsBefore);
  // The restart is `kickstart -k` or `systemctl restart`; the repair loads the rewritten unit again.
  const restarts = calls.filter((line) => /kickstart -k|launchctl bootstrap|systemctl --user restart/u.test(line)).length;
  if (fallback.service || fallback.adopted) fail("a window of another version adopted the service host");
  if (restarts !== 2) fail(`expected one restart and one repair, the fake manager saw: ${calls.join(" | ")}`);
  const stoppedService = await readHostDescriptor(serviceUserData);
  if (stoppedService?.service) fail("the refused service host was not stopped");
  await wait(1_000);
  if (fakeCalls().length !== callsBefore + calls.length) fail(`the service kept being restarted: ${fakeCalls().slice(callsBefore + calls.length).join(" | ")}`);
  await other.stop();
  step("service: another version restarts it once, repairs it once, then runs its own host", `${calls.length} manager calls`);

  // Installed but not running: a window starts the service instead of a host of its own.
  const third = serviceSupervisor(version);
  const started = await third.start();
  if (!started.service) fail("a window did not start the installed service");
  step("service: a window starts the installed service", `pid ${started.pid}`);

  // `tau service uninstall`: the window follows back to a host of its own.
  execFileSync(process.execPath, [join(MAIN, "service-cli.js"), "uninstall"], { env: { ...serviceEnv(), TAU_USER_DATA: serviceUserData }, stdio: "ignore" });
  await waitFor(() => !alive(started.pid), "the service host to stop");
  await waitFor(() => third.descriptor && !third.descriptor.service && alive(third.descriptor.pid), "the window to start its own host");
  if (await serviceManager().installed()) fail("the unit outlived the uninstall");
  step("service: uninstalled, the window runs its own host again", `pid ${third.descriptor.pid}`);
  await third.stop();
}
