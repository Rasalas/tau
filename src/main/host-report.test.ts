import { describe, expect, it, vi } from "vitest";
import { HostLifecycleInstrumentation } from "./host-lifecycle.js";
import { HostReport } from "./host-report.js";

describe("HostReport", () => {
  it("keeps renderer failure, full logger detail, and host.error event logging distinct", () => {
    const events: unknown[] = [];
    const logger = { error: vi.fn() };
    const report = new HostReport({
      emit: (event) => events.push(event),
      threadFor: () => undefined,
      logger: logger as never,
    });

    const error = new Error("broken");
    report.fail(error, "thread-1");

    expect(logger.error).toHaveBeenCalledWith("host.error", error);
    expect(events).toEqual([
      { type: "error", message: "broken", sessionId: "thread-1" },
      expect.objectContaining({ type: "event-log", label: "host.error", detail: "broken", sessionId: "thread-1" }),
    ]);
  });

  it("records timing separately from an ordinary event log", () => {
    const events: unknown[] = [];
    const metrics = new HostLifecycleInstrumentation();
    const report = new HostReport({ emit: (event) => events.push(event), threadFor: () => undefined }, metrics);
    metrics.begin("full", "bootstrap");

    report.runtimePhase("resources", performance.now(), "initial", "/repo");
    report.log("bootstrap.first-content");

    expect(metrics.getMeasurements()).toHaveLength(0);
    expect(events).toEqual([
      expect.objectContaining({ type: "event-log", label: "runtime.resources.ready" }),
      { type: "event-log", label: "bootstrap.first-content", detail: undefined, timestamp: expect.any(Number) },
    ]);
    metrics.end();
    expect(metrics.getMeasurements()[0]?.phases[0]?.name).toBe("resources");
  });
});
