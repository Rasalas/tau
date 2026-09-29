import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendFile } from "node:fs/promises";
import { claudeLine, codexMeta, codexResponse, codexTokenCount } from "./fixtures.js";
import { OUTSIDE_HORIZON_MS, OutsideUsageCache, type OutsideRoot, type OutsideScan } from "./outside-cache.js";
import { openSqlite } from "./opencode-store.js";

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
  for (const { unit } of scan.units) for (const session of unit.sessions) for (const bucket of session.buckets) sums[session.sessionId] = (sums[session.sessionId] ?? 0) + bucket.total;
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
    // The archived copy's response was counted where it was read first.
    expect(totals(scan)).toEqual({ x1: 44, "c-1": 17 });
    expect(scan.units.find(({ unit }) => unit.path.includes("archived"))?.unit.duplicates).toBe(1);
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

  it("reads a log that grew from where the last read stopped", async () => {
    const { roots, cacheFile, session } = await fixture();
    // A first kilobyte without usage, as a log's opening lines are; the read checks it is unchanged.
    const opening = JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(1500) } });
    await writeFile(session, `${opening}\n${await readFile(session, "utf8")}`);
    const cache = new OutsideUsageCache(cacheFile, () => NOW);
    await cache.refresh(roots);
    // Same length, other figures, before the offset: a read from the offset never sees it.
    await tamper(session, "\"input_tokens\":10", "\"input_tokens\":90");
    await appendFile(session, `${claudeLine({ sessionId: "c-1", cwd: "/work/beta", at: NOW - 20_000, messageId: "m3", requestId: "r3", input: 100, output: 0 })}\n`);
    const restarted = new OutsideUsageCache(cacheFile, () => NOW);
    await restarted.refresh(roots);
    expect(totals(restarted.snapshot())["c-1"]).toBe(117);
  });

  it("reads a log written anew from its start", async () => {
    const { roots, cacheFile, session } = await fixture();
    const cache = new OutsideUsageCache(cacheFile, () => NOW);
    await cache.refresh(roots);
    await writeFile(session, [
      claudeLine({ sessionId: "c-1", cwd: "/work/beta", at: NOW - 60_000, messageId: "n1", requestId: "q1", input: 50, output: 5 }),
      claudeLine({ sessionId: "c-1", cwd: "/work/beta", at: NOW - 50_000, messageId: "n2", requestId: "q2", input: 50, output: 5 }),
    ].join("\n") + "\n");
    await cache.refresh(roots);
    expect(totals(cache.snapshot())["c-1"]).toBe(112);
  });

  it("counts a copy once the log it copied is gone", async () => {
    const { roots, cacheFile, rollout } = await fixture();
    const cache = new OutsideUsageCache(cacheFile, () => NOW);
    await cache.refresh(roots);
    await rm(rollout);
    await cache.refresh(roots);
    const scan = cache.snapshot();
    expect(totals(scan).x1).toBe(44);
    expect(scan.units.find(({ unit }) => unit.path.includes("archived"))?.unit.duplicates).toBe(0);
  });

  it("drops counters a later response record of a grown rollout covers", async () => {
    const { roots, cacheFile, rollout } = await fixture();
    await writeFile(rollout, [
      codexMeta("x1", "/work/alpha", NOW - 3_600_000),
      codexTokenCount(NOW - 3_000_000, { input: 10, output: 1 }, { input: 10, output: 1 }),
      codexTokenCount(NOW - 1_000_000, { input: 20, output: 2 }, { input: 30, output: 3 }),
    ].join("\n") + "\n");
    const cache = new OutsideUsageCache(cacheFile, () => NOW);
    await cache.refresh(roots.slice(0, 1));
    expect(totals(cache.snapshot()).x1).toBe(33);
    // A newer CLI took over: its record is dated before the last counter counted.
    await appendFile(rollout, `${codexResponse(NOW - 2_000_000, "resp-9", { input: 40, output: 4 })}\n`);
    await cache.refresh(roots.slice(0, 1));
    expect(totals(cache.snapshot()).x1).toBe(11 + 44);
  });

  it("reads an OpenCode database past its final rows, and the recent ones again", async () => {
    if (!await openSqlite()) return;
    const { root, cacheFile } = await fixture();
    const home = join(root, "opencode-data");
    await mkdir(home, { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(home, "opencode.db"));
    db.exec("CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, parent_id text)");
    db.exec("CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)");
    db.prepare("INSERT INTO session VALUES ('ses-a', '/work/gamma', NULL)").run();
    const data = (input: number, at: number) => JSON.stringify({ role: "assistant", providerID: "anthropic", modelID: "claude-haiku-4-5", tokens: { input, output: 0 }, time: { created: at } });
    const insert = db.prepare("INSERT INTO message VALUES (?, 'ses-a', ?, ?, ?)");
    const old = NOW - 3 * 86_400_000;
    insert.run("m-old", old, old, data(100, old));
    insert.run("m-new", NOW - 60_000, NOW - 60_000, data(1, NOW - 60_000));
    const roots: OutsideRoot[] = [{ format: "opencode", backend: "opencode", label: "OpenCode", path: home }];
    const cache = new OutsideUsageCache(cacheFile, () => NOW);
    await cache.refresh(roots);
    expect(totals(cache.snapshot())["ses-a"]).toBe(101);
    // A final row is not read again; a recent one is, with what it holds now; a new one is added.
    db.prepare("UPDATE message SET data = ? WHERE id = 'm-old'").run(data(900, old));
    db.prepare("UPDATE message SET data = ? WHERE id = 'm-new'").run(data(5, NOW - 60_000));
    insert.run("m-next", NOW - 30_000, NOW - 30_000, data(10, NOW - 30_000));
    const restarted = new OutsideUsageCache(cacheFile, () => NOW);
    await restarted.refresh(roots);
    expect(totals(restarted.snapshot())["ses-a"]).toBe(115);
    // Rows numbered anew (the final row's number now holds another): everything is read again.
    db.exec("DELETE FROM message WHERE id = 'm-old'");
    insert.run("m-late", NOW - 10_000, NOW - 10_000, data(1000, NOW - 10_000));
    db.exec("VACUUM");
    db.close();
    await restarted.refresh(roots);
    expect(totals(restarted.snapshot())["ses-a"]).toBe(1015);
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
