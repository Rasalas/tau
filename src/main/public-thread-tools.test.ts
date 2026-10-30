import { describe, expect, it } from "vitest";
import type { UiToolRun } from "../shared/contracts.js";
import { publicThreadTools } from "./public-thread-tools.js";

const call = (name: string, rest: Partial<UiToolRun> = {}): UiToolRun => ({ id: "PRIVATE ID", name, status: "done", args: { password: "PRIVATE INPUT", command: "PRIVATE COMMAND" }, startedAt: 123, output: "Visible text", ...rest });
describe("public host tool contract", () => {
  it("exports names/status only without opt-in, dropping every other field", () => {
    expect(publicThreadTools([call("bash"), call("custom_tool", { status: "running" }), call("read", { status: "error" })], { includeOutput: false })).toEqual({ tools: [{ name: "bash", status: "done" }, { name: "custom_tool", status: "running" }, { name: "read", status: "error" }], truncated: false });
  });
  it("never exports private secret tools, including MCP aliases, or unbounded names", () => {
    const names = ["request_secret", "request_secret_file", "release_secret_file", "mcp__tau__request_secret_file", "functions.request_secret", "auth_credentials", "mcp__other__token", "bad\nname", "x".repeat(129)];
    expect(publicThreadTools(names.map((name) => call(name)), { includeOutput: true }).tools).toEqual([]);
  });
  it("never exports hidden/custom responses, diffs, lazy output, media, extras or delegation results", () => {
    const calls = [call("computer_use_window"), call("mcp__server__tool"), call("edit"), call("write"), call("custom_tool"), call("bash", { outputDeferred: true }), call("bash", { extras: { private: "SECRET" } }), call("bash", { media: [{ type: "image", url: "file:///secret" }] }), call("bash", { kind: "subagent" })];
    expect(publicThreadTools(calls, { includeOutput: true }).tools).toEqual(calls.map(({ name, status }) => ({ name, status })));
  });
  it("scrubs terminal escapes and credential forms from allowed visible text", () => {
    const mcpTokens = ["local", "access", "refresh", "code"].flatMap(kind => [`tau_mcp_${kind}_${"a".repeat(43)}`, `tau_mcp_${kind}_${"a".repeat(42)}-`]);
    const text = ["\u001b[31mVisible\u001b[0m\u0000", "Authorization: Bearer PRIVATE", 'password="PRIVATE"', "api_key: PRIVATE", "secretRef=PRIVATE", `taug.${"a".repeat(24)}.${"b".repeat(43)}`, `taug.${"a".repeat(24)}.${"b".repeat(42)}-`, ...mcpTokens, "https://person:PRIVATE@example.com/path", "https://example.com?token=PRIVATE", "ghp_" + "a".repeat(30)].join("\n");
    const projected = publicThreadTools([call("bash", { output: text })], { includeOutput: true });
    expect(projected.tools[0]?.output).toContain("Visible");
    const serialized = JSON.stringify(projected);
    for (const forbidden of ["PRIVATE", "person:", "api_key", "secretRef", "\\u001b", "ghp_", "taug.", "tau_mcp_", "args", "startedAt", '"id"']) expect(serialized).not.toContain(forbidden);
    expect(publicThreadTools([call("Bash", { output: "-----BEGIN PRIVATE KEY-----\n" + "sensitive\n".repeat(10_000) + "-----END PRIVATE KEY-----" })], { includeOutput: true }).tools[0]?.output).toBe("[REDACTED]");
  });
  it("bounds count, names and output together, and identifies truncated visible previews", () => {
    const projected = publicThreadTools(Array.from({ length: 600 }, () => call("bash", { output: "line\n".repeat(12_000) })), { includeOutput: true });
    expect(projected.truncated).toBe(true);
    expect(projected.tools.length).toBeLessThanOrEqual(500);
    expect(projected.tools.reduce((n, tool) => n + tool.name.length + (tool.output?.length ?? 0), 0)).toBeLessThanOrEqual(200_000);
    expect(projected.tools.every((tool) => (tool.output?.length ?? 0) <= 32_000)).toBe(true);
    expect(publicThreadTools([call("bash", { outputTruncated: true })], { includeOutput: true }).tools[0]?.outputTruncated).toBe(true);
  });
});
