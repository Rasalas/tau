import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage, setClientStorage } from "../../src/renderer/test-support/kit-harness.js";
import type { ClientStorage } from "tau";
import { forgetLastState, readLastState, saveLastState } from "./last-state.js";
import type { UsageEntry, UsageSummary } from "./protocol.js";

const DAY = 86_400_000;
const days = (last: number) => Array.from({ length: 90 }, (_, index) => last - (89 - index) * DAY);
const entry = (day: number, costUsd: number): UsageEntry => ({ day, backend: "pi", threadId: "t", cwd: "/w", model: "m", requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd, apiValueUsd: 0 });
const summary = (entries: UsageEntry[]): UsageSummary => ({ scannedAt: 1, totals: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, threads: 0, subscription: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, requests: 0, apiValueUsd: 0 } }, rows: [], sources: [], entries });

let storage: ClientStorage;
beforeEach(() => { storage = createMemoryStorage(); setClientStorage(storage); });
afterEach(() => { forgetLastState(); setClientStorage(undefined); });

describe("the Usage page's last state", () => {
  it("comes back after a restart, its days moved along to the ones asked for now", () => {
    const monday = Date.UTC(2026, 8, 21);
    saveLastState(undefined, { days: days(monday), summary: summary([entry(0, 1), entry(89, 2)]) });
    forgetLastState();
    // A day later: the oldest day is no longer asked for, the last one is the second to last.
    const state = readLastState(undefined, days(monday + DAY));
    expect(state?.summary?.entries).toEqual([entry(88, 2)]);
  });

  it("is kept per machine a page shows", () => {
    saveLastState("rex", { days: days(0), summary: summary([entry(0, 5)]) });
    expect(readLastState(undefined, days(0))).toBeUndefined();
    expect(readLastState("rex", days(0))?.summary?.entries).toHaveLength(1);
  });

  it("keeps the last month of a long history when the whole would not fit", () => {
    const last = Date.UTC(2026, 8, 21);
    const many = Array.from({ length: 90 * 50 }, (_, index) => ({ ...entry(index % 90, 1), threadId: `thread-${index}`, cwd: "/a/rather/long/path/to/a/project/".repeat(3) }));
    saveLastState(undefined, { days: days(last), summary: summary(many) });
    const stored = JSON.parse(storage.get("tau.usage.last")!) as { summary: UsageSummary };
    expect(stored.summary.entries!.every((item) => item.day >= 60)).toBe(true);
    expect(stored.summary.entries!.length).toBeGreaterThan(0);
  });
});
