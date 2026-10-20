import { describe, expect, it, vi } from "vitest";
import { HostLifecycleInstrumentation, summarizeLifecycle } from "./host-lifecycle.js";

describe("host lifecycle instrumentation", () => {
  it("records phase timings, subprocesses, and focused IPC bytes", () => {
    const metrics = new HostLifecycleInstrumentation({ measureIpc: true });
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

  it("leaves replies unserialized unless asked, and keeps only recent measurements", () => {
    const metrics = new HostLifecycleInstrumentation({ measureIpc: false });
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      for (let run = 0; run < 150; run += 1) {
        metrics.begin("full", "warm-switch");
        metrics.recordIpc({ version: 1, type: "catalog", catalog: { models: [] } });
        metrics.end();
      }
      expect(stringify).not.toHaveBeenCalled();
    } finally { stringify.mockRestore(); }
    expect(metrics.getMeasurements()).toHaveLength(100);
    expect(metrics.getMeasurements()[0]?.ipcBytes).toBe(0);
  });
});
