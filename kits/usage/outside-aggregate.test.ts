import { describe, expect, it } from "vitest";
import { summarize, type UsageScan } from "./aggregate.js";
import type { OutsideBucket, OutsideRoot, OutsideSessionUsage, OutsideUnit } from "./outside-cache.js";
import { BACKEND_USAGE_SOURCES, OUTSIDE_LOG_SOURCES } from "./protocol.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 22, 12);
const codexSource = BACKEND_USAGE_SOURCES.find((source) => source.backend === "codex")!;
const codexRoot: OutsideRoot = { format: "codex", backend: "codex", label: "Codex", path: "/codex-home/sessions", billing: "subscription" };
const archiveRoot: OutsideRoot = { format: "codex", backend: "codex", label: "Codex", path: "/codex-home/archived_sessions", billing: "subscription" };
const claudeRoot: OutsideRoot = { format: "agent-sdk", backend: "claude-code", label: "Claude Code", path: "/claude-home/projects" };

function bucket(at: number, total = 10): OutsideBucket {
  return { at, model: "gpt-5.6-luna", provider: "openai", requests: 1, input: total, output: 0, cacheRead: 0, cacheWrite: 0, total, cost: 0 };
}

function unit(path: string, sessions: OutsideSessionUsage[], duplicates = 0): OutsideUnit {
  return { path, format: path.includes("claude") ? "agent-sdk" : "codex", size: 1, mtimeMs: 1, sessions, skipped: 0, duplicates, keys: new Float64Array() };
}

const usage = { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5, costUsd: 0, turns: 1 };

function scan(): UsageScan {
  return {
    scannedAt: NOW,
    sessionsDir: "/sessions",
    pi: { found: true, failed: 0, sessions: [] },
    backends: [{
      source: codexSource,
      answer: {
        threads: [
          // Ran in Tau, which kept its usage: the log is the same work.
          { threadId: "tau-1", sessionId: "s-tau", cwd: "/work/alpha", updatedAt: NOW - 1_000, usage },
          // Imported from the CLI: Tau kept no usage, so the log's count is the thread's.
          { threadId: "tau-2", sessionId: "s-imported", cwd: "/work/alpha", updatedAt: NOW - 1_000 },
        ],
      },
    }],
    outside: {
      errors: [{ source: OUTSIDE_LOG_SOURCES.find((source) => source.backend === "opencode")!, error: "Host extension tau.opencode is not installed" }],
      scan: {
        reading: false,
        horizon: 0,
        roots: [
          { root: codexRoot, found: true, files: 4, failed: 0 },
          { root: archiveRoot, found: true, files: 1, failed: 0 },
          { root: claudeRoot, found: false, files: 0, failed: 0 },
        ],
        units: [
          { root: codexRoot, unit: unit("/codex-home/sessions/a.jsonl", [{ sessionId: "s-tau", cwd: "/work/alpha", buckets: [bucket(NOW - 1_000)] }]) },
          { root: codexRoot, unit: unit("/codex-home/sessions/b.jsonl", [{ sessionId: "s-child", parentId: "s-tau", cwd: "/work/alpha", buckets: [bucket(NOW - 1_000)] }]) },
          { root: codexRoot, unit: unit("/codex-home/sessions/c.jsonl", [{ sessionId: "s-imported", cwd: "/elsewhere", buckets: [bucket(NOW - 2 * DAY, 7)] }]) },
          { root: codexRoot, unit: unit("/codex-home/sessions/d.jsonl", [{ sessionId: "s-cli", cwd: "/work/side", buckets: [bucket(NOW - 3 * DAY, 20), bucket(NOW - 1_000, 30)] }]) },
          // The same session again after the CLI archived it: the cache counted its responses in the first copy.
          { root: archiveRoot, unit: unit("/codex-home/archived_sessions/d.jsonl", [], 2) },
        ],
      },
    },
  };
}

describe("summarize with work outside Tau", () => {
  it("counts a Tau thread's session once, as Tau counts it, and the rest as outside Tau", () => {
    const summary = summarize(scan(), { days: [NOW - 5 * DAY, NOW - 4 * DAY, NOW - 3 * DAY, NOW - 2 * DAY, NOW - DAY] });
    expect(summary.rows.map((row) => [row.cwd, row.totalTokens, row.requests, row.outside ?? false, row.billing ?? "none"]).sort()).toEqual([
      ["/work/alpha", 5, 1, false, "none"],
      ["/work/alpha", 7, 1, false, "subscription"],
      ["/work/side", 50, 2, true, "subscription"],
    ]);
    expect(summary.totals.totalTokens).toBe(62);
    expect(summary.totals.threads).toBe(3);
    const outside = (summary.entries ?? []).filter((entry) => entry.outside);
    expect(outside.map((entry) => [entry.day, entry.threadId, entry.totalTokens]).sort()).toEqual([[2, "s-cli", 20], [4, "s-cli", 30]]);
    // The imported session's log counts for its thread, in the thread's project.
    expect(summary.entries?.find((entry) => entry.threadId === "tau-2")).toMatchObject({ cwd: "/work/alpha", totalTokens: 7 });
  });

  it("reports each CLI's logs, the sessions that were Tau's own and a kit that named none", () => {
    const summary = summarize(scan());
    const codex = summary.sources.find((source) => source.backend === "codex-outside");
    expect(codex).toMatchObject({ status: "ok", label: "Codex outside Tau", dating: "message" });
    expect(codex?.detail).toContain("1 session outside Tau in this period");
    expect(codex?.detail).toContain("3 sessions were Tau's own");
    expect(summary.sources.find((source) => source.backend === "claude-code-outside")).toMatchObject({ status: "empty", detail: "No logs at /claude-home/projects." });
    expect(summary.sources.find((source) => source.backend === "opencode-outside")?.status).toBe("unavailable");
    expect(summary.reading).toBeUndefined();
  });

  it("says a read is still under way", () => {
    const partial = scan();
    partial.outside!.scan.reading = true;
    const summary = summarize(partial);
    expect(summary.reading).toBe(true);
    expect(summary.sources.find((source) => source.backend === "codex-outside")?.status).toBe("reading");
  });

  it("counts from the period's start", () => {
    const summary = summarize(scan(), { since: NOW - DAY });
    expect(summary.rows.filter((row) => row.outside).map((row) => row.totalTokens)).toEqual([30]);
  });
});
