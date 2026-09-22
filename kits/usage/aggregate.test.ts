import { describe, expect, it } from "vitest";
import { summarize, type UsageScan } from "./aggregate.js";
import type { PiSessionUsage, PiUsageRecord } from "./pi-sessions.js";
import { BACKEND_USAGE_SOURCES } from "./protocol.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 22, 12);
const [claude, antigravity] = BACKEND_USAGE_SOURCES as [typeof BACKEND_USAGE_SOURCES[number], typeof BACKEND_USAGE_SOURCES[number]];

function response(key: string, at: number, model = "anthropic/claude-haiku-4-5", tokens = 100, cost = 0.01): PiUsageRecord {
  return { key, at, model, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens, cost, requests: 1 };
}

function session(sessionId: string, cwd: string, createdAt: number, records: PiUsageRecord[]): PiSessionUsage {
  return { path: `/sessions/${sessionId}.jsonl`, size: 1, mtimeMs: 1, sessionId, cwd, createdAt, records, skippedLines: 0 };
}

function scan(overrides: Partial<UsageScan> = {}): UsageScan {
  return {
    scannedAt: NOW,
    sessionsDir: "/sessions",
    pi: {
      found: true,
      failed: 0,
      sessions: [
        session("old", "/work/alpha", NOW - 40 * DAY, [response("a1", NOW - 40 * DAY), response("a2", NOW - 3 * DAY)]),
        // A fork copies its parent's entries; only the response it added is its own.
        session("fork", "/work/alpha", NOW - 2 * DAY, [response("a1", NOW - 40 * DAY), response("a2", NOW - 3 * DAY), response("f1", NOW - 1_000, "openai/gpt-5.6-luna", 50, 0)]),
        session("beta", "/work/beta", NOW - DAY, [response("b1", NOW - 2_000, "anthropic/claude-haiku-4-5", 1_000, 0.1)]),
      ],
    },
    backends: [
      {
        source: claude,
        answer: {
          threads: [
            { threadId: "c-recent", cwd: "/work/alpha", model: "claude-haiku-4-5", updatedAt: NOW - 3_000, usage: { inputTokens: 40, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 44, costUsd: 0.2, turns: 2 } },
            { threadId: "c-old", cwd: "/work/alpha", updatedAt: NOW - 10 * DAY, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd: 0, turns: 1 } },
            { threadId: "c-bare", cwd: "/work/alpha", updatedAt: NOW - 3_000 },
          ],
        },
      },
      { source: antigravity, error: "Host extension tau.antigravity is not installed" },
    ],
    ...overrides,
  };
}

describe("summarize", () => {
  it("counts a response a fork copied once, for the session it was written to first", () => {
    const summary = summarize(scan());
    const pi = summary.rows.filter((row) => row.backend === "pi");
    const alphaHaiku = pi.find((row) => row.cwd === "/work/alpha" && row.model === "anthropic/claude-haiku-4-5");
    expect(alphaHaiku).toMatchObject({ requests: 2, totalTokens: 200, threads: 1, projectName: "alpha" });
    expect(pi.find((row) => row.model === "openai/gpt-5.6-luna")).toMatchObject({ requests: 1, totalTokens: 50, threads: 1 });
    // Three Pi sessions and two backend threads with usage; the bare one kept none.
    expect(summary.totals).toMatchObject({ threads: 5, requests: 2 + 1 + 1 + 2 + 1, totalTokens: 200 + 50 + 1_000 + 44 + 2 });
    expect(summary.totals.costUsd).toBeCloseTo(0.02 + 0.1 + 0.2);
  });

  it("filters Pi by each response's time and a backend by its thread's last activity", () => {
    const today = summarize(scan(), { since: NOW - 12 * 60 * 60 * 1000 });
    expect(today.since).toBe(NOW - 12 * 60 * 60 * 1000);
    expect(today.rows.map((row) => `${row.backend} ${row.projectName} ${row.model} ${row.requests}`).sort()).toEqual([
      "claude-code alpha claude-haiku-4-5 2",
      "pi alpha openai/gpt-5.6-luna 1",
      "pi beta anthropic/claude-haiku-4-5 1",
    ]);

    const week = summarize(scan(), { since: NOW - 7 * DAY });
    expect(week.totals.requests).toBe(1 + 1 + 1 + 2);
    expect(week.rows.find((row) => row.backend === "pi" && row.cwd === "/work/alpha" && row.model.includes("haiku"))?.requests).toBe(1);

    expect(summarize(scan(), { since: NOW + DAY }).rows).toEqual([]);
  });

  it("orders rows by cost, then tokens, and names projects the way it is told", () => {
    const summary = summarize(scan(), { nameOf: (cwd) => cwd === "/work/beta" ? "Beta project" : undefined });
    expect(summary.rows[0]).toMatchObject({ backend: "claude-code", costUsd: 0.2 });
    expect(summary.rows.find((row) => row.cwd === "/work/beta")?.projectName).toBe("Beta project");
    expect(summary.rows.find((row) => row.cwd === "/work/alpha")?.projectName).toBe("alpha");
  });

  it("says honestly which source had nothing, and which could not be asked", () => {
    const summary = summarize(scan(), { since: NOW - 7 * DAY });
    expect(summary.sources.map((source) => [source.backend, source.status, source.dating])).toEqual([
      ["pi", "ok", "message"],
      ["claude-code", "ok", "thread"],
      ["antigravity", "unavailable", "thread"],
    ]);
    expect(summary.sources[0]?.detail).toContain("Read 3 session files in /sessions; 3 threads with usage in this period");
    expect(summary.sources[1]?.detail).toContain("3 threads on record; 1 thread with usage in this period; 1 thread kept no usage");
    expect(summary.sources[2]?.detail).toBe("Not available: Host extension tau.antigravity is not installed.");

    const nothing = summarize(scan({ pi: { found: false, failed: 0, sessions: [] }, backends: [{ source: claude, answer: { threads: [] } }] }));
    expect(nothing.rows).toEqual([]);
    expect(nothing.totals.threads).toBe(0);
    expect(nothing.sources.map((source) => [source.status, source.detail])).toEqual([
      ["empty", "No Pi session directory at /sessions."],
      ["empty", "No Claude Code threads yet."],
    ]);
  });
});
