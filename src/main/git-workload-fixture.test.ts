import { describe, expect, it } from "vitest";
import { createGitWorkloadFixture, measureGitWorkload } from "./git-workload-fixture.js";

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
      expect(report.slowCommandMs).toBeLessThan(150);
      expect(report.manyProjectMaxParallelSubprocesses).toBeLessThanOrEqual(4);
      expect(report.manyProjectBranchP95Ms).toBeLessThan(250);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});
