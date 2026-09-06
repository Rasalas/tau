import { describe, expect, it } from "vitest";
import { createGitWorkloadFixture, measureGitWorkload } from "./git-workload-fixture.js";

// Wall-clock thresholds hold on an idle machine; the full suite makes them
// flaky, so they tighten only with TAU_STRICT_TIMINGS=1 (use it for benchmarks).
const strictTimings = process.env.TAU_STRICT_TIMINGS === "1";

describe("durable Git workload fixture", () => {
  it("measures the bundled coordinator against the former read fan-out", async () => {
    const fixture = await createGitWorkloadFixture(1_200);
    try {
      const report = await measureGitWorkload(fixture.cwd);
      console.info("git-workload", JSON.stringify(report));
      expect(report.files).toBeGreaterThan(1_000);
      expect(report.coordinatedSubprocesses).toBeLessThan(report.baselineSubprocesses);
      expect(report.maxParallelSubprocesses).toBeLessThanOrEqual(4);
      expect(report.bytesRead).toBeLessThan(512_000);
      expect(report.overlappingRefreshSubprocesses).toBeLessThanOrEqual(6);
      expect(report.slowCommandState).toBe("error");
      expect(report.slowCommandMs).toBeLessThan(strictTimings ? 150 : 1_500);
      expect(report.manyProjectMaxParallelSubprocesses).toBeLessThanOrEqual(4);
      expect(report.manyProjectBranchP95Ms).toBeLessThan(strictTimings ? 250 : 2_500);
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);
});
