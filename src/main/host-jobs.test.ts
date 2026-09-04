import { describe, expect, it } from "vitest";
import { HostJobRunner } from "./host-jobs.js";
import type { HostJobEvent } from "../shared/host-transport.js";

function runner() {
  const events: HostJobEvent[] = [];
  return { events, jobs: new HostJobRunner((event) => events.push(event)) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("host jobs", () => {
  it("reports progress and then the result", async () => {
    const { events, jobs } = runner();
    const jobId = jobs.start(async (context) => {
      context.progress("half way", 0.5);
      return { path: "/tmp/x" };
    });
    await settle();
    expect(events).toEqual([
      { type: "job-progress", jobId, message: "half way", fraction: 0.5 },
      { type: "job-done", jobId, result: { path: "/tmp/x" } },
    ]);
    expect(jobs.activeCount).toBe(0);
  });

  it("turns a failure into a done event, not a thrown error", async () => {
    const { events, jobs } = runner();
    jobs.start(async () => { throw new Error("clone failed"); });
    await settle();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "job-done", error: { message: "clone failed", code: "failed" } });
  });

  it("cancels a running job once and ignores its late result", async () => {
    const { events, jobs } = runner();
    let aborted = false;
    const jobId = jobs.start(async (context) => {
      context.signal.addEventListener("abort", () => { aborted = true; });
      await settle();
      return "too late";
    });
    expect(jobs.cancel(jobId)).toBe(true);
    expect(aborted).toBe(true);
    expect(jobs.cancel(jobId)).toBe(false);
    await settle();
    await settle();
    expect(events).toEqual([{ type: "job-done", jobId, error: { message: "Cancelled.", code: "cancelled" } }]);
  });

  it("does not know a job it never started", () => {
    const { jobs } = runner();
    expect(jobs.cancel("job-9")).toBe(false);
  });

  it("drops progress reported after the job settled", async () => {
    const { events, jobs } = runner();
    let report: ((message: string) => void) | undefined;
    jobs.start(async (context) => { report = context.progress; return 1; });
    await settle();
    report?.("late");
    expect(events.filter((event) => event.type === "job-progress")).toEqual([]);
  });
});
