import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { writeLargeOutsideFixture, writeLargePiFixture } from "./fixtures.js";

const NOW = Date.UTC(2026, 8, 22, 12);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

/** Reads the logs and Pi's sessions twice (cold, then from the saved caches after a restart) and sums them, in a worker. */
const ENTRY = `
import { parentPort, workerData } from "node:worker_threads";
import { getHeapStatistics } from "node:v8";
import { OutsideUsageCache } from "./outside-cache.ts";
import { summarize } from "./aggregate.ts";
import { PiUsageCache } from "./pi-sessions.ts";
let peak = 0;
const sample = setInterval(() => { peak = Math.max(peak, getHeapStatistics().used_heap_size); }, 2);
(async () => {
  const { roots, cacheFile, piCacheFile, sessionsDir, now } = workerData;
  await new OutsideUsageCache(cacheFile, () => now).refresh(roots);
  await new PiUsageCache(piCacheFile).scan(sessionsDir);
  const restarted = new OutsideUsageCache(cacheFile, () => now);
  await restarted.refresh(roots);
  const pi = await new PiUsageCache(piCacheFile).scan(sessionsDir);
  const days = Array.from({ length: 90 }, (_, index) => now - (90 - index) * 86400000);
  const summary = summarize({ scannedAt: now, sessionsDir, pi, backends: [], outside: { scan: restarted.snapshot(), errors: [] } }, { since: days[0], days });
  clearInterval(sample);
  parentPort.postMessage({ peak: Math.max(peak, getHeapStatistics().used_heap_size), requests: summary.totals.requests, totalTokens: summary.totals.totalTokens });
})().catch((error) => { parentPort.postMessage({ error: String(error?.stack ?? error) }); });
`;

async function runInWorker(data: unknown, maxOldGenerationSizeMb: number): Promise<{ peak: number; requests: number; totalTokens: number }> {
  const bundled = await build({ stdin: { contents: ENTRY, resolveDir: HERE, loader: "ts" }, bundle: true, write: false, format: "cjs", platform: "node", target: "node22", logLevel: "silent" });
  const worker = new Worker(bundled.outputFiles[0]!.text, { eval: true, workerData: data, resourceLimits: { maxOldGenerationSizeMb, maxYoungGenerationSizeMb: 16 } });
  return new Promise((resolve, reject) => {
    worker.once("message", (message: { error?: string; peak: number; requests: number; totalTokens: number }) => {
      void worker.terminate();
      if (message.error) reject(new Error(message.error)); else resolve(message);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`the worker exited (${code})`)));
  });
}

describe("reading years of CLI logs", () => {
  it("fits a small heap: nothing holds a whole file, every response or the cache as one string", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-usage-outside-memory-"));
    directories.push(root);
    const fixture = await writeLargeOutsideFixture(root, { now: NOW, days: 80 });
    const sessionsDir = join(root, "pi-sessions");
    const pi = await writeLargePiFixture(sessionsDir, { now: NOW, days: 80 });
    expect(fixture.bytes).toBeGreaterThan(200 * 1024 * 1024);
    expect(fixture.requests + pi.requests).toBeGreaterThan(400_000);
    const result = await runInWorker({ roots: fixture.roots, cacheFile: join(root, "state", "outside-usage.json"), piCacheFile: join(root, "state", "pi-usage.json"), sessionsDir, now: NOW }, 64);
    // Each response once: resumed and forked copies and oversized rows are not counted.
    expect(result.requests).toBe(fixture.requests + pi.requests);
    expect(result.totalTokens).toBe(fixture.totalTokens + pi.totalTokens);
    expect(result.peak).toBeLessThan(64 * 1024 * 1024);
  }, 180_000);
});


