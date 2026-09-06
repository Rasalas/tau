// Starts an isolated Tau instance from this worktree: its own userData, its
// own scratch workspace, its own CDP port, never the real
// `~/Library/Application Support/tau`. See docs/agents/testing-the-app.md.
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
// Required from plain Node (not from inside Electron itself), the "electron"
// package's default export is the real binary's path, not the app API.
import electronBinaryPath from "electron";

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

/** Parses dev-instance CLI flags. Throws `Error` with a usage-shaped message on a bad flag. */
export function parseArgs(argv) {
  const options = { build: false, safe: false, fresh: false, sharedSessions: false, port: undefined, workspace: undefined, agentDir: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--build") options.build = true;
    else if (arg === "--safe") options.safe = true;
    else if (arg === "--fresh") options.fresh = true;
    else if (arg === "--shared-sessions") options.sharedSessions = true;
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
      throw new Error(`unknown flag ${JSON.stringify(arg)} (known: --build, --safe, --fresh, --shared-sessions, --port <n>, --workspace <path>, --agent-dir <path>)`);
    }
  }
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
  const agentDir = options.agentDir ? resolve(options.agentDir) : undefined;

  if (options.fresh) {
    assertUnderDevDir(userData);
    rmSync(userData, { recursive: true, force: true });
    if (sessionsDir) {
      assertUnderDevDir(sessionsDir);
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  }

  if (!options.workspace) initScratchWorkspace(workspace);
  else if (!existsSync(workspace)) throw new Error(`--workspace ${workspace} does not exist`);

  const needsBuild = options.build || !existsSync(mainEntry);
  if (needsBuild) {
    console.log("[dev-instance] building (npm run build)…");
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
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

  const env = {
    ...process.env,
    TAU_USER_DATA: userData,
    TAU_WORKSPACE: workspace,
    ...(options.safe ? { TAU_NO_EXTENSIONS: "1" } : {}),
    ...(sessionsDir ? { PI_CODING_AGENT_SESSION_DIR: sessionsDir } : {}),
    ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
  };
  // Set in an agent's own shell, this would run Electron as plain Node
  // instead (app.whenReady never exists); each script that spawns Electron
  // must drop it itself.
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronBin, [".", `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    env,
    stdio: ["ignore", logFd, logFd],
  });

  writeFileSync(
    join(DEV_DIR, "instance.json"),
    `${JSON.stringify({ pid: child.pid, port, userData, workspace, sessionsDir: sessionsDir ?? null, agentDir: agentDir ?? null, logPath, startedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  console.log(
    `[dev-instance] pid=${child.pid} port=${port} userData=${userData} workspace=${workspace} `
    + `sessions=${sessionsDir ?? "(shared: ~/.pi/agent/sessions)"} agentDir=${agentDir ?? "(default: ~/.pi/agent)"} log=${logPath}`,
  );

  const forward = (signal) => () => { if (!child.killed) child.kill(signal); };
  process.on("SIGINT", forward("SIGTERM"));
  process.on("SIGTERM", forward("SIGTERM"));

  const exitCode = await new Promise((resolvePromise) => {
    child.on("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
  });
  process.exitCode = exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
