import { describe, expect, it } from "vitest";
import { HostLifecycleInstrumentation, summarizeLifecycle } from "./host-lifecycle.js";

describe("host lifecycle instrumentation", () => {
  it("records phase timings, subprocesses, and focused IPC bytes", () => {
    const metrics = new HostLifecycleInstrumentation();
    metrics.begin("safe", "bootstrap");
    const started = performance.now();
    metrics.phase("resources", started);
    metrics.countSubprocess();
    metrics.recordIpc({ version: 1, type: "catalog", catalog: { models: [] } });
    const measurement = metrics.end();
    expect(measurement?.phases.map((phase) => phase.name)).toContain("resources");
    expect(measurement?.subprocesses).toBe(1);
    expect(measurement?.ipcBytes).toBeGreaterThan(0);
    expect(summarizeLifecycle([measurement!])["safe:bootstrap"].p95).toBeGreaterThanOrEqual(0);
  });
});
