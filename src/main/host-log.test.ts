import { appendFile, chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostLog } from "./host-log.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, appendFile: vi.fn(fs.appendFile) };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await chmod(path, 0o700).catch(() => undefined);
    await rm(path, { recursive: true, force: true });
  }));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tau-host-log-"));
  temporaryDirectories.push(dir);
  return dir;
}

describe("HostLog", () => {
  it("writes a line per level with an ISO timestamp and the level name", async () => {
    const dir = await tempDir();
    const log = new HostLog({ dir });

    log.debug("starting up");
    log.info("host ready");
    log.warn("slow start", { ms: 900 });
    log.error("host crashed", new Error("boom"));

    await log.flush();

    const contents = await readFile(log.filePath, "utf8");
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z DEBUG starting up$/);
    expect(lines[1]).toMatch(/INFO host ready$/);
    expect(lines[2]).toMatch(/WARN slow start \{"ms":900\}$/);
    expect(lines[3]).toMatch(/ERROR host crashed \{"name":"Error","message":"boom","stack":/);
  });

  it("rotates to <file>.1 once the log crosses the byte threshold and keeps only one backup", async () => {
    const dir = await tempDir();
    const log = new HostLog({ dir, maxBytes: 50 });

    for (let i = 0; i < 10; i++) log.info(`line ${i} padded with enough text to cross the threshold quickly`);

    await log.flush();

    const rotated = `${log.filePath}.1`;
    const currentSize = (await readFile(log.filePath, "utf8")).length;
    const rotatedSize = (await readFile(rotated, "utf8")).length;
    expect(currentSize).toBeGreaterThan(0);
    expect(rotatedSize).toBeGreaterThan(0);
  });

  it("never throws when the log directory cannot be created or written", async () => {
    if (platform() === "win32") return; // chmod-based unwritable dirs are not meaningful on Windows.
    const parent = await tempDir();
    const unwritable = join(parent, "locked");
    await mkdir(unwritable);
    await chmod(unwritable, 0o400);
    if (process.getuid?.() === 0) return; // root ignores the permission bit; nothing to assert.
    const dir = join(unwritable, "logs");

    const log = new HostLog({ dir });
    expect(() => log.info("should not throw")).not.toThrow();
    expect(() => log.error("still should not throw", new Error("x"))).not.toThrow();
    await log.flush();
  });

  it("mirrors to the console only when asked", async () => {
    const dir = await tempDir();
    const calls: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => { calls.push(line); };
    try {
      const silent = new HostLog({ dir, mirrorToConsole: false });
      silent.info("quiet");
      expect(calls).toHaveLength(0);

      const loud = new HostLog({ dir, fileName: "loud.log", mirrorToConsole: true });
      loud.info("loud");
      expect(calls.some((line) => line.includes("loud"))).toBe(true);
      await Promise.all([silent.flush(), loud.flush()]);
    } finally {
      console.log = originalLog;
    }
  });

  it("batches a burst without issuing file writes on the caller's stack", async () => {
    const log = new HostLog({ dir: await tempDir(), mirrorToConsole: false });
    vi.mocked(appendFile).mockClear();
    for (let index = 0; index < 1_000; index++) log.info(`burst ${index}`);
    expect(appendFile).not.toHaveBeenCalled();
    await log.flush();
    expect(vi.mocked(appendFile).mock.calls.length).toBeLessThan(10);
    const lines = (await readFile(log.filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1_000);
    expect(lines[0]).toContain("burst 0");
    expect(lines.at(-1)).toContain("burst 999");
  });

  it("bounds queued output while a disk write is stalled and resumes afterwards", async () => {
    const log = new HostLog({ dir: await tempDir(), mirrorToConsole: false });
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((done) => { release = done; });
    const entered = new Promise<void>((done) => { started = done; });
    vi.mocked(appendFile).mockImplementationOnce(async () => { started(); await blocked; });
    log.info("first write");
    await entered;
    for (let index = 0; index < 100; index++) log.info("x".repeat(32 * 1024));
    release();
    await log.flush();
    const contents = await readFile(log.filePath, "utf8");
    expect(Buffer.byteLength(contents)).toBeLessThan(2 * 1024 * 1024 + 200);
    expect(contents).toMatch(/log.backpressure \d+ lines dropped/);
    log.info("resumed");
    await log.flush();
    expect(await readFile(log.filePath, "utf8")).toContain("INFO resumed");
  });
});
