#!/usr/bin/env node
// Headless Tau hosts for remote-access and remote-work tests, each under this
// worktree's .tau-dev: `test-host/` without a name, `test-host-<name>/` with
// one. Each has its own home, userData, token, sessions and runtime homes,
// and listens on loopback only. `--proxy` adds the listener a reverse proxy
// such as Tailscale Serve forwards to; `--tls` makes the main listener TLS.
//
//   node scripts/tau-test-host.mjs start [--name <name>] [--proxy] [--tls] [--kits] [--fresh] [--no-login] [--workspace <path>]
//   node scripts/tau-test-host.mjs status [--name <name>] | stop [--name <name> | --all] | list
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preparePiAgentDir } from "./pi-agent-shadow.mjs";
import { stopProcess } from "./tau-cdp.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const TEST_HOST_DIR = join(ROOT, ".tau-dev", "test-host");
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/u;

/** `.tau-dev/test-host` for the unnamed host, `.tau-dev/test-host-<name>` for a named one. */
export function testHostDir(name, root = ROOT) {
  if (name === undefined) return join(root, ".tau-dev", "test-host");
  if (typeof name !== "string" || !NAME.test(name)) throw new Error(`a test host name is lowercase letters, digits and dashes, got ${JSON.stringify(name)}`);
  return join(root, ".tau-dev", `test-host-${name}`);
}

/** Where fixture repos and their bare "origin" live; the only folder a `file://` clone may come from in tests. */
export function remoteWorkDir(root = ROOT) {
  return join(root, ".tau-dev", "remote-work");
}

/** The host's environment: nothing in it points outside `dir`, and nothing listens beyond loopback. */
export function testHostEnv({ base = process.env, root = ROOT, dir = TEST_HOST_DIR, name, workspace, proxy = false, tls = false, kits = false }) {
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
    // The other runtimes' homes: none of them signed in, never the caller's.
    CODEX_HOME: join(dir, "codex-home"),
    TAU_OPENCODE_HOME: join(dir, "opencode-home"),
    TAU_CURSOR_HOME: join(dir, "cursor-home"),
    TAU_GROK_HOME: join(dir, "grok-home"),
    TAU_WEB_CLIENT: join(root, "dist-web"),
    TAU_HOST_LISTEN: "127.0.0.1:0",
    TAU_BONJOUR_SERVICE_TYPE: "_tau-test._tcp",
    TAU_NO_NATIVE_DIALOGS: "1",
    TAU_SERVICE_UNIT_DIR: join(dir, "service-units"),
    TAU_SERVICE_CONTROL: join(root, "scripts", "fake-service-manager.mjs"),
    TAU_RUNTIME_UPDATE_COMMAND: JSON.stringify({ "*": "echo 'Tau test host: this update was not run.'" }),
    TAU_NO_RUNTIME_UPDATES: "1",
    // Servers kit, when kits run: loopback targets only, projects only below `dir`.
    TAU_SERVERS_LOOPBACK_ONLY: "1",
    TAU_SERVERS_PROJECTS_ROOT: join(dir, "projects"),
    // Fixture repos clone from their bare "origin" here; nowhere else takes `file://`.
    TAU_TEST_CLONE_ROOT: remoteWorkDir(root),
  };
  for (const variable of ["TAU_HOST_URL", "TAU_HOST_TLS", "TAU_HOST_TLS_CERT", "TAU_HOST_TLS_KEY", "TAU_HOST_PROXY_LISTEN", "TAU_NO_EXTENSIONS", "TAU_MACHINE_NAME", "ELECTRON_RUN_AS_NODE"]) delete env[variable];
  if (name) env.TAU_MACHINE_NAME = name;
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

/** Parses the CLI; throws on an unknown flag rather than starting a host nobody asked for. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = { proxy: false, tls: false, kits: false, fresh: false, login: true, all: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--proxy") flags.proxy = true;
    else if (arg === "--tls") flags.tls = true;
    else if (arg === "--kits") flags.kits = true;
    else if (arg === "--fresh") flags.fresh = true;
    else if (arg === "--no-login") flags.login = false;
    else if (arg === "--all") flags.all = true;
    else if (arg === "--name" || arg === "--workspace") {
      const value = rest[++index];
      if (!value) throw new Error(`${arg} needs a value`);
      flags[arg.slice(2)] = value;
    } else throw new Error(`unknown flag ${JSON.stringify(arg)}`);
  }
  if (flags.name !== undefined) testHostDir(flags.name);
  return { command, flags };
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

function startHint(name) {
  return `node scripts/tau-test-host.mjs start${name ? ` --name ${name}` : ""}`;
}

/** The running test host `name` (the unnamed one without it); throws when it is not running. */
export function readTestHost(name) {
  const statePath = join(testHostDir(name), "state.json");
  if (!existsSync(statePath)) throw new Error(`no test host${name ? ` "${name}"` : ""}; start one with: ${startHint(name)}`);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (!alive(state.pid) || !ownHost(state.pid)) throw new Error(`the test host${name ? ` "${name}"` : ""} (pid ${state.pid}) is gone; start one with: ${startHint(name)}`);
  return state;
}

/** Every test host of this worktree that has a state file, running or not. */
export function listTestHosts(root = ROOT) {
  const devDir = join(root, ".tau-dev");
  if (!existsSync(devDir)) return [];
  const hosts = [];
  for (const entry of readdirSync(devDir)) {
    const name = entry === "test-host" ? undefined : entry.startsWith("test-host-") ? entry.slice("test-host-".length) : null;
    if (name === null) continue;
    const statePath = join(devDir, entry, "state.json");
    if (!existsSync(statePath)) continue;
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    hosts.push({ name: name ?? null, ...state, running: alive(state.pid) && ownHost(state.pid) });
  }
  return hosts;
}

/** Starts a host and resolves with its state once it listens; `flags` as `parseArgs` gives them. */
export async function startTestHost(flags = {}) {
  const dir = testHostDir(flags.name);
  const statePath = join(dir, "state.json");
  if (existsSync(statePath)) {
    const previous = JSON.parse(readFileSync(statePath, "utf8"));
    if (alive(previous.pid) && ownHost(previous.pid)) throw new Error(`the test host${flags.name ? ` "${flags.name}"` : ""} is already running (pid ${previous.pid}); stop it first`);
  }
  // A device paired in an earlier run would still be listed; --fresh starts without any.
  if (flags.fresh) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const entry = join(ROOT, "dist-electron", "main", "headless.js");
  if (!existsSync(entry) || !existsSync(join(ROOT, "dist-web", "index.html"))) throw new Error("build first: npm run build");
  const workspace = flags.workspace ? resolve(flags.workspace) : undefined;
  const env = testHostEnv({ dir, name: flags.name, workspace, proxy: flags.proxy, tls: flags.tls, kits: flags.kits });
  for (const path of [env.HOME, env.TAU_USER_DATA, env.TAU_WORKSPACE, env.CODEX_HOME, env.TAU_OPENCODE_HOME, env.TAU_CURSOR_HOME, env.TAU_GROK_HOME]) mkdirSync(path, { recursive: true });
  // Pi as in an instance: the login linked, settings copied with the test model; --no-login leaves it signed out.
  if (flags.login !== false) preparePiAgentDir(env.PI_CODING_AGENT_DIR);
  else mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
  const logPath = join(dir, "host.log");
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
  const state = {
    ...(flags.name ? { name: flags.name } : {}),
    pid: child.pid,
    ...printed,
    tokenFile: env.TAU_HOST_TOKEN_FILE,
    userData: env.TAU_USER_DATA,
    workspace: env.TAU_WORKSPACE,
    home: env.HOME,
    sessionsDir: env.PI_CODING_AGENT_SESSION_DIR,
    log: logPath,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

/** Stops the host `name` by the pid in its own state file, and only if that pid still runs this worktree's host. */
export async function stopTestHost(name) {
  const statePath = join(testHostDir(name), "state.json");
  if (!existsSync(statePath)) return { stopped: null };
  const { pid } = JSON.parse(readFileSync(statePath, "utf8"));
  const running = alive(pid) && ownHost(pid);
  if (running) await stopProcess(pid);
  rmSync(statePath, { force: true });
  return { ...(name ? { name } : {}), stopped: running ? pid : null };
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === "start") return startTestHost(flags);
  if (command === "stop" && flags.all) return Promise.all(listTestHosts().map((host) => stopTestHost(host.name ?? undefined)));
  if (command === "stop") return stopTestHost(flags.name);
  if (command === "status") return readTestHost(flags.name);
  if (command === "list") return listTestHosts();
  throw new Error("usage: tau-test-host.mjs start [--name <name>] [--proxy] [--tls] [--kits] [--fresh] [--no-login] [--workspace <path>] | status [--name <name>] | stop [--name <name> | --all] | list");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify(await main(), null, 1));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
