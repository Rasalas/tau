#!/usr/bin/env node
// `tau app [path]`: opens a folder in the running Tau. It reads
// `<userData>/host.json`, which the window writes for the host process it
// supervises (ADR 0021), says hello with the host's token and asks Workspace
// Kit's `app-open`. Without a running host it starts the app.
// `tau service …` runs the app's `service-cli.js` with the app's own binary.
// Plain Node, no dependencies: Node 22 has a global WebSocket.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { UPDATE_WAIT_MS, describeUpdate, parseMachinesArgs, runMachines } from "./tau-machines.mjs";
import { parseKitArgs, runKit } from "./tau-kit.mjs";

/** `configureAppIdentity` in `src/main/single-instance.ts` names the folder the same way. */
export const USER_DATA_FOLDER = "tau-pi-desktop-prototype";
const PROTOCOL = 1;
const WORKSPACE_KIT = "tau.workspace";
const PACKAGES_KIT = "tau.packages";
const TIMEOUT_MS = 15_000;

export const SERVICE_ACTIONS = ["install", "status", "uninstall", "restart"];

export const USAGE = `Usage: tau app [path]
       tau service <install|status|uninstall|restart>
       tau service install --display | --no-display
       tau update [--check | --status] [--json]
       tau machines add --ssh <target> [--name <name>] [--agents] [--access full|read-only] [--json]
       tau machines list [--json]
       tau machines update <name or id> [--check | --status] [--json]
       tau machines remove <name or id> [--json]
       tau kit new <name or path> [--id <id>] [--no-host] [--install [--local]]
       tau kit types [folder]

tau app opens a folder in the running Tau with a new thread, and brings its
window to the front. Without a running Tau it starts the app on that folder.

  path   the folder to open; the current directory when left out

tau service runs Tau's host as a service of this machine: a LaunchAgent on
macOS, a systemd user unit on Linux, a Task Scheduler task on Windows. It
starts at login and keeps threads running without a window. On Linux,
--display gives it an invisible display (Xvfb): agents' shells get its
DISPLAY, and a Tau window starts there when a thread needs the preview.
--no-display removes it.

tau update updates Tau on this machine through its running host: it
downloads the release, checks it against the release's checksum, and
installs it as soon as no turn runs; a service host restarts into it.
--check only looks for a newer release, --status only tells where it stands.
tau machines update does the same on another machine, over this computer's
window's own connection there.

tau machines add pairs this computer with a machine you reach over ssh:
Tau's command line there allows it with that machine's own host token, so
nobody compares digits. tau machines --help says more.

tau kit new writes a package folder to start a kit of your own from, with the
extension API's types for your editor; tau kit --help says more.

TAU_USER_DATA names the instance, as it does for the app itself.`;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help" || command === "help") return { help: true };
  if (command === "service") {
    const [action, ...extra] = rest.filter((arg) => arg !== "--");
    if (!action || action === "-h" || action === "--help") return { help: true };
    if (!SERVICE_ACTIONS.includes(action)) throw new Error(`Unknown service action "${action}". ${USAGE}`);
    const flags = action === "install" ? extra.filter((arg) => arg === "--display" || arg === "--no-display") : [];
    if (extra.length > flags.length || flags.length > 1) {
      throw new Error(action === "install" ? "tau service install takes --display or --no-display." : `tau service ${action} takes no arguments.`);
    }
    return { command, action, flags };
  }
  if (command === "machines") return { command, machines: parseMachinesArgs(rest) };
  if (command === "kit") return { command, kit: parseKitArgs(rest) };
  if (command === "update") return { command, update: parseUpdateFlags(rest, "tau update") };
  if (command !== "app") throw new Error(`Unknown command "${command}". ${USAGE}`);
  const paths = rest.filter((arg) => arg !== "--");
  if (paths.some((arg) => arg === "-h" || arg === "--help")) return { help: true };
  if (paths.length > 1) throw new Error("tau app takes one folder.");
  return { command, path: paths[0] };
}

/** `--check`, `--status` and `--json`; install is the default. */
export function parseUpdateFlags(args, name) {
  const flags = { action: "install", json: false };
  for (const arg of args.filter((entry) => entry !== "--")) {
    if (arg === "--json") flags.json = true;
    else if ((arg === "--check" || arg === "--status") && flags.action === "install") flags.action = arg.slice(2);
    else throw new Error(`${name} takes --check or --status, and --json.`);
  }
  return flags;
}

const UPDATE_METHODS = { status: "update-status", check: "update-check", install: "update-install" };
export function reportUpdate(status, { name, json }, out) {
  if (json) out(JSON.stringify(name ? { name, update: status } : status));
  else out(`${name ? `${name}: ` : ""}Tau ${status.version}. ${describeUpdate(status)}`);
  return status.phase === "failed" || status.phase === "unsupported" ? 1 : 0;
}

/** Electron's `appData` joined with the folder the app names itself. */
export function userDataDir(env = process.env, platform = process.platform, home = homedir()) {
  if (env.TAU_USER_DATA) return resolve(env.TAU_USER_DATA);
  if (platform === "darwin") return join(home, "Library", "Application Support", USER_DATA_FOLDER);
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), USER_DATA_FOLDER);
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), USER_DATA_FOLDER);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** The host the window started, if its process still runs: `{ url, token }`. */
export function readRunningHost(userData, isAlive = alive) {
  let descriptor;
  try {
    descriptor = JSON.parse(readFileSync(join(userData, "host.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (!descriptor || typeof descriptor.url !== "string" || typeof descriptor.tokenPath !== "string") return undefined;
  if (!isAlive(descriptor.pid)) return undefined;
  let token;
  try {
    token = readFileSync(descriptor.tokenPath, "utf8").trim();
  } catch {
    return undefined;
  }
  return token ? { url: descriptor.url, token } : undefined;
}

/**
 * One connection: hello with the token, as an auxiliary client so the host
 * does not count the command line as a window. `request` sends one method
 * call and waits for its answer; a close or an error fails every waiting call.
 */
export async function openHostSession({ url, token }, WebSocketImpl = globalThis.WebSocket, options = {}) {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  if (!WebSocketImpl) throw new Error("This Node has no WebSocket; Tau's command line needs Node 22 or newer.");
  const socket = new WebSocketImpl(url);
  const pending = new Map();
  let failure;
  let next = 0;
  const settleAll = (error) => {
    failure ??= error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  socket.addEventListener("message", (event) => {
    let frame;
    try { frame = JSON.parse(String(event.data)); } catch { return; }
    const id = frame.type === "response" ? frame.response?.id : frame.id;
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    if (frame.type === "hello-reply") waiter.resolve(frame.reply);
    else if (frame.response?.error) waiter.reject(new Error(frame.response.error.message));
    else waiter.resolve(frame.response?.result);
  });
  socket.addEventListener("error", () => settleAll(new Error(`Could not reach Tau at ${url}.`)));
  // A wrong token is answered by a close.
  socket.addEventListener("close", () => settleAll(new Error("Tau closed the connection; the token in host.json may be stale.")));
  const send = (id, frame, waitMs) => new Promise((resolvePromise, reject) => {
    if (failure) { reject(failure); return; }
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Tau did not answer in time."));
    }, waitMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify(frame));
  });
  const close = () => {
    failure ??= new Error("closed");
    socket.close();
  };
  try {
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("Tau did not answer in time.")), timeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timer); resolvePromise(); });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`Could not reach Tau at ${url}.`)); });
    });
    const hello = await send("hello", { type: "hello", id: "hello", hello: { protocol: PROTOCOL, token, auxiliary: true } }, timeoutMs);
    return {
      hello,
      request(method, params = [], waitMs = timeoutMs) {
        next += 1;
        const id = `call-${next}`;
        return send(id, { type: "request", request: { id, method, params } }, waitMs);
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

/** One `host-extension` call to Workspace Kit over a session of its own. */
export async function askHost(host, command, input, WebSocketImpl = globalThis.WebSocket, options = {}) {
  const session = await openHostSession(host, WebSocketImpl, options);
  try {
    // A host no client has started yet starts on its first bootstrap, as it would for a window.
    if (options.bootstrap) await session.request("bootstrap", []);
    return await session.request("host-extension", [WORKSPACE_KIT, command, input]);
  } finally {
    session.close();
  }
}

/**
 * What starts the app: `TAU_APP` when it names a program, the Electron of a
 * built checkout this file lives in, or the bundle or binary of an installed Tau.
 */
export function appLauncher(env = process.env, self = fileURLToPath(import.meta.url), platform = process.platform) {
  if (env.TAU_APP) return { command: env.TAU_APP, args: [], cwd: process.cwd() };
  const real = realpathSync(self);
  const root = dirname(dirname(real));
  const electronPath = join(root, "node_modules", "electron", "path.txt");
  if (existsSync(electronPath) && existsSync(join(root, "dist-electron", "main", "launcher.js"))) {
    const binary = join(root, "node_modules", "electron", "dist", readFileSync(electronPath, "utf8").trim());
    return { command: binary, args: ["."], cwd: root };
  }
  // The .deb's /usr/bin/tau: the binary is two folders above the unpacked archive.
  if (platform === "linux" && basename(root) === "app.asar.unpacked") {
    const binary = join(dirname(dirname(root)), "tau");
    return existsSync(binary) ? { command: binary, args: [], cwd: dirname(binary) } : undefined;
  }
  const bundle = real.split(sep).findIndex((part) => part.endsWith(".app"));
  if (platform === "darwin" && bundle >= 0) {
    const app = real.split(sep).slice(0, bundle + 1).join(sep);
    const macos = join(app, "Contents", "MacOS");
    const executable = readdirSync(macos).find((name) => !name.startsWith("."));
    if (executable) return { command: join(macos, executable), args: [], cwd: dirname(app) };
  }
  return undefined;
}

/**
 * The app's binary and its `service-cli.js`, which runs as Node inside it:
 * from a built checkout, or from the unpacked archive of an installed Tau
 * (`asarUnpack` puts `bin/` and `dist-electron/main/` there side by side).
 */
export function serviceLauncher(self = fileURLToPath(import.meta.url), platform = process.platform) {
  const real = realpathSync(self);
  const root = dirname(dirname(real));
  const entry = join(root, "dist-electron", "main", "service-cli.js");
  if (!existsSync(entry)) return undefined;
  const electronPath = join(root, "node_modules", "electron", "path.txt");
  if (basename(root) !== "app.asar.unpacked" && existsSync(electronPath)) {
    return { command: join(root, "node_modules", "electron", "dist", readFileSync(electronPath, "utf8").trim()), entry };
  }
  if (basename(root) !== "app.asar.unpacked") return undefined;
  const contents = dirname(dirname(root));
  if (platform === "darwin") {
    const macos = join(contents, "MacOS");
    const executable = existsSync(macos) ? readdirSync(macos).find((name) => !name.startsWith(".")) : undefined;
    return executable ? { command: join(macos, executable), entry } : undefined;
  }
  const command = join(contents, platform === "win32" ? "Tau.exe" : "tau");
  return existsSync(command) ? { command, entry } : undefined;
}

function runServiceCli(launcher, action, env, flags = []) {
  const result = spawnSync(launcher.command, [launcher.entry, action, ...flags], { stdio: "inherit", env, windowsHide: true });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function launch(launcher, env) {
  const childEnv = { ...process.env, ...env };
  // Inherited from an agent's shell, this would run Electron as plain Node.
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(launcher.command, launcher.args, { cwd: launcher.cwd, env: childEnv, detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const out = io.out ?? ((line) => process.stdout.write(`${line}\n`));
  const env = io.env ?? process.env;
  const start = io.launch ?? launch;
  const options = parseArgs(argv);
  if (options.help) { out(USAGE); return 0; }
  if (options.command === "service") {
    const launcher = io.serviceLauncher ?? serviceLauncher();
    if (!launcher) throw new Error("This copy of the command line cannot find Tau's app. Run it from a built checkout (npm run build) or an installed Tau.");
    // The binary runs as Node; the userData is named, so the unit serves the same instance the app does.
    const childEnv = { ...env, ELECTRON_RUN_AS_NODE: "1", TAU_USER_DATA: userDataDir(env) };
    return (io.runService ?? runServiceCli)(launcher, options.action, childEnv, options.flags);
  }
  if (options.command === "update") {
    const host = (io.readRunningHost ?? readRunningHost)(userDataDir(env));
    if (!host) throw new Error("Tau is not running on this machine. Start it (or run tau service install), then try again.");
    const session = await (io.openSession ?? ((target) => openHostSession(target, io.WebSocket)))(host);
    try {
      const status = await session.request(UPDATE_METHODS[options.update.action], [], options.update.action === "status" ? TIMEOUT_MS : UPDATE_WAIT_MS);
      return reportUpdate(status, { json: options.update.json }, out);
    } finally {
      session.close();
    }
  }
  if (options.command === "kit") {
    return runKit(options.kit, {
      out,
      ...(io.cwd ? { cwd: io.cwd } : {}),
      ...(io.kitTypes ? { types: io.kitTypes } : {}),
      install: io.installPackage ?? (async (source, scope) => {
        const host = (io.readRunningHost ?? readRunningHost)(userDataDir(env));
        if (!host) throw new Error("Tau is not running on this machine. Start it, then type /install with the folder in its composer.");
        const session = await openHostSession(host, io.WebSocket);
        try {
          return await session.request("host-extension", [PACKAGES_KIT, "install", { source, scope }], UPDATE_WAIT_MS);
        } finally {
          session.close();
        }
      }),
    });
  }
  if (options.command === "machines") {
    const userData = userDataDir(env);
    return runMachines(options.machines, {
      out,
      readHost: () => (io.readRunningHost ?? readRunningHost)(userData),
      openSession: (host) => openHostSession(host, io.WebSocket),
      ...io.machines,
    });
  }
  const folder = resolve(io.cwd ?? process.cwd(), options.path ?? ".");
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`${folder} is not a folder.`);
  const path = realpathSync(folder);
  const userData = userDataDir(env);
  const host = (io.readRunningHost ?? readRunningHost)(userData);
  let answer;
  if (host) {
    try {
      answer = await askHost(host, "app-open", { path }, io.WebSocket)
        .catch((error) => /has not started/u.test(error.message) ? askHost(host, "app-open", { path }, io.WebSocket, { bootstrap: true, timeoutMs: 90_000 }) : Promise.reject(error));
    } catch (error) {
      if (!/Could not reach/u.test(error.message)) throw error;
    }
  }
  if (answer?.delivered) {
    out(`Opened ${answer.displayPath} in Tau.`);
    return 0;
  }
  const launcher = io.launcher ?? appLauncher(env);
  if (!launcher) throw new Error("Tau is not running, and this copy of the command line cannot find the app to start. Start Tau, then run tau app again.");
  // A running host keeps the request for the window; a new app opens the folder itself.
  start(launcher, { ...(env.TAU_USER_DATA ? { TAU_USER_DATA: env.TAU_USER_DATA } : {}), ...(answer ? {} : { TAU_WORKSPACE: path }) });
  out(answer ? `Tau's host runs without a window; opening one for ${basename(path)}.` : `Starting Tau with ${path}.`);
  return 0;
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`tau: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
