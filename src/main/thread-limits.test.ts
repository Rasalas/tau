import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiThreadLimit } from "../shared/contracts.js";
import { RESUME_MARGIN_MS, ThreadLimits } from "./thread-limits.js";

const dirs: string[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(Date.parse("2026-09-23T12:00:00Z")); });
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function bench(filePath?: string) {
  const published = new Map<string, UiThreadLimit | undefined>();
  const resumed: string[] = [];
  const limits = new ThreadLimits({
    publish: (sessionId, limit) => { published.set(sessionId, limit); },
    resume: async (sessionId) => { resumed.push(sessionId); limits.clear(sessionId); },
    log: () => undefined,
  }, filePath ? { filePath } : {});
  return { limits, published, resumed };
}

describe("ThreadLimits", () => {
  it("marks a limited thread until it runs again", () => {
    const { limits, published } = bench();
    limits.limited("t", "usage limit", Date.now() + 60 * 60_000);
    expect(published.get("t")).toEqual({ message: "usage limit", resetsAt: Date.now() + 60 * 60_000 });
    limits.clear("t");
    expect(published.get("t")).toBeUndefined();
  });

  it("continues the thread a minute after the reset, and not before", async () => {
    const { limits, published, resumed } = bench();
    const resetsAt = Date.now() + 30 * 60_000;
    limits.limited("t", "usage limit", resetsAt);
    expect(limits.resumeAtReset("t").resumeAt).toBe(resetsAt + RESUME_MARGIN_MS);
    expect(published.get("t")?.resumeAt).toBe(resetsAt + RESUME_MARGIN_MS);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(resumed).toEqual([]);
    await vi.advanceTimersByTimeAsync(RESUME_MARGIN_MS);
    expect(resumed).toEqual(["t"]);
  });

  it("drops a scheduled resume on cancel, and on a turn the user started", async () => {
    const { limits, published, resumed } = bench();
    limits.limited("a", "usage limit", Date.now() + 60_000);
    limits.limited("b", "usage limit", Date.now() + 60_000);
    limits.resumeAtReset("a");
    limits.resumeAtReset("b");
    limits.cancelResume("a");
    expect(published.get("a")).toEqual({ message: "usage limit", resetsAt: Date.now() + 60_000 });
    limits.clear("b");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(resumed).toEqual([]);
  });

  it("refuses to schedule without a reset, and resumes now on request", async () => {
    const { limits, resumed } = bench();
    limits.limited("t", "rate_limit_error");
    expect(() => limits.resumeAtReset("t")).toThrow("did not say when");
    await limits.resumeNow("t");
    expect(resumed).toEqual(["t"]);
    await expect(limits.resumeNow("t")).rejects.toThrow("not waiting");
  });

  it("keeps a scheduled resume across a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-limits-"));
    dirs.push(dir);
    const filePath = join(dir, "thread-limits.json");
    const before = bench(filePath);
    before.limits.limited("t", "usage limit", Date.now() + 5 * 60_000);
    before.limits.limited("unscheduled", "usage limit", Date.now() + 5 * 60_000);
    before.limits.resumeAtReset("t");
    await before.limits.flush();
    before.limits.freeze();

    const after = bench(filePath);
    await after.limits.restore();
    expect(after.published.get("t")?.resumeAt).toBe(Date.now() + 6 * 60_000);
    expect(after.published.has("unscheduled")).toBe(false);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(after.resumed).toEqual(["t"]);
    expect(before.resumed).toEqual([]);
  });
});
