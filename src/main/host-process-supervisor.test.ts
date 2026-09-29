import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostProcessSupervisor,
  type HostServiceControl,
  parseHostAnnouncement,
  processAlive,
  pruneHostLogs,
  readHostDescriptor,
} from "./host-process-supervisor.js";
import { HOST_SERVICE_ENV, serviceEnvironment } from "./host-service-units.js";
import { DATA_FOLDER_BUSY_EXIT_CODE, dataFolderBusy } from "./data-folder-lock.js";

const STUB = join(import.meta.dirname, "test-support", "stub-host.mjs");
/** The stub takes the data folder's lock with the same module the real host uses. */
const LOCK_MODULE = join(import.meta.dirname, "process-lock.ts");
const started: HostProcessSupervisor[] = [];
const directories: string[] = [];
/** Every host a test spawned, so none outlives it unnoticed. */
const spawned: ReturnType<typeof spawn>[] = [];

function spawnStub(command: string, args: string[], env: NodeJS.ProcessEnv): ReturnType<typeof spawn> {
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  spawned.push(child);
  return child;
}

function workingDirectory(): string {
  // A space in the path, as a Windows profile often has.
  const directory = mkdtempSync(join(tmpdir(), "tau supervisor-"));
  directories.push(directory);
  return directory;
}

function supervisor(userData: string, options: {
  version?: string;
  crash?: boolean;
  silent?: boolean;
  startTimeoutMs?: number;
  restartDelayMs?: number;
  onFatal?: (failure: { message: string }) => void;
  extraEnv?: NodeJS.ProcessEnv;
  spawnProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => ReturnType<typeof spawn>;
  service?: HostServiceControl;
  serviceStartTimeoutMs?: number;
  onUrlChanged?: (url: string) => void;
  silentOwnerTimeoutMs?: number;
  signalGraceMs?: number;
} = {}) {
  const instance = new HostProcessSupervisor({
    entry: STUB,
    execPath: process.execPath,
    userData,
    version: options.version ?? "1.0.0",
    startTimeoutMs: options.startTimeoutMs ?? 20_000,
    restartDelayMs: options.restartDelayMs ?? 10,
    adoptedCheckMs: 50,
    ...(options.onFatal ? { onFatal: options.onFatal } : {}),
    ...(options.service ? { service: options.service, serviceCheckMs: 50, serviceStartTimeoutMs: options.serviceStartTimeoutMs ?? 10_000 } : {}),
    ...(options.onUrlChanged ? { onUrlChanged: options.onUrlChanged } : {}),
    ...(options.silentOwnerTimeoutMs !== undefined ? { silentOwnerTimeoutMs: options.silentOwnerTimeoutMs, silentOwnerPollMs: 50 } : {}),
    ...(options.signalGraceMs !== undefined ? { signalGraceMs: options.signalGraceMs } : {}),
    spawnProcess: options.spawnProcess ?? spawnStub,
    env: {
      ...process.env,
      ...options.extraEnv,
      STUB_VERSION: options.version ?? "1.0.0",
      STUB_TOKEN_PATH: join(userData, "token"),
      // The stub resolves `ws` from this repository, wherever its temp copy runs.
      STUB_WS_FROM: import.meta.filename,
      STUB_LOCK_FROM: LOCK_MODULE,
      ...(options.crash ? { STUB_EXIT_IMMEDIATELY: "1" } : {}),
      ...(options.silent ? { STUB_SILENT: "1" } : {}),
    },
  });
  started.push(instance);
  return instance;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function exited(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Service hosts outlive a window by design; the test that ran one stops it. */
const services: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const instance of started.splice(0)) await instance.stop().catch(() => undefined);
  for (const stop of services.splice(0)) await stop();
  const survivors = spawned.splice(0).filter((child) => !exited(child));
  for (const child of survivors) process.kill(-child.pid!, "SIGKILL");
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  expect(survivors.map((child) => child.pid), "hosts still running after stop()").toEqual([]);
});

describe("the host's announcement", () => {
  it("reads a token path with spaces and Windows line endings", () => {
    const output = "tau-host listening on ws://127.0.0.1:7788\r\ntoken: C:\\Users\\John Doe (Work)\\.tau\\host-token (copy it to the client machine, or pass it as TAU_HOST_TOKEN)\r\n";
    expect(parseHostAnnouncement(output)).toEqual({ url: "ws://127.0.0.1:7788", tokenPath: "C:\\Users\\John Doe (Work)\\.tau\\host-token" });
    expect(parseHostAnnouncement("tau-host listening on ws://127.0.0.1:1\ntoken: /home/me/.tau/host-token\n")?.tokenPath).toBe("/home/me/.tau/host-token");
    expect(parseHostAnnouncement("tau-host listening on ws://127.0.0.1:1\n")).toBeUndefined();
  });
});

describe("the host process supervisor", () => {
  it("starts a host and records how to reach it", async () => {
    const userData = workingDirectory();
    const running = await supervisor(userData).start();

    expect(running.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/u);
    expect(running.adopted).toBe(false);
    expect(processAlive(running.pid)).toBe(true);
    const descriptor = await readHostDescriptor(userData);
    expect(descriptor).toMatchObject({ pid: running.pid, url: running.url, version: "1.0.0" });
    expect(readdirSync(join(userData, "logs")).some((name) => name.startsWith("host-out-"))).toBe(true);
  }, 30_000);

  it("keeps its own host plaintext on loopback even when the window was started with TLS settings", async () => {
    const userData = workingDirectory();
    let childEnv: NodeJS.ProcessEnv = {};
    const running = await supervisor(userData, {
      extraEnv: { TAU_HOST_TLS: "1", TAU_HOST_TLS_CERT: "/nowhere/cert.pem", TAU_HOST_TLS_KEY: "/nowhere/key.pem", TAU_HOST_PROXY_LISTEN: "127.0.0.1:7789" },
      spawnProcess: (command, args, env) => {
        childEnv = env;
        return spawnStub(command, args, env);
      },
    }).start();

    expect(running.url).toMatch(/^ws:\/\/127\.0\.0\.1:/u);
    expect(childEnv.TAU_HOST_LISTEN).toMatch(/^127\.0\.0\.1:/u);
    expect(childEnv).not.toHaveProperty("TAU_HOST_TLS");
    expect(childEnv).not.toHaveProperty("TAU_HOST_TLS_CERT");
    expect(childEnv).not.toHaveProperty("TAU_HOST_TLS_KEY");
    // Network access is the host's own setting (Settings → Connections), not the window's environment.
    expect(childEnv).not.toHaveProperty("TAU_HOST_PROXY_LISTEN");
  }, 30_000);

  it("gives its host the settings a service host gets from its unit", async () => {
    const userData = workingDirectory();
    let childEnv: NodeJS.ProcessEnv = {};
    const installer = {
      TAU_HOST_ALLOWED_ORIGINS: "capacitor://localhost",
      TAU_DEV_SERVER_URL: "http://localhost:5173",
      TAU_CONFIG_FILE: "/w/.tau-dev/config.json",
      TAU_HOST_PROXY_LISTEN: "127.0.0.1:7789",
      TAU_HOST_TLS: "1",
    };
    await supervisor(userData, { extraEnv: installer, spawnProcess: (command, args, env) => { childEnv = env; return spawnStub(command, args, env); } }).start();
    const unit = serviceEnvironment({ userData, manager: "systemd", env: { ...process.env, ...installer }, path: "/usr/bin" });

    // Network access is not among them: both hosts read it from <userData>/network.json.
    for (const [key, value] of Object.entries(unit)) {
      if (key === "PATH" || key === HOST_SERVICE_ENV) continue;
      if (key === "TAU_HOST_LISTEN") { expect(childEnv[key]).toMatch(/^127\.0\.0\.1:\d+$/u); continue; }
      expect(childEnv[key], key).toBe(value);
    }
    for (const key of ["TAU_HOST_PROXY_LISTEN", "TAU_HOST_TLS", "TAU_HOST_VERSION", "TAU_WORKSPACE"]) expect(unit).not.toHaveProperty(key);
  }, 30_000);

  it("adopts a host that is already running instead of starting a second one", async () => {
    const userData = workingDirectory();
    const first = await supervisor(userData).start();
    const second = await supervisor(userData).start();

    expect(second.adopted).toBe(true);
    expect(second.pid).toBe(first.pid);
    expect(second.url).toBe(first.url);
  }, 30_000);

  it("replaces a host left behind by another version", async () => {
    const userData = workingDirectory();
    // Left behind: its window is gone, so nothing restarts it once it is retired.
    const oldWindow = supervisor(userData, { version: "1.0.0" });
    const old = await oldWindow.start();
    oldWindow.detach();
    const current = await supervisor(userData, { version: "2.0.0" }).start();

    expect(current.adopted).toBe(false);
    expect(current.pid).not.toBe(old.pid);
    await waitFor(() => !processAlive(old.pid), "the old host to stop");
  }, 30_000);

  it("starts a new host after one is killed", async () => {
    const userData = workingDirectory();
    const instance = supervisor(userData);
    const first = await instance.start();

    process.kill(first.pid, "SIGKILL");
    await waitFor(async () => (await readHostDescriptor(userData))?.pid !== first.pid, "a restarted host");
    const descriptor = await readHostDescriptor(userData);
    expect(descriptor?.pid).not.toBe(first.pid);
    expect(processAlive(descriptor!.pid)).toBe(true);
    // The window's client keeps its URL: a restart asks for the same port back.
    expect(descriptor?.url).toBe(first.url);
  }, 30_000);

  it("stops the host and forgets the descriptor", async () => {
    const userData = workingDirectory();
    const instance = supervisor(userData);
    const running = await instance.start();
    await instance.stop();

    expect(await readHostDescriptor(userData)).toBeUndefined();
    await waitFor(() => !processAlive(running.pid), "the host to stop");
  }, 30_000);

  it("restarts an adopted host after its original window left it running", async () => {
    const userData = workingDirectory();
    const original = supervisor(userData);
    const first = await original.start();
    original.detach();
    const window = supervisor(userData);
    expect(await window.start()).toMatchObject({ pid: first.pid, adopted: true });

    process.kill(first.pid, "SIGKILL");
    await waitFor(async () => {
      const descriptor = await readHostDescriptor(userData);
      return descriptor?.pid !== first.pid && descriptor !== undefined && processAlive(descriptor.pid);
    }, "the adopted host to restart", 4_000);
    expect(window.descriptor?.url).toBe(first.url);
  }, 15_000);

  it("leaves an adopted host unsupervised after the window detaches", async () => {
    const userData = workingDirectory();
    const original = supervisor(userData);
    const first = await original.start();
    original.detach();
    const window = supervisor(userData);
    await window.start();
    window.detach();

    const spawnCount = spawned.length;
    process.kill(first.pid, "SIGKILL");
    await waitFor(() => !processAlive(first.pid), "the host to exit");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(spawned).toHaveLength(spawnCount);
  }, 15_000);

  it("reports a host that will not start", async () => {
    const userData = workingDirectory();
    await expect(supervisor(userData, { crash: true }).start()).rejects.toThrow(/exited with 3/u);
  }, 30_000);

  it("ends a host that does not report its socket in time", async () => {
    const userData = workingDirectory();
    await expect(supervisor(userData, { silent: true, startTimeoutMs: 200 }).start()).rejects.toThrow(/did not report a socket/u);

    expect(spawned).toHaveLength(1);
    expect(exited(spawned[0]!)).toBe(true);
  }, 30_000);

  it("ends a host that is still starting when it is stopped", async () => {
    const userData = workingDirectory();
    const instance = supervisor(userData, { silent: true });
    const starting = instance.start();
    await waitFor(() => spawned.length === 1, "the host to be spawned");
    await instance.stop();

    await expect(starting).rejects.toThrow();
    expect(exited(spawned[0]!)).toBe(true);
  }, 30_000);

  it("starts no host once stopped, even with a restart pending", async () => {
    const userData = workingDirectory();
    // The restart is queued in the exit handler that runs before the test's own.
    const instance = supervisor(userData, { restartDelayMs: 0 });
    const first = await instance.start();
    const gone = new Promise((resolve) => spawned[0]!.once("exit", resolve));
    process.kill(first.pid, "SIGKILL");
    await gone;
    await instance.stop();

    expect(spawned).toHaveLength(1);
  }, 30_000);

  it("ends a restarted host that is still starting when it is stopped", async () => {
    const userData = workingDirectory();
    let spawns = 0;
    let stopping: Promise<void> | undefined;
    const instance = supervisor(userData, {
      spawnProcess: (command, args, env) => {
        spawns += 1;
        const child = spawnStub(command, args, spawns === 1 ? env : { ...env, STUB_SILENT: "1" });
        if (spawns === 2) setImmediate(() => { stopping = instance.stop(); });
        return child;
      },
    });
    const first = await instance.start();
    process.kill(first.pid, "SIGKILL");
    await waitFor(() => stopping !== undefined, "the restart");
    await stopping;

    expect(spawned).toHaveLength(2);
    expect(spawned.every(exited)).toBe(true);
  }, 30_000);

  it("keeps only the newest host logs", () => {
    const directory = join(workingDirectory(), "logs");
    mkdirSync(directory, { recursive: true });
    for (const name of ["host-out-1.log", "host-out-2.log", "host-out-3.log", "host-process.log"]) writeFileSync(join(directory, name), "");
    pruneHostLogs(directory, 2);
    expect(readdirSync(directory).sort()).toEqual(["host-out-2.log", "host-out-3.log", "host-process.log"]);
  });
});

/** A host nobody supervises, on `userData`, as `headless.js` started by hand is one. */
async function looseHost(userData: string, env: NodeJS.ProcessEnv = {}): Promise<{ child: ReturnType<typeof spawn>; url: string }> {
  const child = spawnStub(process.execPath, [STUB], {
    ...process.env,
    TAU_USER_DATA: userData,
    STUB_TOKEN_PATH: join(userData, "token"),
    STUB_WS_FROM: import.meta.filename,
    STUB_LOCK_FROM: LOCK_MODULE,
    ...env,
  });
  let output = "";
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      output += String(chunk);
      const announced = parseHostAnnouncement(output);
      if (announced) resolve(announced.url);
    });
    child.once("exit", (code) => reject(new Error(`the loose host exited with ${code}`)));
  });
  return { child, url };
}

async function endLoose(child: ReturnType<typeof spawn>): Promise<void> {
  const gone = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await gone;
}

describe("one host per data folder", () => {
  it("a second host on the same userData does not start, and names the first", async () => {
    const userData = workingDirectory();
    const first = await supervisor(userData).start();
    const second = spawnStub(process.execPath, [STUB], {
      ...process.env,
      TAU_USER_DATA: userData,
      STUB_TOKEN_PATH: join(userData, "token-2"),
      STUB_WS_FROM: import.meta.filename,
      STUB_LOCK_FROM: LOCK_MODULE,
    });
    let errors = "";
    second.stderr!.on("data", (chunk: Buffer) => { errors += String(chunk); });
    const code = await new Promise((resolve) => second.once("exit", resolve));

    expect(code).toBe(DATA_FOLDER_BUSY_EXIT_CODE);
    expect(errors).toContain(`pid ${first.pid}`);
    expect(processAlive(first.pid)).toBe(true);
  }, 30_000);

  it("starts no twin beside a host that holds the folder but does not answer", async () => {
    const userData = workingDirectory();
    const { child, url } = await looseHost(userData, { STUB_HANG: "1" });
    writeFileSync(join(userData, "host.json"), JSON.stringify({ pid: child.pid, url, tokenPath: join(userData, "token"), startedAt: "", version: "1.0.0" }));

    await expect(supervisor(userData, { silentOwnerTimeoutMs: 200 }).start()).rejects.toThrow(new RegExp(`pid ${child.pid}.*does not answer`, "u"));
    // The silent host is the only one that was ever spawned, and host.json still names it.
    expect(spawned).toEqual([child]);
    expect((await readHostDescriptor(userData))?.pid).toBe(child.pid);
    expect(await dataFolderBusy(userData)).toBe(true);
    await endLoose(child);
  }, 30_000);

  it("starts no twin beside a host that holds the folder and left no host.json", async () => {
    const userData = workingDirectory();
    const { child } = await looseHost(userData);

    await expect(supervisor(userData, { silentOwnerTimeoutMs: 200 }).start()).rejects.toThrow(`pid ${child.pid}`);
    expect(spawned).toEqual([child]);
    await endLoose(child);
  }, 30_000);

  it("waits for a replaced host that ignores its stop to let go of the folder, killing it if it must", async () => {
    const userData = workingDirectory();
    const { child, url } = await looseHost(userData, { STUB_VERSION: "1.0.0", STUB_STUBBORN: "1" });
    writeFileSync(join(userData, "host.json"), JSON.stringify({ pid: child.pid, url, tokenPath: join(userData, "token"), startedAt: "", version: "1.0.0" }));

    const current = await supervisor(userData, { version: "2.0.0", signalGraceMs: 200 }).start();

    expect(child.signalCode).toBe("SIGKILL");
    expect(current.adopted).toBe(false);
    expect(current.pid).not.toBe(child.pid);
  }, 30_000);
});

/**
 * A service manager in miniature: it runs the stub as a service host, which
 * takes over from the host `host.json` names the way `headless.ts` does.
 * `version` is what the unit runs now; `repairedVersion` what it runs once a
 * window pointed it at itself.
 */
function fakeService(userData: string, initial: { version: string; installed?: boolean }) {
  const state = { installed: initial.installed ?? true, version: initial.version, repairedVersion: initial.version, keepPort: true };
  const calls: string[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  const run = (version: string) => {
    child = spawnStub(process.execPath, [STUB], {
      ...process.env,
      TAU_HOST_SERVICE: "launchd",
      TAU_USER_DATA: userData,
      STUB_VERSION: version,
      STUB_TOKEN_PATH: join(userData, "token"),
      STUB_WS_FROM: import.meta.filename,
      STUB_LOCK_FROM: LOCK_MODULE,
      ...(state.keepPort ? {} : { STUB_KEEP_PORT: "0" }),
    });
    return child;
  };
  const stop = async () => {
    if (!child || exited(child)) return;
    const gone = new Promise((resolve) => child!.once("exit", resolve));
    child.kill("SIGTERM");
    await gone;
  };
  // One command at a time, as a service manager queues them.
  let queue: Promise<void> = Promise.resolve();
  const serial = (step: () => Promise<void> | void) => (queue = queue.then(step, step));
  const control: HostServiceControl = {
    installed: async () => state.installed,
    start: () => serial(() => { calls.push("start"); if (!child || exited(child)) run(state.version); }),
    restart: () => serial(async () => { calls.push("restart"); await stop(); run(state.version); }),
    repair: () => serial(async () => { calls.push("repair"); await stop(); state.version = state.repairedVersion; run(state.version); }),
  };
  services.push(stop);
  return { state, calls, control, run, stop, get child() { return child; } };
}

describe("a host a service runs", () => {
  it("is adopted, and left running when the window stops", async () => {
    const userData = workingDirectory();
    const service = fakeService(userData, { version: "1.0.0" });
    await service.control.start();
    await waitFor(async () => (await readHostDescriptor(userData))?.service === "launchd", "the service host");

    const instance = supervisor(userData, { service: service.control });
    const running = await instance.start();
    expect(running).toMatchObject({ adopted: true, service: "launchd", pid: service.child!.pid });
    await instance.stop();

    expect(processAlive(running.pid)).toBe(true);
    expect((await readHostDescriptor(userData))?.pid).toBe(running.pid);
  }, 30_000);

  it("is started when it is installed and not running, instead of a host of the window's own", async () => {
    const userData = workingDirectory();
    const service = fakeService(userData, { version: "1.0.0" });
    let spawns = 0;
    const instance = supervisor(userData, { service: service.control, spawnProcess: (command, args, env) => { spawns += 1; return spawnStub(command, args, env); } });

    const running = await instance.start();

    expect(service.calls).toEqual(["start"]);
    expect(running.service).toBe("launchd");
    expect(spawns).toBe(0);
  }, 30_000);

  it("takes over from the window's own host, and the window follows it", async () => {
    const userData = workingDirectory();
    const service = fakeService(userData, { version: "1.0.0", installed: false });
    const instance = supervisor(userData, { service: service.control });
    const own = await instance.start();
    expect(own.service).toBeUndefined();

    service.state.installed = true;
    await service.control.start();

    await waitFor(() => instance.descriptor?.service === "launchd", "the window to follow the service host");
    expect(instance.descriptor?.pid).toBe(service.child!.pid);
    // The service asked for the port the window's clients already know.
    expect(instance.descriptor?.url).toBe(own.url);
    expect(processAlive(own.pid)).toBe(false);
  }, 30_000);

  it("of an older version is restarted once and adopted when the restart brought the update", async () => {
    const userData = workingDirectory();
    const service = fakeService(userData, { version: "1.0.0" });
    await service.control.start();
    await waitFor(async () => (await readHostDescriptor(userData))?.service === "launchd", "the service host");
    // The app was updated in place: the unit's binary is 2.0.0 after a restart.
    service.state.version = "2.0.0";

    const running = await supervisor(userData, { version: "2.0.0", service: service.control }).start();

    expect(service.calls).toEqual(["start", "restart"]);
    expect(running).toMatchObject({ adopted: true, service: "launchd", pid: service.child!.pid });
  }, 30_000);

  it("that stays on another version gets one restart and one repair, then the window runs its own host", async () => {
    const userData = workingDirectory();
    const service = fakeService(userData, { version: "1.0.0" });
    await service.control.start();
    await waitFor(async () => (await readHostDescriptor(userData))?.service === "launchd", "the service host");

    const instance = supervisor(userData, { version: "2.0.0", service: service.control });
    const running = await instance.start();

    expect(service.calls).toEqual(["start", "restart", "repair"]);
    expect(running.adopted).toBe(false);
    expect(running.service).toBeUndefined();
    expect(exited(service.child!)).toBe(true);
    // A crash of the window's own host is a crash now, not a reason to try the service again.
    process.kill(running.pid, "SIGKILL");
    await waitFor(async () => { const now = await readHostDescriptor(userData); return now !== undefined && now.pid !== running.pid && processAlive(now.pid); }, "a restarted host");
    expect(service.calls).toEqual(["start", "restart", "repair"]);
  }, 60_000);

  it("is followed to another port when the service restarts it there", async () => {
    const userData = workingDirectory();
    const service = fakeService(userData, { version: "1.0.0" });
    const moved: string[] = [];
    const instance = supervisor(userData, { service: service.control, onUrlChanged: (url) => moved.push(url) });
    const running = await instance.start();

    service.state.keepPort = false;
    // Held, so the new host cannot take the old port back.
    const blocker = new (await import("ws")).WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => blocker.once("listening", resolve));
    await service.control.restart();

    await waitFor(() => moved.length === 1, "the window to be pointed at the new port");
    blocker.close();
    expect(moved[0]).not.toBe(running.url);
    expect(instance.descriptor).toMatchObject({ url: moved[0], service: "launchd" });
  }, 30_000);

  it("is replaced by a host of the window's own once the service is uninstalled", async () => {
    const userData = workingDirectory();
    const service = fakeService(userData, { version: "1.0.0" });
    const instance = supervisor(userData, { service: service.control });
    const running = await instance.start();
    expect(running.service).toBe("launchd");

    service.state.installed = false;
    await service.stop();

    await waitFor(() => instance.descriptor !== undefined && instance.descriptor.service === undefined && processAlive(instance.descriptor.pid), "a host of the window's own");
    expect(instance.descriptor!.pid).not.toBe(running.pid);
  }, 30_000);

  it("that starts nothing leaves the window a host of its own", async () => {
    const userData = workingDirectory();
    const control: HostServiceControl = { installed: async () => true, start: async () => undefined, restart: async () => undefined, repair: async () => undefined };
    const running = await supervisor(userData, { service: control, serviceStartTimeoutMs: 300 }).start();
    expect(running).toMatchObject({ adopted: false });
    expect(running.service).toBeUndefined();
  }, 30_000);
});
