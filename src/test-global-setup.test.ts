import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestProject } from "vitest/node";
import setup from "./test-global-setup.js";
import { findRunProcesses } from "./main/test-support/test-processes.js";

vi.mock("./main/test-support/test-processes.js", () => ({ findRunProcesses: vi.fn() }));

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function teardown() {
  return setup({ provide: vi.fn() } as unknown as TestProject);
}

describe("global process cleanup", () => {
  it("leaves the exit code alone when no process survives", async () => {
    vi.mocked(findRunProcesses).mockReturnValue([]);
    await teardown()();
    expect(process.exitCode).toBe(originalExitCode);
  });

  it("fails the command when process enumeration fails", async () => {
    vi.mocked(findRunProcesses).mockImplementation(() => { throw new Error("enumeration refused"); });
    await expect(teardown()()).rejects.toThrow("enumeration refused");
    expect(process.exitCode).toBe(1);
  });

  it("kills only tagged survivors and fails the command after the grace period", async () => {
    vi.useFakeTimers();
    vi.mocked(findRunProcesses).mockReturnValue([{ pid: 123, command: "fixture", file: "fixture.test.ts" }]);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const result = expect(teardown()()).rejects.toThrow("fixture.test.ts");
    await vi.runAllTimersAsync();
    await result;
    expect(kill).toHaveBeenCalledExactlyOnceWith(123, "SIGKILL");
    expect(process.exitCode).toBe(1);
  });
});
