import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionUsageIndex, readSessionFileStamp, readSessionUsage, sessionTalliesFromEntries } from "./session-usage.js";
import type { UsageTally } from "./usage-pricing.js";

/** One figure over every tally, for tests that only sum. */
function sum(tallies: readonly UsageTally[] | undefined, field: keyof Omit<UsageTally, "provider" | "model" | "billing">): number | undefined {
  return tallies?.reduce((total, tally) => total + tally[field], 0);
}

const directories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-session-usage-"));
  directories.push(directory);
  return directory;
}

function assistant(id: string, cost: number, input: number, output: number, cacheRead = 0): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      usage: {
        input, output, cacheRead, cacheWrite: 0,
        totalTokens: input + output + cacheRead,
        cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
      },
    },
  });
}

async function sessionFile(entries: string[]): Promise<string> {
  const path = join(await workspace(), "thread.jsonl");
  await writeFile(path, `${entries.join("\n")}\n`);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("session usage", () => {
  it("sums cost and tokens over the assistant messages of a session file", async () => {
    const path = await sessionFile([
      JSON.stringify({ type: "session", version: 3, id: "thread", cwd: "/project" }),
      JSON.stringify({ type: "message", id: "user", parentId: null, message: { role: "user", content: "hello" } }),
      assistant("a1", 0.25, 12_300, 2_100, 8_000),
      JSON.stringify({ type: "message", id: "tool", parentId: "a1", message: { role: "toolResult", content: "output with no usage" } }),
      assistant("a2", 0.17, 1_000, 500),
    ]);

    const result = await readSessionUsage(path);
    expect(result?.tallies).toHaveLength(1);
    expect(result?.tallies[0]).toMatchObject({
      inputTokens: 13_300,
      outputTokens: 2_600,
      cacheReadTokens: 8_000,
      cacheWriteTokens: 0,
      totalTokens: 23_900,
      turns: 2,
    });
    expect(sum(result?.tallies, "costUsd")).toBeCloseTo(0.42, 10);
    expect(result?.skipped).toBe(0);
  });

  it("reports a thread nobody was billed for as zero rather than as unreadable", async () => {
    const path = await sessionFile([JSON.stringify({ type: "session", version: 3, id: "thread", cwd: "/project" })]);
    const result = await readSessionUsage(path);
    expect(result?.tallies).toEqual([]);
    expect(result?.skipped).toBe(0);
    expect(await readSessionUsage(join(await workspace(), "missing.jsonl"))).toBeUndefined();
  });

  it("counts unparseable usage lines and does not silently treat them as zero", async () => {
    const path = await sessionFile([
      JSON.stringify({ type: "session", version: 3, id: "thread", cwd: "/project" }),
      // A valid assistant message with usage.
      assistant("a1", 0.10, 500, 100),
      // A corrupt line that mentions 'usage' but is not valid JSON.
      '{"type":"message","usage":BROKEN',
      // Another valid assistant message.
      assistant("a2", 0.20, 1_000, 200),
    ]);
    const result = await readSessionUsage(path);
    expect(result).toBeDefined();
    // Two valid turns, one skipped corrupt line.
    expect(result?.skipped).toBe(1);
    expect(sum(result?.tallies, "turns")).toBe(2);
    expect(sum(result?.tallies, "costUsd")).toBeCloseTo(0.30, 10);
  });

  it("logs IO read failures and returns undefined without hiding them", async () => {
    const warned: string[] = [];
    const logger = { warn: (msg: string, detail?: unknown) => warned.push(`${msg}: ${detail}`) };
    // ENOENT is silent (expected: thread has no file yet).
    expect(await readSessionUsage(join(await workspace(), "missing.jsonl"), { logger })).toBeUndefined();
    expect(warned).toHaveLength(0);
  });

  it("serves a cached total until the file's size and mtime move, then refills it", async () => {
    const path = await sessionFile([assistant("a1", 0.25, 1_000, 100)]);
    const resolved: number[] = [];
    const index = new SessionUsageIndex({ onResolved: (_, tallies) => resolved.push(sum(tallies, "costUsd") ?? 0) });

    expect(index.lookup(path, await readSessionFileStamp(path))).toBeUndefined();
    await index.idle();
    expect(resolved).toEqual([0.25]);

    const stamp = await readSessionFileStamp(path);
    expect(sum(index.lookup(path, stamp), "costUsd")).toBe(0.25);
    // A second lookup with the same stamp must not read the file again.
    expect(sum(index.lookup(path, stamp), "costUsd")).toBe(0.25);
    await index.idle();
    expect(resolved).toEqual([0.25]);

    await appendFile(path, `${assistant("a2", 0.5, 2_000, 200)}\n`);
    const grown = await readSessionFileStamp(path);
    expect(grown?.size).toBeGreaterThan(stamp?.size ?? 0);
    // The stale value stays visible while the refill runs.
    expect(sum(index.lookup(path, grown), "costUsd")).toBe(0.25);
    await index.idle();
    expect(resolved.map((cost) => Math.round(cost * 100))).toEqual([25, 75]);
    expect(sum(index.lookup(path, grown), "costUsd")).toBeCloseTo(0.75, 10);

    await index.dispose();
  });

  it("keeps a live runtime's own total, and reloads what it persisted", async () => {
    const directory = await workspace();
    const cachePath = join(directory, "session-usage.json");
    const path = await sessionFile([assistant("a1", 0.25, 1_000, 100)]);
    const stamp = await readSessionFileStamp(path);
    const live = [{ provider: "anthropic", model: "claude-haiku-4-5", inputTokens: 9, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10, costUsd: 9.99, turns: 4 }];

    const index = new SessionUsageIndex({ path: cachePath });
    index.record(path, stamp, live);
    expect(index.lookup(path, stamp)).toEqual(live);
    await index.dispose();

    const reopened = new SessionUsageIndex({ path: cachePath });
    await reopened.load();
    expect(reopened.lookup(path, stamp)).toEqual(live);
    await reopened.dispose();
  });

  it("forgets a session the index no longer lists", async () => {
    const path = await sessionFile([assistant("a1", 0.25, 1_000, 100)]);
    const stamp = await readSessionFileStamp(path);
    const index = new SessionUsageIndex();
    index.record(path, stamp, [{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 1, turns: 1 }]);
    index.retain([]);
    expect(index.lookup(path, undefined)).toBeUndefined();
    await index.dispose();
  });

  it("keeps one tally per provider and model, and counts a summary for the model that ran last", () => {
    const message = (provider: string, model: string, cost: number) => ({
      type: "message",
      message: { role: "assistant", provider, model, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: cost } } },
    });
    const tallies = sessionTalliesFromEntries([
      message("openai-codex", "gpt-5.6-luna", 0),
      message("anthropic", "claude-haiku-4-5", 0.1),
      { type: "compaction", usage: { input: 100, output: 10, totalTokens: 110, cost: { total: 0.2 } } },
      message("openai-codex", "gpt-5.6-luna", 0),
    ]);
    expect(tallies).toEqual([
      { provider: "openai-codex", model: "gpt-5.6-luna", inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 30, costUsd: 0, turns: 2 },
      { provider: "anthropic", model: "claude-haiku-4-5", inputTokens: 110, outputTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 125, costUsd: expect.closeTo(0.3) as number, turns: 1 },
    ]);
  });
});
