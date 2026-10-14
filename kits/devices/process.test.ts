import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "./process.js";

// agent-device 0.21.12 serializes startup failures as message, hint and details.
const failure = JSON.parse(readFileSync(new URL("./fixtures/daemon-start-failure.json", import.meta.url), "utf8"));
const emit = (stdout: string, stderr = "", code = 1) => run(process.execPath, ["-e", "process.stdout.write(process.argv[1]); process.stderr.write(process.argv[2]); process.exitCode = Number(process.argv[3]);", stdout, stderr, String(code)]);

describe("device process diagnostics", () => {
  it("keeps the startup cause and recovery hint from a stdout fixture", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/daemon-start-failure.json", import.meta.url));
    const result = run(process.execPath, ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1])); process.exitCode = 1;", fixture]);
    await expect(result).rejects.toThrow([failure.error.message, failure.error.details.startError, failure.error.hint].join("\n"));
    await expect(result).rejects.not.toThrow("Private diagnostic output");
  });

  it("prefers structured diagnostics to unrelated stderr warnings", async () => {
    await expect(emit(JSON.stringify(failure), "Warning: tool update available")).rejects.toThrow(failure.error.hint);
  });

  it("keeps a structured reason without a recovery hint", async () => {
    await expect(emit(JSON.stringify({ success: false, error: { message: "Daemon ownership could not be verified", details: { reason: "daemon_registration_unproven" } } }))).rejects.toThrow("Daemon ownership could not be verified\ndaemon_registration_unproven");
  });

  it("accepts a message without optional diagnostics", async () => {
    await expect(emit(JSON.stringify({ success: false, error: { message: "Daemon failed" } }))).rejects.toThrow("Daemon failed");
  });

  it("ignores malformed optional fields without losing the message", async () => {
    await expect(emit(JSON.stringify({ success: false, error: { message: "Daemon failed", hint: 42, details: { reason: {}, startError: [], hint: false } } }))).rejects.toThrow(/^Daemon failed$/);
  });

  it.each(["plain stdout", "{invalid", "null", "[]", '{"success":true,"error":{"message":"ignore"}}', '{"success":false,"error":{"message":42}}', '{"success":false,"error":{"message":" "}}'])("preserves the fallback for unrecognized output %s", async (stdout) => {
    await expect(emit(stdout)).rejects.toThrow("Device command exited 1.");
    await expect(emit(stdout, "  native failure\n")).rejects.toThrow("native failure");
  });

  it("returns successful output unchanged", async () => {
    await expect(emit(JSON.stringify(failure), "warning", 0)).resolves.toEqual({ stdout: JSON.stringify(failure), stderr: "warning" });
  });
});
