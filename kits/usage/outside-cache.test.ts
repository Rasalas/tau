import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeLine, codexMeta, codexResponse } from "./fixtures.js";
import { OUTSIDE_HORIZON_MS, OutsideUsageCache, type OutsideRoot, type OutsideScan } from "./outside-cache.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const NOW = Date.UTC(2026, 8, 22, 12);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tau-usage-outside-cache-"));
  directories.push(root);
  const codexHome = join(root, "codex-home");
  const claudeHome = join(root, "claude-home");
  const rollout = join(codexHome, "sessions", "2026", "09", "20", "rollout-2026-09-20T09-00-00-x1.jsonl");
  const archived = join(codexHome, "archived_sessions", "rollout-2026-09-20T09-00-00-x1.jsonl");
  const session = join(claudeHome, "projects", "-work-beta", "c-1.jsonl");
  const agent = join(claudeHome, "projects", "-work-beta", "c-1", "subagents", "agent-a1.jsonl");
  const codex = [codexMeta("x1", "/work/alpha", NOW - 3_600_000), codexResponse(NOW - 3_000_000, "resp-1", { input: 40, output: 4 })].join("\n") + "\n";
  for (const [path, text] of [
    [rollout, codex],
    [archived, codex],
    [session, `${claudeLine({ sessionId: "c-1", cwd: "/work/beta", at: NOW - 60_000, messageId: "m1", requestId: "r1", input: 10, output: 5 })}\n`],
    [agent, `${claudeLine({ sessionId: "c-1", cwd: "/work/beta", at: NOW - 30_000, messageId: "m2", requestId: "r2", input: 1, output: 1 })}\n`],
  ] as const) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
    // Whole milliseconds, so a test can put a file's mtime back exactly.
    await utimes(path, new Date(NOW - 10_000), new Date(NOW - 10_000));
  }
  const roots: OutsideRoot[] = [
    { format: "codex", backend: "codex", label: "Codex", path: join(codexHome, "sessions"), billing: "subscription" },
    { format: "codex", backend: "codex", label: "Codex", path: join(codexHome, "archived_sessions") },
    { format: "agent-sdk", backend: "claude-code", label: "Claude Code", path: join(claudeHome, "projects") },
    { format: "agent-sdk", backend: "claude-code", label: "Claude Code", path: join(root, "no-such-home", "projects") },
  ];
  return { root, roots, rollout, archived, session, agent, cacheFile: join(root, "state", "outside-usage.json") };
}

function totals(scan: OutsideScan): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const { unit } of scan.units) for (const session of unit.sessions) for (const record of session.records) sums[session.sessionId] = (sums[session.sessionId] ?? 0) + record.total;
  return sums;
}

/** Same size, same mtime, other figures: a file the cache must not read again. */
async function tamper(path: string, from: string, to: string): Promise<void> {
  const before = await stat(path);
  await writeFile(path, (await readFile(path, "utf8")).replace(from, to));
  await utimes(path, before.atime, before.mtime);
}

describe("OutsideUsageCache", () => {
  it("reads every root, says which folders are missing, and marks a read in progress", async () => {
    const { roots, cacheFile } = await fixture();
    const cache = new OutsideUsageCache(cacheFile, () => NOW);
    const done = cache.refresh(roots);
    expect(cache.snapshot().reading).toBe(true);
    await done;
    const scan = cache.snapshot();
    expect(scan.reading).toBe(false);
    expect(scan.units).toHaveLength(4);
    expect(totals(scan)).toEqual({ x1: 88, "c-1": 17 });
    expect(scan.roots.map((report) => [report.root.path.split("/").slice(-2).join("/"), report.found, report.files])).toEqual([
      ["codex-home/sessions", true, 1],
      ["codex-home/archived_sessions", true, 1],
      ["claude-home/projects", true, 2],
      ["no-such-home/projects", false, 0],
    ]);
    expect(scan.horizon).toBe(NOW - OUTSIDE_HORIZON_MS);
  });

  it("reads a file again only when its size or mtime moved, also after a restart", async () => {
    const { roots, cacheFile, session } = await fixture();
    await new OutsideUsageCache(cacheFile, () => NOW).refresh(roots);
    await tamper(session, "\"input_tokens\":10", "\"input_tokens\":90");
    const restarted = new OutsideUsageCache(cacheFile, () => NOW);
    await restarted.refresh(roots);
    expect(totals(restarted.snapshot())["c-1"]).toBe(17);

    const later = new Date(NOW - 5_000);
    await utimes(session, later, later);
    await restarted.refresh(roots);
    expect(totals(restarted.snapshot())["c-1"]).toBe(97);
  });

  it("forgets a file that is gone and skips one older than the horizon", async () => {
    const { roots, cacheFile, agent, archived } = await fixture();
    const cache = new OutsideUsageCache(cacheFile, () => NOW);
    await cache.refresh(roots);
    await rm(agent);
    const old = new Date(NOW - OUTSIDE_HORIZON_MS - 1000);
    await utimes(archived, old, old);
    await cache.refresh(roots);
    expect(cache.snapshot().units.map(({ unit }) => unit.path)).not.toContain(agent);
    expect(cache.snapshot().units.map(({ unit }) => unit.path)).not.toContain(archived);
  });

  it("keeps counts and digests, never a word of the conversation or a raw id", async () => {
    const { roots, cacheFile } = await fixture();
    await new OutsideUsageCache(cacheFile, () => NOW).refresh(roots);
    const stored = await readFile(cacheFile, "utf8");
    expect(stored).not.toContain("never be kept");
    expect(stored).not.toContain("resp-1");
    expect(stored).not.toContain("\"m1");
  });
});
