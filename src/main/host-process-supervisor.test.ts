import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostProcessSupervisor,
  processAlive,
  pruneHostLogs,
  readHostDescriptor,
} from "./host-process-supervisor.js";

const STUB = join(import.meta.dirname, "test-support", "stub-host.mjs");
const started: HostProcessSupervisor[] = [];
const directories: string[] = [];

function workingDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "tau-supervisor-"));
  directories.push(directory);
  return directory;
}

function supervisor(userData: string, options: { version?: string; crash?: boolean; onFatal?: (failure: { message: string }) => void } = {}) {
  const instance = new HostProcessSupervisor({
    entry: STUB,
    execPath: process.execPath,
    userData,
    version: options.version ?? "1.0.0",
    startTimeoutMs: 20_000,
    restartDelayMs: 10,
    ...(options.onFatal ? { onFatal: options.onFatal } : {}),
    env: {
      ...process.env,
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

describe("the host process supervisor", () => {
  it("starts a host and records how to reach it", async () => {
    const userData = workingDirectory();
    const running = await supervisor(userData).start();

    expect(running.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/u);
    expect(running.adopted).toBe(false);
    expect(processAlive(running.pid)).toBe(true);
    const descriptor = await readHostDescriptor(userData);
    expect(descriptor).toMatchObject({ pid: running.pid, url: running.url, version: "1.0.0" });
    expect(readdirSync(join(userData, "logs")).some((name) => name.startsWith("host-"))).toBe(true);
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
    for (const name of ["host-1.log", "host-2.log", "host-3.log", "other.log"]) writeFileSync(join(directory, name), "");
    pruneHostLogs(directory, 2);
    expect(readdirSync(directory).sort()).toEqual(["host-2.log", "host-3.log", "other.log"]);
  });
});
