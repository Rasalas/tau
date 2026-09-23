import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { findRunProcesses, TEST_FILE_VARIABLE, TEST_RUN_VARIABLE } from "./test-processes.js";

describe.runIf(process.platform === "linux" || process.platform === "darwin")("a test run's processes", () => {
  it("are found by the run's tag, with the file that started them, and no other run's are", async () => {
    const run = randomUUID();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: { ...process.env, [TEST_RUN_VARIABLE]: run, [TEST_FILE_VARIABLE]: encodeURIComponent("src/a b.test.ts") },
      stdio: "ignore",
    });
    try {
      await once(child, "spawn");
      expect(findRunProcesses(run)).toEqual([{ pid: child.pid, command: expect.stringContaining("setInterval"), file: "src/a b.test.ts" }]);
      expect(findRunProcesses(randomUUID())).toEqual([]);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
