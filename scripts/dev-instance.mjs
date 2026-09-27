// Starts an isolated Tau instance from this worktree: its own userData, its
// own scratch workspace, its own CDP port, never the real
// `~/Library/Application Support/tau`. See docs/agents/testing-the-app.md.
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
// Required from plain Node (not from inside Electron itself), the "electron"
// package's default export is the real binary's path, not the app API.
import electronBinaryPath from "electron";
import { prepareServersDir, serversInstanceEnv, startTestSshAgent } from "../kits/servers/fixtures/servers-test-env.mjs";
import { preparePiAgentDir } from "./pi-agent-shadow.mjs";

// Shared with the headless test hosts, which must not load the electron package.
export { preparePiAgentDir, withTestDefaultModel } from "./pi-agent-shadow.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEV_DIR = join(ROOT, ".tau-dev");
const PORT_BASE = 9300;
const PORT_RANGE = 100;

/** FNV-1a, folded into the port range. Same worktree path always yields the same port. */
export function derivePort(seed, { base = PORT_BASE, range = PORT_RANGE } = {}) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return base + ((hash >>> 0) % range);
}

/** Starts the instance's config as a copy of the user's, so favourites and defaults match; the real file is only read. */
export function seedConfigFile(configFile, realConfig = join(homedir(), ".tau", "config.json")) {
  if (existsSync(configFile)) return;
  let seed = "{}\n";
  try { seed = readFileSync(realConfig, "utf8"); } catch { /* no config of the user's yet */ }
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, seed);
}

/**
 * A Codex home of the instance's own: only the login is linked from the
 * user's, so the sessions, config and caches Codex writes stay under `.tau-dev`.
 */
export function prepareCodexHome(codexHome, realHome = join(homedir(), ".codex")) {
  mkdirSync(codexHome, { recursive: true });
  const link = join(codexHome, "auth.json");
  let linked = false;
  try { linked = lstatSync(link) !== undefined; } catch { /* not there yet */ }
  if (!linked && existsSync(join(realHome, "auth.json"))) symlinkSync(join(realHome, "auth.json"), link);
}

/** Whether the instance's host has a project other than `/` on disk to start in. */
export function hasSavedProject(userData) {
  try {
    const { projects } = JSON.parse(readFileSync(join(userData, "projects.json"), "utf8"));
    return Array.isArray(projects) && projects.some((project) => typeof project?.path === "string" && project.path !== "/" && existsSync(project.path));
  } catch {
    return false;
  }
}

/**
 * A test instance starts past the welcome wizard, so every run doesn't click
 * through it; `--onboarding` leaves it for tests of the wizard itself.
 */
export function seedOnboarding(userData, wanted) {
  const file = join(userData, "kit-state", "tau.onboarding", "welcome.json");
  if (wanted) {
    rmSync(file, { force: true });
    return;
  }
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ completedAt: new Date().toISOString() })}\n`);
}

/** Parses dev-instance CLI flags. Throws `Error` with a usage-shaped message on a bad flag. */
export function parseArgs(argv) {
  const options = { build: false, safe: false, fresh: false, sharedSessions: false, realAgentDir: false, asInstalled: false, onboarding: false, port: undefined, workspace: undefined, agentDir: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--build") options.build = true;
    else if (arg === "--safe") options.safe = true;
    else if (arg === "--fresh") options.fresh = true;
    else if (arg === "--shared-sessions") options.sharedSessions = true;
    else if (arg === "--real-agent-dir") options.realAgentDir = true;
    else if (arg === "--as-installed") options.asInstalled = true;
    else if (arg === "--onboarding") options.onboarding = true;
    else if (arg === "--port") {
      const value = argv[++index];
      if (!value || Number.isNaN(Number(value))) throw new Error(`--port needs a number, got ${JSON.stringify(value)}`);
      options.port = Number(value);
    } else if (arg === "--workspace") {
      const value = argv[++index];
      if (!value) throw new Error("--workspace needs a path");
      options.workspace = value;
    } else if (arg === "--agent-dir") {
      const value = argv[++index];
      if (!value) throw new Error("--agent-dir needs a path");
      options.agentDir = value;
    } else {
      throw new Error(`unknown flag ${JSON.stringify(arg)} (known: --build, --safe, --fresh, --shared-sessions, --real-agent-dir, --as-installed, --onboarding, --port <n>, --workspace <path>, --agent-dir <path>)`);
    }
  }
  if (options.asInstalled && options.workspace) throw new Error("--as-installed names no workspace; drop --workspace");
  if (options.asInstalled && options.fresh) throw new Error("--as-installed needs the history a --fresh start wipes");
  return options;
}

function isPortFree(port) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.once("listening", () => server.close(() => resolvePromise(true)));
    server.listen(port, "127.0.0.1");
  });
}

/** Scans forward from the derived port, wrapping once within the range, for one that is free. */
export async function findFreePort(seed, { base = PORT_BASE, range = PORT_RANGE, isFree = isPortFree } = {}) {
  const start = derivePort(seed, { base, range });
  for (let offset = 0; offset < range; offset += 1) {
    const candidate = base + ((start - base + offset) % range);
    if (await isFree(candidate)) return candidate;
  }
  throw new Error(`no free port in ${base}-${base + range - 1}`);
}

/** Refuses to touch anything outside `.tau-dev`; `--fresh` wipes only what this script owns. */
function assertUnderDevDir(path) {
  const resolved = resolve(path);
  const guard = resolve(DEV_DIR) + sep;
  if (resolved !== resolve(DEV_DIR) && !resolved.startsWith(guard)) {
    throw new Error(`refusing to wipe ${resolved}: it is not under ${DEV_DIR}`);
  }
}

/**
 * What `--fresh` wipes. The runtime kits keep their threads beside the Pi
 * session store (`<sessions>/../tau/*-runtime-sessions.json`); left behind, a
 * fresh instance would still list the conversations an earlier run imported.
 */
export function freshPaths({ userData, sessionsDir }) {
  return [userData, ...(sessionsDir ? [sessionsDir, join(dirname(sessionsDir), "tau")] : [])];
}

/**
 * The host runs in its own process now (ADR 0021); `<userData>/host.json` is
 * where it says so. Reading it back into `instance.json` is what lets a driver
 * stop this instance's host without ever guessing at a pid.
 */
export function readHostDescriptor(userData, { readFile = (path) => readFileSync(path, "utf8") } = {}) {
  try {
    const data = JSON.parse(readFile(join(userData, "host.json")));
    return typeof data.pid === "number" && typeof data.url === "string" ? { pid: data.pid, url: data.url } : undefined;
  } catch {
    return undefined;
  }
}

function initScratchWorkspace(workspace) {
  if (existsSync(workspace)) return;
  mkdirSync(workspace, { recursive: true });
  execFileSync("git", ["init", "-b", "main", workspace], { stdio: "ignore" });
  writeFileSync(join(workspace, "README.md"), "# Tau dev workspace\n\nScratch workspace for an isolated dev instance. Safe to edit or discard.\n");
  execFileSync("git", ["-C", workspace, "add", "README.md"], { stdio: "ignore" });
  execFileSync(
    "git",
    ["-C", workspace, "-c", "user.name=Tau Dev Instance", "-c", "user.email=tau-dev@example.invalid", "commit", "-m", "chore: init scratch workspace"],
    { stdio: "ignore" },
  );
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[dev-instance] ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const userData = join(DEV_DIR, "userdata");
  const workspace = options.workspace ? resolve(options.workspace) : join(DEV_DIR, "workspace");
  const mainEntry = join(ROOT, "dist-electron", "main", "index.js");
  // The real binary, not node_modules/.bin/electron: that file is a Node
  // shim that execs the binary as its own child and forwards signals to it.
  // A caller who stops this instance later (npm run cdp -- stop) can only
  // signal the pid spawned here directly; going through the shim leaves the
  // real process orphaned the moment the shim itself is killed, since a
  // killed process gets no chance to forward the signal it just received.
  const electronBin = electronBinaryPath;
  // Pi's own session store, isolated per instance so its threads never land
  // in the user's real ~/.pi/agent/sessions and show up in their own sidebar.
  // --shared-sessions opts back into that real store for the rare test that
  // needs the user's own threads (auth, models, settings, extensions always
  // come from the real ~/.pi/agent either way — only the sessions dir moves).
  const sessionsDir = options.sharedSessions ? undefined : join(DEV_DIR, "pi-sessions");
  // --agent-dir points PI_CODING_AGENT_DIR at a shadow directory (a test's own
  // keybindings.json, say) without touching the real ~/.pi/agent; see the
  // shadow-dir recipe in docs/agents/testing-the-app.md.
  // Without it the instance gets .tau-dev/pi-agent (see preparePiAgentDir);
  // --real-agent-dir is for the rare test that must run on the user's own.
  const agentDir = options.agentDir ? resolve(options.agentDir) : options.realAgentDir ? undefined : join(DEV_DIR, "pi-agent");
  if (agentDir && !options.agentDir) preparePiAgentDir(agentDir);
  // Settings the instance toggles land in its own copy of ~/.tau/config.json,
  // its agent worktrees and host token under .tau-dev, never in the user's real ~/.tau.
  const configFile = join(DEV_DIR, "tau-config.json");
  const worktreesDir = join(DEV_DIR, "worktrees");
  // A theme the instance saves (Appearance's editor, a VS Code import) stays here too.
  const themesDir = join(DEV_DIR, "themes");
  // Codex keeps its sessions under CODEX_HOME; a caller's own value is kept.
  const codexHome = process.env.CODEX_HOME ?? join(DEV_DIR, "codex-home");
  if (!process.env.CODEX_HOME) prepareCodexHome(codexHome);
  // OpenCode keeps its config, logins and database in the XDG folders; its kit makes this home all four.
  const openCodeHome = process.env.TAU_OPENCODE_HOME ?? join(DEV_DIR, "opencode-home");
  mkdirSync(openCodeHome, { recursive: true });
  // The Cursor CLI keeps config, chats and (with a home) its login in ~/.cursor; its kit points it here.
  const cursorHome = process.env.TAU_CURSOR_HOME ?? join(DEV_DIR, "cursor-home");
  mkdirSync(cursorHome, { recursive: true });
  // The Grok CLI keeps config, login and sessions in ~/.grok; its kit points GROK_HOME here.
  const grokHome = process.env.TAU_GROK_HOME ?? join(DEV_DIR, "grok-home");
  mkdirSync(grokHome, { recursive: true });
  // Onboarding imports the agent CLIs' earlier sessions; an instance reads fixtures only, never the user's history.
  const importRoots = process.env.TAU_IMPORT_ROOTS ?? join(DEV_DIR, "import-roots");

  if (options.fresh) {
    for (const path of freshPaths({ userData, sessionsDir })) {
      assertUnderDevDir(path);
      rmSync(path, { recursive: true, force: true });
    }
  }

  if (options.fresh) rmSync(configFile, { force: true });
  seedConfigFile(configFile);
  seedOnboarding(userData, options.onboarding);

  // Servers kit: test keys, the ssh_config (`-F`) and stubs for the keychain,
  // all under .tau-dev/servers. Never ~/.ssh, the real agent or keychain.
  const serversDir = join(DEV_DIR, "servers");
  prepareServersDir(serversDir);
  // "From a server…" makes and links projects only here, never below the real home.
  const projectsRoot = join(DEV_DIR, "projects");
  mkdirSync(projectsRoot, { recursive: true });

  if (!options.workspace) initScratchWorkspace(workspace);
  else if (!existsSync(workspace)) throw new Error(`--workspace ${workspace} does not exist`);
  // Without a project to fall back to, the host would open the real home folder.
  if (options.asInstalled && !hasSavedProject(userData)) {
    throw new Error("--as-installed needs a project in this instance's history; start it once without the flag first");
  }

  const needsBuild = options.build || !existsSync(mainEntry);
  if (needsBuild) {
    console.log("[dev-instance] building (npm run build)…");
    // `npm run build` without npm: npm is npm.cmd on Windows, which execFile cannot start.
    execFileSync(process.execPath, [join(ROOT, "scripts", "build.mjs")], { cwd: ROOT, stdio: "inherit" });
  }

  const port = options.port ?? await findFreePort(ROOT);
  if (options.port !== undefined && !(await isPortFree(options.port))) {
    console.error(`[dev-instance] port ${options.port} is already in use`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(join(DEV_DIR, "logs"), { recursive: true });
  const logPath = join(DEV_DIR, "logs", `instance-${port}.log`);
  const logFd = openSync(logPath, "a");

  let sshAgent;
  try {
    sshAgent = await startTestSshAgent(serversDir);
  } catch (error) {
    console.warn(`[dev-instance] no test ssh-agent: ${error.message}`);
  }

  const env = {
    ...process.env,
    TAU_USER_DATA: userData,
    // An app opened from the Finder names no workspace and runs from `/`.
    ...(options.asInstalled ? {} : { TAU_WORKSPACE: workspace }),
    TAU_CONFIG_FILE: configFile,
    TAU_WORKTREES_DIR: worktreesDir,
    TAU_THEMES_DIR: themesDir,
    TAU_EXTENSION_GRANTS_FILE: join(DEV_DIR, "extension-grants.json"),
    TAU_HOST_TOKEN_FILE: join(DEV_DIR, "host-token"),
    CODEX_HOME: codexHome,
    TAU_OPENCODE_HOME: openCodeHome,
    TAU_CURSOR_HOME: cursorHome,
    TAU_GROK_HOME: grokHome,
    TAU_IMPORT_ROOTS: importRoots,
    // A test instance announces and looks for the test service type, never the real `_tau._tcp`.
    TAU_BONJOUR_SERVICE_TYPE: process.env.TAU_BONJOUR_SERVICE_TYPE ?? "_tau-test._tcp",
    // An update toast clicked in a test instance must never update the machine's real CLIs.
    // Fatal errors go to the log, never a native alert on the user's screen.
    TAU_NO_NATIVE_DIALOGS: "1",
    // Its window shows and paints without taking focus from the user's app; TAU_FOREGROUND=1 overrides this.
    TAU_NO_FOCUS: "1",
    TAU_RUNTIME_UPDATE_COMMAND: process.env.TAU_RUNTIME_UPDATE_COMMAND ?? JSON.stringify({ "*": "echo 'Tau test instance: this update was not run.'" }),
    // Nor is an update offered at all; TAU_NO_RUNTIME_UPDATES=0 brings the toasts back for a test of them.
    TAU_NO_RUNTIME_UPDATES: process.env.TAU_NO_RUNTIME_UPDATES ?? "1",
    // Installing the host "as a service" in an instance writes its unit here and runs the fake
    // service manager: never a real LaunchAgent, systemd unit or scheduled task.
    TAU_SERVICE_UNIT_DIR: join(DEV_DIR, "service-units"),
    TAU_SERVICE_CONTROL: join(ROOT, "scripts", "fake-service-manager.mjs"),
    // Always the test agent's socket, even when it failed to start: a login shell only fills unset variables.
    ...serversInstanceEnv(serversDir),
    TAU_SERVERS_PROJECTS_ROOT: projectsRoot,
    // Fixture repos (scripts/remote-work-fixture.mjs) clone from their bare "origin" here; nowhere else takes `file://`.
    TAU_TEST_CLONE_ROOT: join(DEV_DIR, "remote-work"),
    ...(options.safe ? { TAU_NO_EXTENSIONS: "1" } : {}),
    ...(sessionsDir ? { PI_CODING_AGENT_SESSION_DIR: sessionsDir } : {}),
    ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
  };
  // Set in an agent's own shell, this would run Electron as plain Node
  // instead (app.whenReady never exists); each script that spawns Electron
  // must drop it itself.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SSH_AGENT_PID;

  const child = spawn(electronBin, [options.asInstalled ? ROOT : ".", `--remote-debugging-port=${port}`], {
    cwd: options.asInstalled ? sep : ROOT,
    env,
    stdio: ["ignore", logFd, logFd],
  });

  const instancePath = join(DEV_DIR, "instance.json");
  const describe = (hostDescriptor) => ({
    pid: child.pid,
    port,
    userData,
    workspace,
    sessionsDir: sessionsDir ?? null,
    agentDir: agentDir ?? null,
    hostPid: hostDescriptor?.pid ?? null,
    hostUrl: hostDescriptor?.url ?? null,
    serversDir,
    sshAgentPid: sshAgent?.owned ? sshAgent.pid : null,
    logPath,
    startedAt: new Date().toISOString(),
  });
  writeFileSync(instancePath, `${JSON.stringify(describe(undefined), null, 2)}\n`);
  // The host process writes host.json once it listens, a moment after the
  // window starts; the instance file gains its pid and URL as soon as it does.
  void (async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !child.killed) {
      const hostDescriptor = readHostDescriptor(userData);
      if (hostDescriptor) {
        writeFileSync(instancePath, `${JSON.stringify(describe(hostDescriptor), null, 2)}\n`);
        console.log(`[dev-instance] host pid=${hostDescriptor.pid} url=${hostDescriptor.url}`);
        return;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  })();
  console.log(
    `[dev-instance] pid=${child.pid} port=${port} userData=${userData} workspace=${workspace} `
    + `sessions=${sessionsDir ?? "(shared: ~/.pi/agent/sessions)"} agentDir=${agentDir ?? "(real ~/.pi/agent)"} log=${logPath}`,
  );

  const forward = (signal) => () => { if (!child.killed) child.kill(signal); };
  process.on("SIGINT", forward("SIGTERM"));
  process.on("SIGTERM", forward("SIGTERM"));

  const exitCode = await new Promise((resolvePromise) => {
    child.on("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
  });
  // Only the agent this run started, by its PID.
  if (sshAgent?.owned) sshAgent.stop();
  process.exitCode = exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
