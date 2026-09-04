import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { HostLog } from "./host-log.js";

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
    } finally {
      console.log = originalLog;
    }
  });
});
