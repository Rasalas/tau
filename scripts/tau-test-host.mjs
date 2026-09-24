#!/usr/bin/env node
// A headless Tau host for remote-access tests, everything under this
// worktree's .tau-dev/test-host: its own home, userData, token and sessions,
// loopback only. `--proxy` adds the listener a reverse proxy such as
// Tailscale Serve forwards to; `--tls` makes the main listener TLS.
//
//   node scripts/tau-test-host.mjs start [--proxy] [--tls] [--kits] [--fresh] [--workspace <path>]
//   node scripts/tau-test-host.mjs status | stop
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stopProcess } from "./tau-cdp.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const TEST_HOST_DIR = join(ROOT, ".tau-dev", "test-host");
const STATE_PATH = join(TEST_HOST_DIR, "state.json");

/** The host's environment: nothing in it points outside `dir`, and nothing listens beyond loopback. */
export function testHostEnv({ base = process.env, root = ROOT, dir = TEST_HOST_DIR, workspace, proxy = false, tls = false, kits = false }) {
  const env = {
    ...base,
    HOME: join(dir, "home"),
    // os.homedir() reads USERPROFILE on Windows.
    USERPROFILE: join(dir, "home"),
    TAU_USER_DATA: join(dir, "userdata"),
    TAU_WORKSPACE: workspace ?? join(dir, "workspace"),
    TAU_HOST_TOKEN_FILE: join(dir, "host-token"),
    TAU_CONFIG_FILE: join(dir, "tau-config.json"),
    TAU_WORKTREES_DIR: join(dir, "worktrees"),
    TAU_THEMES_DIR: join(dir, "themes"),
    TAU_IMPORT_ROOTS: join(dir, "import-roots"),
    PI_CODING_AGENT_DIR: join(dir, "pi-agent"),
    PI_CODING_AGENT_SESSION_DIR: join(dir, "pi-sessions"),
    TAU_WEB_CLIENT: join(root, "dist-web"),
    TAU_HOST_LISTEN: "127.0.0.1:0",
    TAU_BONJOUR_SERVICE_TYPE: "_tau-test._tcp",
    TAU_NO_NATIVE_DIALOGS: "1",
    TAU_SERVICE_UNIT_DIR: join(dir, "service-units"),
    TAU_SERVICE_CONTROL: join(root, "scripts", "fake-service-manager.mjs"),
    TAU_RUNTIME_UPDATE_COMMAND: JSON.stringify({ "*": "echo 'Tau test host: this update was not run.'" }),
  };
  for (const name of ["TAU_HOST_URL", "TAU_HOST_TLS", "TAU_HOST_TLS_CERT", "TAU_HOST_TLS_KEY", "TAU_HOST_PROXY_LISTEN", "TAU_NO_EXTENSIONS", "ELECTRON_RUN_AS_NODE"]) delete env[name];
  if (proxy) env.TAU_HOST_PROXY_LISTEN = "127.0.0.1:0";
  if (tls) env.TAU_HOST_TLS = "1";
  if (!kits) env.TAU_NO_EXTENSIONS = "1";
  return env;
}

/** What the host printed once it listens; `undefined` until everything asked for is there. */
export function parseHostOutput(text, { proxy = false, tls = false } = {}) {
  const url = text.match(/listening on (wss?:\/\/\S+)/u)?.[1];
  const fingerprint = text.match(/tls fingerprint: SHA256 (\S+)/u)?.[1];
  const publicKey = text.match(/tls public key: SHA256 (\S+)/u)?.[1];
  const proxyUrl = text.match(/proxy listener on (http:\/\/\S+)/u)?.[1];
  const link = text.match(/(?:web client|pairing link): (\S+:\/\/\S+)/u)?.[1];
  if (!url || (tls && !fingerprint) || (proxy && !proxyUrl)) return undefined;
  return { url, ...(fingerprint ? { fingerprint } : {}), ...(publicKey ? { publicKey } : {}), ...(proxyUrl ? { proxyUrl } : {}), ...(link ? { link } : {}) };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownHost(pid) {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).includes(join(ROOT, "dist-electron", "main", "headless.js"));
  } catch {
    return false;
  }
}

export function readTestHost() {
  if (!existsSync(STATE_PATH)) throw new Error("no test host; start one with: node scripts/tau-test-host.mjs start");
  const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  if (!alive(state.pid) || !ownHost(state.pid)) throw new Error(`the test host (pid ${state.pid}) is gone; start one with: node scripts/tau-test-host.mjs start`);
  return state;
}

async function start(flags) {
  if (existsSync(STATE_PATH)) {
    const previous = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (alive(previous.pid) && ownHost(previous.pid)) throw new Error(`a test host is already running (pid ${previous.pid}); stop it first`);
  }
  // A device paired in an earlier run would still be listed; --fresh starts without any.
  if (flags.fresh) rmSync(TEST_HOST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_HOST_DIR, { recursive: true });
  const entry = join(ROOT, "dist-electron", "main", "headless.js");
  if (!existsSync(entry) || !existsSync(join(ROOT, "dist-web", "index.html"))) throw new Error("build first: npm run build");
  const workspace = flags.workspace ? resolve(flags.workspace) : undefined;
  const env = testHostEnv({ workspace, proxy: flags.proxy, tls: flags.tls, kits: flags.kits });
  for (const path of [env.HOME, env.TAU_USER_DATA, env.TAU_WORKSPACE, env.PI_CODING_AGENT_DIR]) mkdirSync(path, { recursive: true });
  const logPath = join(TEST_HOST_DIR, "host.log");
  rmSync(logPath, { force: true });
  const log = openSync(logPath, "a");
  const child = spawn(process.execPath, [entry], { cwd: ROOT, env, detached: true, stdio: ["ignore", log, log] });
  child.unref();
  const deadline = Date.now() + 60_000;
  let printed;
  while (Date.now() < deadline && alive(child.pid)) {
    printed = parseHostOutput(readFileSync(logPath, "utf8"), { proxy: flags.proxy, tls: flags.tls });
    if (printed) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  if (!printed) {
    if (alive(child.pid)) process.kill(child.pid, "SIGKILL");
    throw new Error(`the test host did not start; see ${logPath}`);
  }
  const state = { pid: child.pid, ...printed, tokenFile: env.TAU_HOST_TOKEN_FILE, userData: env.TAU_USER_DATA, log: logPath, startedAt: new Date().toISOString() };
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

async function stop() {
  if (!existsSync(STATE_PATH)) return { stopped: null };
  const { pid } = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  const running = alive(pid) && ownHost(pid);
  if (running) await stopProcess(pid);
  rmSync(STATE_PATH, { force: true });
  return { stopped: running ? pid : null };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = {
    proxy: rest.includes("--proxy"),
    tls: rest.includes("--tls"),
    kits: rest.includes("--kits"),
    fresh: rest.includes("--fresh"),
    ...(rest.includes("--workspace") ? { workspace: rest[rest.indexOf("--workspace") + 1] } : {}),
  };
  if (command === "start") return start(flags);
  if (command === "stop") return stop();
  if (command === "status") return readTestHost();
  throw new Error("usage: tau-test-host.mjs start [--proxy] [--tls] [--kits] [--fresh] [--workspace <path>] | status | stop");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify(await main(), null, 1));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
