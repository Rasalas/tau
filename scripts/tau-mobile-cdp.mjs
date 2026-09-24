#!/usr/bin/env node
// A phone or tablet for testing remote access: a headless Chromium with mobile
// emulation and real touch events, driving the web client of this worktree's
// own Tau instance. Recipe: docs/agents/testing-the-app.md, "A phone against
// the instance".
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { HELPERS, SNAPSHOT_EXPR, formatSnapshot, keySpec, parseChord, stopProcess } from "./tau-cdp.mjs";
import { readTestHost } from "./tau-test-host.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEV_DIR = join(ROOT, ".tau-dev");
const STATE_DIR = join(DEV_DIR, "mobile");
const STATE_PATH = join(STATE_DIR, "state.json");
const PROFILE_DIR = join(STATE_DIR, "chrome-profile");

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_UA = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

export const DEVICES = {
  iphone: { width: 393, height: 852, deviceScaleFactor: 3, insets: { top: 59, bottom: 34, left: 0, right: 0 }, userAgent: IPHONE_UA, platform: "iPhone" },
  "iphone-landscape": { width: 852, height: 393, deviceScaleFactor: 3, insets: { top: 0, bottom: 21, left: 59, right: 59 }, userAgent: IPHONE_UA, platform: "iPhone" },
  ipad: { width: 820, height: 1180, deviceScaleFactor: 2, insets: { top: 24, bottom: 20, left: 0, right: 0 }, userAgent: IPAD_UA, platform: "iPad" },
  "ipad-landscape": { width: 1180, height: 820, deviceScaleFactor: 2, insets: { top: 24, bottom: 20, left: 0, right: 0 }, userAgent: IPAD_UA, platform: "iPad" },
  android: { width: 412, height: 915, deviceScaleFactor: 2.625, insets: { top: 24, bottom: 0, left: 0, right: 0 }, userAgent: ANDROID_UA, platform: "Linux armv8l" },
};

const USAGE = `usage: tau-mobile-cdp.mjs <command> [...args]
  launch [--device iphone] [--scheme dark|light] [--resolve <name>]... [--fresh]
  device <name> [--scheme dark|light]      ${Object.keys(DEVICES).join(", ")}
  open <url> [--wait ms]                   loopback, or a name given to launch --resolve
  eval <expr> | wait-for <expr> [ms] | snapshot | screenshot <file.png>
  tap <expr> | longpress <expr> [ms] | swipe <expr> <dx> [dy]
  type <expr> <text> | insert <text> | press <key or chord> | keyboard <px|off>
  wake sleep <ms> | wake offline | wake online | wake foreground
  link [--access full|read-only] [--label <text>] [--via <origin>]
  pair [--access full|read-only] [--label <text>] [--via <origin>] [--allow window|owner|none]
                                           window: the instance's dialog through npm run cdp (default)
  host <method> [json params array]        an owner call on the instance's host
  freeze-host <ms>                         SIGSTOP, then SIGCONT, the instance's host
  stop
host options, instead of the instance's host: --test-host (scripts/tau-test-host.mjs), or
  --host <ws url> --token-file <path> [--host-pid <pid>] for a host started by hand`;

/** `[command, positional, flags]`; a repeated flag collects its values. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const repeated = new Set(["resolve"]);
  const booleans = new Set(["fresh", "test-host"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--") || arg === "--") {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/su);
    const value = booleans.has(name) ? true : inline ?? argv[(index += 1)];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    if (repeated.has(name)) flags[name] = [...(flags[name] ?? []), value];
    else flags[name] = value;
  }
  const [command, ...args] = positional;
  return { command, args, flags };
}

export function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/gu, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host);
}

/** A name the phone resolves to 127.0.0.1, such as a fake Tailscale Serve's MagicDNS name. */
function assertName(name) {
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/iu.test(name)) throw new Error(`--resolve ${JSON.stringify(name)} is not a host name`);
  return name;
}

/** The phone only ever opens loopback, or a name it maps to loopback itself. */
export function assertPhoneUrl(url, names = []) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`open: ${parsed.protocol} is not a web page`);
  if (!isLoopbackHost(parsed.hostname) && !names.includes(parsed.hostname)) {
    throw new Error(`open: ${parsed.hostname} is neither loopback nor a name launch --resolve maps to 127.0.0.1; the test phone stays on this machine`);
  }
  return parsed.toString();
}

/** A host socket the owner calls; loopback only, since only the loopback listener manages access (ADR 0024). */
export function assertLoopbackSocket(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new Error(`${url} is not a host socket (ws:// or wss://)`);
  if (!isLoopbackHost(parsed.hostname)) throw new Error(`${url} is not on loopback; the owner calls a host on this machine only`);
  return url;
}

export function chromeArgs({ port, profile, device, names = [] }) {
  const { width, height } = DEVICES[device];
  const rules = names.map((name) => `MAP ${assertName(name)} 127.0.0.1`).join(", ");
  return [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--hide-scrollbars",
    "--touch-events=enabled",
    `--window-size=${width},${height}`,
    // Coarse pointer and no hover from the first paint: the web client picks its profile once, at load.
    "--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1",
    ...(rules ? [`--host-resolver-rules=${rules}`] : []),
    "about:blank",
  ];
}

function listDir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** TAU_MOBILE_CHROME, else the newest Playwright Chromium, else an installed Chrome or Chromium. */
export function findChromium({ env = process.env, platform = process.platform, home = homedir(), exists = existsSync, list = listDir } = {}) {
  if (env.TAU_MOBILE_CHROME) return env.TAU_MOBILE_CHROME;
  const cache = platform === "darwin" ? join(home, "Library", "Caches", "ms-playwright") : join(home, ".cache", "ms-playwright");
  const builds = list(cache).filter((name) => /^chromium-\d+$/u.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  const inside = platform === "darwin"
    ? ["chrome-mac-arm64", "chrome-mac"].map((dir) => join(dir, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"))
    : ["chrome-linux64/chrome", "chrome-linux/chrome"];
  for (const build of builds) {
    for (const path of inside) if (exists(join(cache, build, path))) return join(cache, build, path);
  }
  const system = platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
  const found = system.find((path) => exists(path));
  if (found) return found;
  throw new Error("no Chromium found: set TAU_MOBILE_CHROME, or install Playwright's (npx playwright install chromium)");
}

/** The CDP calls that make the page a device; they last only while the session that sent them stays attached. */
export function emulationSteps(device, scheme = "dark") {
  const spec = DEVICES[device];
  if (!spec) throw new Error(`unknown device ${JSON.stringify(device)} (known: ${Object.keys(DEVICES).join(", ")})`);
  const landscape = spec.width > spec.height;
  return [
    ["Emulation.setDeviceMetricsOverride", {
      width: spec.width,
      height: spec.height,
      deviceScaleFactor: spec.deviceScaleFactor,
      mobile: true,
      screenOrientation: landscape ? { type: "landscapePrimary", angle: 90 } : { type: "portraitPrimary", angle: 0 },
    }],
    ["Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }],
    ["Emulation.setUserAgentOverride", { userAgent: spec.userAgent, platform: spec.platform }],
    ["Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }],
    // A phone's page is the one in front; without this a headless page stays hidden after a freeze, and touches hang.
    ["Emulation.setFocusEmulationEnabled", { enabled: true }],
    ["Emulation.setSafeAreaInsetsOverride", { insets: spec.insets }],
  ];
}

/** `Input.dispatchTouchEvent` calls for a gesture at an element's box, with the pause before each. */
export function touchSteps(gesture, box, { holdMs = 700, dx = 0, dy = 0, steps = 12, stepMs = 16 } = {}) {
  const point = (x, y) => [{ x: Math.round(x), y: Math.round(y), id: 1 }];
  if (gesture === "tap") {
    return [{ type: "touchStart", touchPoints: point(box.x, box.y), waitMs: 0 }, { type: "touchEnd", touchPoints: [], waitMs: 40 }];
  }
  if (gesture === "longpress") {
    return [{ type: "touchStart", touchPoints: point(box.x, box.y), waitMs: 0 }, { type: "touchEnd", touchPoints: [], waitMs: holdMs }];
  }
  if (gesture === "swipe") {
    // A swipe to the left starts near the right edge, the way a thumb opens a row's tray.
    const x0 = box.x + (dx < 0 ? box.w / 2 - 20 : 0);
    const y0 = box.y;
    const moves = Array.from({ length: steps }, (_, index) => ({
      type: "touchMove",
      touchPoints: point(x0 + (dx * (index + 1)) / steps, y0 + (dy * (index + 1)) / steps),
      waitMs: stepMs,
    }));
    return [{ type: "touchStart", touchPoints: point(x0, y0), waitMs: 0 }, ...moves, { type: "touchEnd", touchPoints: [], waitMs: stepMs }];
  }
  throw new Error(`unknown gesture ${gesture}`);
}

/** The link a phone on this machine opens: the loopback one, or the same fragment through a proxy's origin. */
export function pickPairingUrl(urls, via) {
  const own = urls.find((endpoint) => endpoint.reachability === "loopback") ?? urls[0];
  if (!own) throw new Error("the host offered no address to pair with");
  if (!via) return own.url;
  const base = new URL(via);
  const link = new URL(own.url);
  link.protocol = base.protocol;
  link.host = base.host;
  return link.toString();
}

export function sameCode(left, right) {
  const digits = (value) => String(value ?? "").replace(/\D/gu, "");
  return digits(left).length === 6 && digits(left) === digits(right);
}

/** Only a process whose command line names `needle` (this worktree, this profile) is ever signalled. */
export function assertOwnProcess(commandLine, needle, what) {
  if (!commandLine || !commandLine.includes(needle)) throw new Error(`${what} is not this worktree's (${(commandLine || "gone").trim().slice(0, 160)}); refusing to touch it`);
}

function psLine(pid) {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function readState() {
  if (!existsSync(STATE_PATH)) throw new Error("no phone is running; start one with: npm run cdp:mobile -- launch");
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

async function openSession(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error(`the phone on port ${port} has no page`);
  const socket = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolvePromise, rejectPromise) => {
    socket.once("open", resolvePromise);
    socket.once("error", rejectPromise);
  });
  let counter = 0;
  const waiting = new Map();
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data));
    if (frame.id && waiting.has(frame.id)) {
      waiting.get(frame.id)(frame);
      waiting.delete(frame.id);
    }
  });
  const send = (method, params = {}, timeoutMs = 30_000) => new Promise((resolvePromise, rejectPromise) => {
    counter += 1;
    const id = counter;
    const timer = setTimeout(() => {
      waiting.delete(id);
      rejectPromise(new Error(`${method}: the phone did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
    waiting.set(id, (frame) => {
      clearTimeout(timer);
      if (frame.error) rejectPromise(new Error(`${method}: ${frame.error.message}`));
      else resolvePromise(frame.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { send, socket, close: () => socket.close() };
}

/** Refuses a state file whose browser is not the one this worktree started with its own profile. */
function ownPhone() {
  const state = readState();
  if (!alive(state.pid)) throw new Error(`the phone (pid ${state.pid}) is gone; start one with: npm run cdp:mobile -- launch`);
  assertOwnProcess(psLine(state.pid), `--user-data-dir=${PROFILE_DIR}`, `pid ${state.pid}`);
  return state;
}

async function evaluate(session, expression) {
  const result = await session.send("Runtime.evaluate", {
    expression: `(async () => { ${HELPERS}\n return (${expression}); })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
}

async function boxOf(session, expr) {
  const box = await evaluate(session, `(() => { const el = (${expr}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
  if (!box) throw new Error(`expression did not resolve to an element: ${expr}`);
  return box;
}

async function runTouch(session, steps) {
  for (const { waitMs, ...params } of steps) {
    if (waitMs) await wait(waitMs);
    await session.send("Input.dispatchTouchEvent", params);
  }
}

/**
 * Keeps one CDP session attached for the phone's lifetime, so its emulation
 * holds between commands. SIGHUP re-reads the state (a new device or scheme).
 */
async function hold() {
  const state = readState();
  const session = await openSession(state.port);
  const apply = async () => {
    const current = readState();
    for (const [method, params] of emulationSteps(current.device, current.scheme)) {
      // Older Chromium has no safe-area override; the rest still makes a phone.
      await session.send(method, params).catch((error) => {
        if (method !== "Emulation.setSafeAreaInsetsOverride") throw error;
      });
    }
  };
  await apply();
  process.on("SIGHUP", () => void apply());
  process.on("SIGTERM", () => process.exit(0));
  session.socket.on("close", () => process.exit(0));
  writeState({ ...readState(), holderPid: process.pid, holding: true });
}

async function launch(flags) {
  if (existsSync(STATE_PATH)) {
    const previous = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (alive(previous.pid) && psLine(previous.pid).includes(`--user-data-dir=${PROFILE_DIR}`)) throw new Error(`a phone is already running (pid ${previous.pid}); stop it first`);
  }
  const device = flags.device ?? "iphone";
  const scheme = flags.scheme ?? "dark";
  emulationSteps(device, scheme);
  const names = (flags.resolve ?? []).map(assertName);
  // The profile holds the paired token; --fresh is a device that never paired.
  if (flags.fresh) rmSync(PROFILE_DIR, { recursive: true, force: true });
  mkdirSync(PROFILE_DIR, { recursive: true });
  const port = await freePort();
  const log = openSync(join(STATE_DIR, "chrome.log"), "a");
  const chrome = spawn(findChromium(), chromeArgs({ port, profile: PROFILE_DIR, device, names }), { detached: true, stdio: ["ignore", log, log] });
  chrome.unref();
  writeState({ pid: chrome.pid, port, device, scheme, names, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 75; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch {
      await wait(200);
    }
  }
  const holder = spawn(process.execPath, [fileURLToPath(import.meta.url), "__hold"], { detached: true, stdio: ["ignore", log, log] });
  holder.unref();
  for (let attempt = 0; attempt < 50 && !readState().holding; attempt += 1) await wait(100);
  if (!readState().holding) throw new Error("the phone started, but its emulation did not; see .tau-dev/mobile/chrome.log");
  return { pid: chrome.pid, holder: holder.pid, port, device, scheme, names };
}

async function stopPhone() {
  if (!existsSync(STATE_PATH)) return { stopped: null };
  const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  const stopped = [];
  if (state.holderPid && alive(state.holderPid) && psLine(state.holderPid).includes("tau-mobile-cdp.mjs __hold")) {
    await stopProcess(state.holderPid);
    stopped.push(state.holderPid);
  }
  if (alive(state.pid)) {
    assertOwnProcess(psLine(state.pid), `--user-data-dir=${PROFILE_DIR}`, `pid ${state.pid}`);
    await stopProcess(state.pid);
    stopped.push(state.pid);
  }
  rmSync(STATE_PATH, { force: true });
  return { stopped };
}

/** This worktree's instance: its host's socket and pid, and the token file dev-instance gives it. */
export function instanceHost({ devDir = DEV_DIR, readFile = (path) => readFileSync(path, "utf8") } = {}) {
  let instance;
  try {
    instance = JSON.parse(readFile(join(devDir, "instance.json")));
  } catch {
    throw new Error("no instance in this worktree; start one with npm run dev:instance (or pass --host and --token-file)");
  }
  let descriptor;
  try {
    descriptor = JSON.parse(readFile(join(instance.userData, "host.json")));
  } catch {
    throw new Error(`the instance's host has not written ${join(instance.userData, "host.json")} yet`);
  }
  return { url: descriptor.url, pid: descriptor.pid, tokenFile: join(devDir, "host-token") };
}

function hostFromFlags(flags) {
  if (flags["test-host"]) {
    const state = readTestHost();
    return { url: state.url, tokenFile: state.tokenFile, pid: state.pid };
  }
  if (flags.host || flags["token-file"]) {
    if (!flags.host || !flags["token-file"]) throw new Error("--host and --token-file go together");
    return { url: flags.host, tokenFile: flags["token-file"], pid: flags["host-pid"] ? Number(flags["host-pid"]) : undefined };
  }
  const host = instanceHost();
  if (!host.pid || !alive(host.pid)) throw new Error(`the instance's host (pid ${host.pid}) is not running`);
  assertOwnProcess(psLine(host.pid), ROOT, `host pid ${host.pid}`);
  return host;
}

/** One request as the owner: the host token over the loopback listener. */
export async function hostCall({ url, token, method, params = [], timeoutMs = 15_000, WebSocketImpl = WebSocket }) {
  assertLoopbackSocket(url);
  // A test host's certificate is self-signed, and loopback cannot be intercepted.
  const socket = new WebSocketImpl(url, { rejectUnauthorized: false });
  try {
    return await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`${method}: no answer within ${timeoutMs} ms`)), timeoutMs);
      socket.on("error", (error) => { clearTimeout(timer); rejectPromise(error); });
      socket.on("close", (code, reason) => { clearTimeout(timer); rejectPromise(new Error(`${method}: the host closed the socket (${code} ${String(reason)})`)); });
      socket.on("open", () => socket.send(JSON.stringify({ type: "hello", id: "owner", hello: { protocol: 1, token, auxiliary: true } })));
      socket.on("message", (data) => {
        const frame = JSON.parse(String(data));
        if (frame.type === "hello-reply") socket.send(JSON.stringify({ type: "request", request: { id: "call", method, params } }));
        if (frame.type === "response" && frame.response.id === "call") {
          clearTimeout(timer);
          if (frame.response.error) rejectPromise(new Error(`${method}: ${frame.response.error.message ?? JSON.stringify(frame.response.error)}`));
          else resolvePromise(frame.response.result);
        }
      });
    });
  } finally {
    socket.removeAllListeners("close");
    socket.close();
  }
}

async function ownerCall(flags, method, params) {
  const host = hostFromFlags(flags);
  const token = readFileSync(host.tokenFile, "utf8").trim();
  return hostCall({ url: host.url, token, method, params });
}

function access(flags) {
  const value = flags.access ?? "full";
  if (value !== "full" && value !== "read-only") throw new Error("--access is full or read-only");
  return value;
}

async function createLink(flags) {
  const label = flags.label ?? "Test phone";
  const created = await ownerCall(flags, "connections-create-link", [{ label, access: access(flags) }]);
  return { label, created, url: pickPairingUrl(created.urls, flags.via) };
}

/** The window's own dialog, allowed through `npm run cdp`, so the owner's side is the real UI. */
function allowInWindow(code) {
  const cdp = (...args) => execFileSync(process.execPath, [join(ROOT, "scripts", "tau-cdp.mjs"), ...args], { cwd: ROOT, encoding: "utf8" });
  const dialog = `all('[role=dialog]').find((d) => /wants to connect/.test(d.getAttribute('aria-label') ?? d.textContent) && (d.querySelector('.pairing-code')?.textContent ?? '').replace(/\\D/g, '') === ${JSON.stringify(code.replace(/\D/gu, ""))})`;
  cdp("wait-for", `!!${dialog}`, "15000");
  cdp("click", `[...${dialog}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Allow')`);
}

async function pair(session, flags, state) {
  const { label, url } = await createLink(flags);
  assertPhoneUrl(url, state.names);
  await session.send("Page.navigate", { url });
  let request;
  let shown;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !(request && shown)) {
    await wait(300);
    const list = await ownerCall(flags, "connections-list", []);
    request = list.requests.find((entry) => entry.link?.label === label);
    shown = await evaluate(session, "document.querySelector('.token-gate-code')?.textContent ?? null").catch(() => null);
  }
  if (!request || !shown) throw new Error(`no pairing request reached the host within 30 s (phone shows ${JSON.stringify(shown)})`);
  if (!sameCode(shown, request.verification)) throw new Error(`the phone shows ${shown}, the host ${request.verification}: not the same request`);
  const external = Boolean(flags["test-host"] || flags.host);
  const allow = flags.allow ?? (external ? "owner" : "window");
  if (allow === "window" && external) throw new Error("--allow window allows in the instance's window; a test host or a host started by hand has none (use --allow owner)");
  if (allow === "window") allowInWindow(request.verification);
  else if (allow === "owner") await ownerCall(flags, "connections-approve", [request.id, {}]);
  else if (allow !== "none") throw new Error("--allow is window, owner or none");
  if (allow !== "none") {
    const until = Date.now() + 30_000;
    while (Date.now() < until && !(await evaluate(session, "!!document.body.dataset.profile && !document.querySelector('.token-gate')").catch(() => false))) await wait(300);
  }
  const profile = await evaluate(session, "({ client: document.body.dataset.client ?? null, profile: document.body.dataset.profile ?? null, gate: !!document.querySelector('.token-gate') })");
  return { label, url, request: request.id, code: shown, access: request.access, allowed: allow, ...profile };
}

async function freezeHost(flags, ms) {
  const host = hostFromFlags(flags);
  if (!host.pid) throw new Error("--host-pid names the host to freeze");
  assertOwnProcess(psLine(host.pid), ROOT, `host pid ${host.pid}`);
  process.kill(host.pid, "SIGSTOP");
  try {
    await wait(ms);
  } finally {
    process.kill(host.pid, "SIGCONT");
  }
  return { frozen: host.pid, ms };
}

async function wake(session, kind, arg) {
  if (kind === "sleep") {
    // A phone in a pocket: timers and sockets stop, and `resume` fires on the way back.
    await session.send("Page.setWebLifecycleState", { state: "frozen" });
    await wait(Number(arg ?? 5000));
    await session.send("Page.setWebLifecycleState", { state: "active" });
    return { slept: Number(arg ?? 5000) };
  }
  if (kind === "offline" || kind === "online") {
    await session.send("Network.enable");
    await session.send("Network.emulateNetworkConditions", { offline: kind === "offline", latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    return { network: kind };
  }
  if (kind === "foreground") {
    await evaluate(session, "(document.dispatchEvent(new Event('visibilitychange')), true)");
    return { wake: "foreground" };
  }
  throw new Error("wake sleep <ms> | offline | online | foreground");
}

async function onPage(command, args, flags) {
  const state = ownPhone();
  const session = await openSession(state.port);
  try {
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    return await pageCommand(session, state, command, args, flags);
  } finally {
    session.close();
  }
}

async function pageCommand(session, state, command, args, flags) {
  switch (command) {
    case "open": {
      await session.send("Page.navigate", { url: assertPhoneUrl(args[0], state.names) });
      await wait(Number(flags.wait ?? 2000));
      return { opened: args[0] };
    }
    case "eval":
      return evaluate(session, args[0]);
    case "wait-for": {
      const deadline = Date.now() + Number(args[1] ?? 15_000);
      for (;;) {
        const value = await evaluate(session, args[0]).catch(() => undefined);
        if (value) return value;
        if (Date.now() >= deadline) throw new Error(`wait-for: timed out waiting for ${args[0]}`);
        await wait(200);
      }
    }
    case "snapshot":
      return { text: formatSnapshot(await evaluate(session, SNAPSHOT_EXPR)) };
    case "screenshot": {
      const shot = await session.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(args[0], Buffer.from(shot.data, "base64"));
      return { savedTo: args[0] };
    }
    case "tap":
    case "longpress": {
      const box = await boxOf(session, args[0]);
      await runTouch(session, touchSteps(command, box, { holdMs: Number(args[1] ?? 700) }));
      return { [command]: args[0], at: { x: box.x, y: box.y } };
    }
    case "swipe": {
      const box = await boxOf(session, args[0]);
      await runTouch(session, touchSteps("swipe", box, { dx: Number(args[1] ?? 0), dy: Number(args[2] ?? 0) }));
      return { swiped: args[0], dx: Number(args[1] ?? 0), dy: Number(args[2] ?? 0) };
    }
    case "type": {
      const ok = await evaluate(session, `(() => { const el = (${args[0]}); if (!el) return false; el.focus(); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(args[1])}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      if (!ok) throw new Error(`type: expression did not resolve to an element: ${args[0]}`);
      return { typed: args[1] };
    }
    case "insert":
      await session.send("Input.insertText", { text: args[0] });
      return { inserted: args[0] };
    case "press": {
      const chord = parseChord(args[0]);
      const spec = chord ? { ...chord.key, modifiers: chord.modifiers } : keySpec(args[0]);
      await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...spec });
      if (!chord && spec.text) await session.send("Input.dispatchKeyEvent", { type: "char", ...spec });
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...spec });
      return { pressed: args[0] };
    }
    case "keyboard": {
      // An on-screen keyboard shrinks the visual viewport and leaves the layout one (iOS, Chrome on Android).
      const px = args[0] === "off" ? 0 : Number(args[0]);
      if (!Number.isFinite(px)) throw new Error("keyboard <px|off>");
      return evaluate(session, `(() => { const v = window.visualViewport; const full = window.innerHeight; Object.defineProperty(v, 'height', { configurable: true, get: () => full - ${px} }); v.dispatchEvent(new Event('resize')); return { layout: full, visual: v.height, keyboard: document.body.hasAttribute('data-keyboard') }; })()`);
    }
    case "wake":
      return wake(session, args[0], args[1]);
    case "pair":
      return pair(session, flags, state);
    default:
      throw new Error(`unknown command ${JSON.stringify(command)}\n${USAGE}`);
  }
}

async function main() {
  const { command, args, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "__hold":
      return hold();
    case undefined:
    case "help":
      return USAGE;
    case "launch":
      return launch(flags);
    case "stop":
      return stopPhone();
    case "device": {
      const state = ownPhone();
      emulationSteps(args[0], flags.scheme ?? state.scheme);
      writeState({ ...state, device: args[0], scheme: flags.scheme ?? state.scheme });
      process.kill(state.holderPid, "SIGHUP");
      return { device: args[0], scheme: flags.scheme ?? state.scheme, note: "reload (open) the page: the web client picks its profile at load" };
    }
    case "link": {
      const { url, created } = await createLink(flags);
      return { url, expiresAt: created.link.expiresAt, urls: created.urls.map((entry) => ({ label: entry.label, url: entry.url })) };
    }
    case "host":
      return ownerCall(flags, args[0], args[1] ? JSON.parse(args[1]) : []);
    case "freeze-host":
      return freezeHost(flags, Number(args[0] ?? 5000));
    default:
      return onPage(command, args, flags);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await main();
    if (typeof result === "string") console.log(result);
    else if (result && typeof result === "object" && typeof result.text === "string" && Object.keys(result).length === 1) console.log(result.text);
    else if (result !== undefined) console.log(JSON.stringify(result, null, 1));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
