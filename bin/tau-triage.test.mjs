import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { collectDiagnostics, parseTriageArgs, redactDiagnostics, runTriage } from "./tau-triage.mjs";
import { main } from "./tau.mjs";

const folders = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function folder() { const path = await mkdtemp(join(tmpdir(), "tau-triage-")); folders.push(path); return path; }

it("prepares diagnostics without requiring a running Tau or an agent", async () => {
  const userData = await folder();
  await mkdir(join(userData, "logs"));
  await writeFile(join(userData, "logs", "host.log"), 'startup failed api_key="private value"\n');
  const out = vi.fn();
  const code = await main(["triage", "--print", "cannot start"], { env: { TAU_USER_DATA: userData }, out });
  expect(code).toBe(0);
  const path = out.mock.calls[0][0].slice("Diagnostics: ".length);
  const report = await readFile(path, "utf8");
  expect(report).toContain("cannot start");
  expect(report).toContain("startup failed");
  expect(report).not.toContain("private value");
  expect(report).toContain("No log file.");
});

it("bounds log tails and never reads credentials or settings", async () => {
  const userData = await folder();
  await mkdir(join(userData, "logs"));
  await writeFile(join(userData, "logs", "host.log"), `not-in-tail${"x".repeat(30_000)}\nlast error`);
  await writeFile(join(userData, "auth.json"), "credentials-must-stay-private");
  const report = await collectDiagnostics({ userData });
  expect(report).toContain("last error");
  expect(report).not.toContain("not-in-tail");
  expect(report).not.toContain("credentials-must-stay-private");
  expect(report.length).toBeLessThan(26_000);
});

it("redacts credentials in JSON, headers, URLs and child-process output", () => {
  const input = 'Bearer abc123\n{"access_token":"one two","password":"three"}\nAPI_KEY=four\nhttps://example.test/?code=five&token=six\nsk-abcdefghijklmnop';
  const text = redactDiagnostics(input);
  for (const secret of ["abc123", "one two", "three", "four", "five", "six", "sk-abcdefghijklmnop"]) expect(text).not.toContain(secret);
});

it("launches the selected agent with a literal argument and preserves the report on launch failure", async () => {
  const userData = await folder(); const run = vi.fn(async () => 0);
  await runTriage(parseTriageArgs(["--agent", "claude", "broken $(touch nope)"]), { userData, run, out: () => undefined });
  expect(run).toHaveBeenCalledWith("claude", [expect.stringContaining("Read the diagnostic report")], expect.objectContaining({ env: process.env }));
  await expect(runTriage(parseTriageArgs(["--agent", "codex"]), { userData, out: () => undefined, run: async () => { throw Object.assign(new Error(), { code: "ENOENT" }); } })).rejects.toThrow(/report remains/u);
  expect(() => parseTriageArgs(["--agent", "bad"])).toThrow();
  expect(() => parseTriageArgs(["--unknown"])).toThrow();
});
