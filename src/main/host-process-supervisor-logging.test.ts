import { ChildProcess } from "node:child_process";
import { chmodSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { DATA_FOLDER_BUSY_EXIT_CODE } from "./data-folder-lock.js";
import { HostProcessSupervisor, readHostDescriptor } from "./host-process-supervisor.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});

it.skipIf(process.platform === "win32")("keeps the window's supervisor running when its log directory is read-only", async () => {
  const userData = mkdtempSync(join(tmpdir(), "tau-supervisor-logging-"));
  const logDirectory = join(userData, "logs");
  mkdirSync(logDirectory, { mode: 0o500 });
  const tokenPath = join(userData, "token");
  writeFileSync(tokenPath, "test-token");
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdout, stderr });
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const onFatal = vi.fn();
  let spawned!: () => void;
  const spawning = new Promise<void>((resolve) => { spawned = resolve; });
  const instance = new HostProcessSupervisor({
    entry: "unused", execPath: process.execPath, userData, version: "1.0.0", logger, onFatal,
    spawnProcess: () => { spawned(); return child; },
  });
  try {
    const starting = instance.start();
    void starting.catch(() => undefined);
    await spawning;
    const stream = vi.mocked(createWriteStream).mock.results.at(-1)!.value as ReturnType<typeof createWriteStream>;
    const handledBySupervisor = stream.listenerCount("error") > 0;
    // Observe the failed open even on a broken supervisor, so the regression fails promptly.
    stream.on("error", () => undefined);
    const closed = new Promise<void>((resolve) => stream.once("close", resolve));
    stdout.write(`tau-host listening on ws://127.0.0.1:7788\ntoken: ${tokenPath}\n`);
    const running = await starting;
    await closed;

    expect(handledBySupervisor).toBe(true);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("host-process.log-write-failed", {
      path: expect.stringContaining("host-out-"), error: expect.stringContaining("EACCES"),
    });
    const write = vi.spyOn(stream, "write");
    expect(() => stream.emit("error", new Error("another write failure"))).not.toThrow();
    stdout.write("more output\n");
    stderr.write("more errors\n");
    expect(write).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(onFatal).not.toHaveBeenCalled();
    expect(instance.descriptor).toEqual(running);
    expect(await readHostDescriptor(userData)).toMatchObject({ url: running.url });
  } finally {
    instance.detach();
    child.emit("exit", 0, null);
    chmodSync(logDirectory, 0o700);
    rmSync(userData, { recursive: true, force: true });
  }
});

function fakeHost() {
  const userData = mkdtempSync(join(tmpdir(), "tau-supervisor-logging-"));
  const tokenPath = join(userData, "token");
  writeFileSync(tokenPath, "test-token");
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdout, stderr });
  let spawned!: () => void;
  const spawning = new Promise<void>((resolve) => { spawned = resolve; });
  const instance = new HostProcessSupervisor({
    entry: "unused", execPath: process.execPath, userData, version: "1.0.0",
    spawnProcess: () => { spawned(); return child; },
  });
  return { userData, tokenPath, child, stdout, stderr, spawning, instance };
}

const flushed = () => new Promise((resolve) => setImmediate(resolve));

it("stops reading the host's output for an announcement once it has one, and logs its last stderr after the exit", async () => {
  const host = fakeHost();
  try {
    const starting = host.instance.start();
    await host.spawning;
    const stream = vi.mocked(createWriteStream).mock.results.at(-1)!.value as ReturnType<typeof createWriteStream>;
    host.stdout.write(`tau-host listening on ws://127.0.0.1:7788\ntoken: ${host.tokenPath}\n`);
    await starting;
    expect(host.stdout.listenerCount("data")).toBe(1);
    host.stdout.write("later output\n");
    host.instance.detach();
    host.child.emit("exit", 1, null);
    host.stderr.write("Error: the crash stack\n");
    await flushed();
    const finished = new Promise<void>((resolve) => stream.once("finish", resolve));
    host.child.emit("close", 1, null);
    await finished;
    const log = readFileSync(String(stream.path), "utf8");
    expect(log).toContain("later output");
    expect(log).toContain("the crash stack");
  } finally {
    rmSync(host.userData, { recursive: true, force: true });
  }
});

it("names the folder's owner from stderr that arrives after the exit", async () => {
  const host = fakeHost();
  try {
    const starting = host.instance.start();
    await host.spawning;
    host.child.emit("exit", DATA_FOLDER_BUSY_EXIT_CODE, null);
    host.stderr.write("Another Tau host (pid 42) owns this data folder\n");
    await flushed();
    host.child.emit("close", DATA_FOLDER_BUSY_EXIT_CODE, null);
    await expect(starting).rejects.toThrow("Tau's host did not start: Another Tau host (pid 42) owns this data folder.");
  } finally {
    rmSync(host.userData, { recursive: true, force: true });
  }
});
