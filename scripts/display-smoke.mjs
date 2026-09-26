// The invisible display of a Linux service host, end to end, through the fake
// service manager (never the machine's systemd): `install --display` starts
// Xvfb and the host with its DISPLAY; a preview call finds no window, so the
// host starts the window unit; the window says hello on the display and the
// preview hands back a frame. Stopped, the window starts again on the next
// call; uninstalled, nothing is left running. The manager carries a Wayland
// desktop session's environment, as on a machine with a desktop: neither the
// window nor a shell of the host may see it.
// Linux with Xvfb only; elsewhere it says why and passes.
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAIN = join(ROOT, "dist-electron", "main");
const HOST_ENTRY = join(MAIN, "headless.js");
const PROTOCOL = 1;
let steps = 0;

function step(name, detail = "") {
  steps += 1;
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
}

class SmokeFailure extends Error {}
function fail(message) {
  throw new SmokeFailure(message);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(100);
  }
  fail(`timed out waiting for ${message}`);
}

/** A zombie counts as gone: under an init that never reaps (a container's `sleep`), a stopped process stays one. */
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z";
  } catch {
    return false;
  }
}

function findXvfb() {
  for (const directory of (process.env.PATH ?? "").split(":").concat(["/usr/bin", "/usr/local/bin"])) {
    try {
      accessSync(join(directory, "Xvfb"), constants.X_OK);
      return join(directory, "Xvfb");
    } catch {
      // not here
    }
  }
  return undefined;
}

/** Why Electron cannot run here, e.g. a CI container without the GTK libraries a window needs; undefined when it can. */
function electronMissingLibraries() {
  try {
    execFileSync(createRequire(import.meta.url)("electron"), ["--version"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "pipe"] });
    return undefined;
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    const library = /error while loading shared libraries: ([^:\s]+)/u.exec(stderr)?.[1];
    return library ? `Electron cannot load ${library} on this machine` : undefined;
  }
}

const skipReason = process.platform !== "linux"
  ? `the invisible display is Linux only (this is ${process.platform})`
  : !findXvfb() ? "Xvfb is not installed" : electronMissingLibraries();
if (skipReason) {
  console.log(`display smoke skipped: ${skipReason}.`);
  console.log("On the Linux machine itself, follow the checklist in docs/agents/testing-the-app.md, \"Invisible display\".");
  process.exit(0);
}

const guard = setTimeout(() => {
  console.error("✗ the smoke ran into its 300s guard");
  process.exit(1);
}, 300_000);
guard.unref();

/** A client of the host with its token, as the command line is one. */
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
    if (frame.type === "push" || frame.type === "client-call") return;
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
    hello: () => send({ type: "hello", id: "hello", hello: { protocol: PROTOCOL, token, auxiliary: true } }, "hello"),
    request: (method, params = []) => {
      const id = `r${++counter}`;
      return send({ type: "request", request: { id, method, params } }, id);
    },
    close: () => socket.close(),
  };
}

if (!existsSync(HOST_ENTRY)) {
  console.log("Building (npm run build)…");
  execFileSync(process.execPath, [join(ROOT, "scripts", "build.mjs")], { cwd: ROOT, stdio: "inherit" });
}
// Resolving the package downloads its binary if npm did not.
const electronPath = createRequire(import.meta.url)("electron");

const { HostServiceManager } = await import(pathToFileURL(join(MAIN, "host-service.js")).href);
const { readHostDescriptor } = await import(pathToFileURL(join(MAIN, "host-process-supervisor.js")).href);

const home = mkdtempSync(join(tmpdir(), "tau-display-smoke-home-"));
const userData = mkdtempSync(join(tmpdir(), "tau-display-smoke-userdata-"));
const units = join(home, "units");
// Chromium's sandbox needs namespaces a container does not grant; on a real machine the window keeps it.
if (existsSync("/.dockerenv") || existsSync("/run/.containerenv")) {
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, ".no-sandbox"), "");
}
const env = {
  ...process.env,
  HOME: home,
  ZDOTDIR: home,
  PI_CODING_AGENT_DIR: join(home, "pi-agent"),
  PI_CODING_AGENT_SESSION_DIR: join(home, "pi-sessions"),
  TAU_CONFIG_FILE: join(home, "tau-config.json"),
  TAU_WORKTREES_DIR: join(home, "worktrees"),
  TAU_SERVICE_UNIT_DIR: units,
  TAU_SERVICE_CONTROL: join(ROOT, "scripts", "fake-service-manager.mjs"),
  TAU_RUNTIME_UPDATE_COMMAND: "echo",
};
delete env.DISPLAY;
delete env.ELECTRON_RUN_AS_NODE;
// What a Wayland desktop session puts into the user manager and a terminal on that desktop.
const DESKTOP = { WAYLAND_DISPLAY: "wayland-0", WAYLAND_SOCKET: "3", XDG_SESSION_TYPE: "wayland" };
Object.assign(env, DESKTOP);
const FAKE_MANAGER = join(ROOT, "scripts", "fake-service-manager.mjs");
execFileSync(process.execPath, [FAKE_MANAGER, "systemctl", "--user", "set-environment", ...Object.entries(DESKTOP).map(([key, value]) => `${key}=${value}`)], { env, stdio: "inherit" });
/** The desktop's variables a process started with. */
const desktopIn = (pid) => readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter((entry) => Object.keys(DESKTOP).includes(entry.split("=")[0]));
const manager = new HostServiceManager({ execPath: electronPath, entry: HOST_ENTRY, userData, env, home });
const windowUnit = manager.names.unit.replace("tau-host", "tau-window");
const xvfbUnit = manager.names.unit.replace("tau-host", "tau-xvfb");

const fakeState = () => {
  try { return JSON.parse(readFileSync(join(units, ".fake-state.json"), "utf8")); } catch { return {}; }
};
const unitPid = (unit) => fakeState()[unit]?.pid;

const page = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>display smoke</title><body style=\"margin:0;background:rgb(200,40,40)\"><h1 style=\"color:white\">Tau display smoke</h1></body>");
});
await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
const pageUrl = `http://127.0.0.1:${page.address().port}/`;

let client;
let passed = false;
try {
  await manager.install({ display: true });
  const status = await manager.status();
  if (!status.display?.installed) fail(`the display is not installed: ${JSON.stringify(status.display)}`);
  const number = Number(status.display.display.slice(1));
  step("installed with --display", `${status.display.display}, units ${manager.names.unit}, ${xvfbUnit}, ${windowUnit}`);

  await waitFor(() => existsSync(`/tmp/.X11-unix/X${number}`), `Xvfb's socket for ${status.display.display}`);
  await waitFor(async () => (await readHostDescriptor(userData))?.service === "systemd", "the service host to write host.json", 60_000);
  const descriptor = await readHostDescriptor(userData);
  const hostEnv = readFileSync(`/proc/${descriptor.pid}/environ`, "utf8").split("\0");
  if (!hostEnv.includes(`DISPLAY=:${number}`) || !hostEnv.some((entry) => entry.startsWith("XAUTHORITY="))) fail(`the host has no DISPLAY: ${hostEnv.filter((entry) => /DISPLAY|XAUTH/u.test(entry)).join(" ")}`);
  if (desktopIn(descriptor.pid).length > 0) fail(`the host has the desktop's Wayland: ${desktopIn(descriptor.pid).join(" ")}`);
  if (alive(unitPid(windowUnit))) fail("the window started before anything needed it");
  step("Xvfb and the host run, the window does not", `host pid ${descriptor.pid} has DISPLAY=:${number} and no WAYLAND_DISPLAY`);

  const token = readFileSync(descriptor.tokenPath, "utf8").trim();
  client = createClient(descriptor.url, token);
  await client.opened;
  await client.hello();
  await client.request("bootstrap").catch(() => undefined);

  const preview = (command, input) => client.request("host-extension", ["tau.preview", command, input]);
  const started = Date.now();
  const opened = await preview("open", { url: pageUrl });
  if (!alive(unitPid(windowUnit))) fail("the preview opened without the window unit running");
  step("a preview call started the window unit", `${((Date.now() - started) / 1000).toFixed(1)} s, page ${opened?.url ?? "?"}`);
  const windowArgs = readFileSync(`/proc/${unitPid(windowUnit)}/cmdline`, "utf8").split("\0");
  if (desktopIn(unitPid(windowUnit)).length > 0) fail(`the window has the desktop's Wayland: ${desktopIn(unitPid(windowUnit)).join(" ")}`);
  if (!windowArgs.includes("--ozone-platform=x11")) fail(`the window is not told to use X11: ${windowArgs.join(" ")}`);
  step("the window runs on X11, without the desktop's Wayland");

  let lastError;
  const frame = async () => {
    let shot = null;
    await waitFor(async () => {
      shot = await preview("mini-frame").catch((error) => { if (error.message !== lastError) console.log(`  (no frame yet: ${error.message})`); lastError = error.message; return null; });
      return shot?.data;
    }, "a frame of the page", 30_000);
    return shot;
  };
  const shot = await frame();
  const bytes = Buffer.from(shot.data, "base64");
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || shot.width <= 0 || shot.height <= 0) fail(`the frame is no picture: ${shot.width}×${shot.height}, ${bytes.length} bytes`);
  if (process.env.TAU_SMOKE_FRAME) writeFileSync(process.env.TAU_SMOKE_FRAME, bytes);
  step("the window on the display drew the page", `${shot.width}×${shot.height} JPEG, ${bytes.length} bytes`);

  // A terminal stands for every shell the host starts: agents' commands and project scripts inherit the same environment.
  const terminal = await client.request("host-extension", ["tau.terminal", "open", {}]);
  await client.request("host-extension", ["tau.terminal", "input", { id: terminal.id, data: "printf 'ENV%s [%s] [%s] [%s] [%s]\\n' OK \"$DISPLAY\" \"$WAYLAND_DISPLAY\" \"$WAYLAND_SOCKET\" \"$XDG_SESSION_TYPE\"\n" }]);
  let seen;
  await waitFor(async () => {
    const replay = await client.request("host-extension", ["tau.terminal", "replay", { id: terminal.id }]);
    seen = /ENVOK \[([^\]]*)\] \[([^\]]*)\] \[([^\]]*)\] \[([^\]]*)\]/u.exec(replay?.data ?? "");
    return Boolean(seen);
  }, "the terminal to print its environment");
  await client.request("host-extension", ["tau.terminal", "kill", { id: terminal.id }]);
  if (seen[1] !== `:${number}`) fail(`the terminal has DISPLAY=${seen[1]}`);
  if (seen.slice(2).some(Boolean)) fail(`the terminal has the desktop's Wayland: ${seen[0]}`);
  step("a terminal of the host has the display and not the desktop's Wayland", seen[0]);

  const firstWindow = unitPid(windowUnit);
  await manager.stopWindow();
  await waitFor(() => !alive(firstWindow), "the window to stop");
  // A frame, as a device watching the page asks: the preview rebuilds its view in the new window.
  const again = await frame();
  const secondWindow = unitPid(windowUnit);
  if (!alive(secondWindow) || secondWindow === firstWindow) fail("the next call did not start the window again");
  step("stopped, the window starts again on the next frame, with the page", `pid ${firstWindow} → ${secondWindow}, ${again.width}×${again.height}`);

  client.close();
  client = undefined;
  const pids = [descriptor.pid, unitPid(xvfbUnit), secondWindow];
  await manager.uninstall();
  await waitFor(() => pids.every((pid) => !alive(pid)), "host, Xvfb and window to stop", 30_000);
  if (existsSync(join(units, xvfbUnit)) || existsSync(join(units, windowUnit)) || existsSync(join(userData, "display"))) fail("the display's units or cookie are still there");
  step("uninstalled: host, Xvfb and window stopped, units and cookie gone");

  console.log(`\ndisplay smoke passed: ${steps} steps`);
  passed = true;
} catch (error) {
  console.error(`✗ ${error instanceof SmokeFailure ? error.message : error?.stack ?? error}`);
  try { console.error(`--- fake service manager calls\n${readFileSync(join(units, ".fake-calls.log"), "utf8")}`); } catch { /* none */ }
  for (const log of ["display-window.log", "display-xvfb.log", "host-service.log"]) {
    try { console.error(`--- ${log}\n${readFileSync(join(userData, "logs", log), "utf8").split("\n").slice(-25).join("\n")}`); } catch { /* none */ }
  }
} finally {
  client?.close();
  page.close();
  // Anything the fake started and nobody stopped, by pid.
  for (const entry of Object.values(fakeState())) if (entry?.pid && alive(entry.pid)) process.kill(entry.pid, "SIGTERM");
  const gone = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
  if (process.env.TAU_SMOKE_KEEP === "1") console.log(`kept ${userData} and ${home}`);
  else {
    await rm(userData, gone);
    await rm(home, gone);
  }
  process.exit(passed ? 0 : 1);
}
