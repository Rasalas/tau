import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostProcessSupervisor,
  parseHostAnnouncement,
  processAlive,
  pruneHostLogs,
  readHostDescriptor,
} from "./host-process-supervisor.js";

const STUB = join(import.meta.dirname, "test-support", "stub-host.mjs");
const started: HostProcessSupervisor[] = [];
const directories: string[] = [];

function workingDirectory(): string {
  // A space in the path, as a Windows profile often has.
  const directory = mkdtempSync(join(tmpdir(), "tau supervisor-"));
  directories.push(directory);
  return directory;
}

function supervisor(userData: string, options: {
  version?: string;
  crash?: boolean;
  onFatal?: (failure: { message: string }) => void;
  extraEnv?: NodeJS.ProcessEnv;
  spawnProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => ReturnType<typeof spawn>;
} = {}) {
  const instance = new HostProcessSupervisor({
    entry: STUB,
    execPath: process.execPath,
    userData,
    version: options.version ?? "1.0.0",
    startTimeoutMs: 20_000,
    restartDelayMs: 10,
    ...(options.onFatal ? { onFatal: options.onFatal } : {}),
    ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
    env: {
      ...process.env,
      ...options.extraEnv,
      STUB_VERSION: options.version ?? "1.0.0",
      STUB_TOKEN_PATH: join(userData, "token"),
      // The stub resolves `ws` from this repository, wherever its temp copy runs.
      STUB_WS_FROM: import.meta.filename,
      ...(options.crash ? { STUB_EXIT_IMMEDIATELY: "1" } : {}),
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

afterEach(async () => {
  for (const instance of started.splice(0)) await instance.stop().catch(() => undefined);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
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
      extraEnv: { TAU_HOST_TLS: "1", TAU_HOST_TLS_CERT: "/nowhere/cert.pem", TAU_HOST_TLS_KEY: "/nowhere/key.pem" },
      spawnProcess: (command, args, env) => {
        childEnv = env;
        return spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      },
    }).start();

    expect(running.url).toMatch(/^ws:\/\/127\.0\.0\.1:/u);
    expect(childEnv.TAU_HOST_LISTEN).toMatch(/^127\.0\.0\.1:/u);
    expect(childEnv).not.toHaveProperty("TAU_HOST_TLS");
    expect(childEnv).not.toHaveProperty("TAU_HOST_TLS_CERT");
    expect(childEnv).not.toHaveProperty("TAU_HOST_TLS_KEY");
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
    const old = await supervisor(userData, { version: "1.0.0" }).start();
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

  it("reports a host that will not start", async () => {
    const userData = workingDirectory();
    await expect(supervisor(userData, { crash: true }).start()).rejects.toThrow(/exited with 3/u);
  }, 30_000);

  it("keeps only the newest host logs", () => {
    const directory = join(workingDirectory(), "logs");
    mkdirSync(directory, { recursive: true });
    for (const name of ["host-out-1.log", "host-out-2.log", "host-out-3.log", "host-process.log"]) writeFileSync(join(directory, name), "");
    pruneHostLogs(directory, 2);
    expect(readdirSync(directory).sort()).toEqual(["host-out-2.log", "host-out-3.log", "host-process.log"]);
  });
});
