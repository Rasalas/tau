import { describe, expect, it } from "vitest";
import { parseMcpArgs, runMcp } from "./tau-mcp.mjs";
import { main, parseArgs } from "./tau.mjs";

describe("tau mcp", () => {
  it("registers exact callbacks and approves only explicit project ids", () => {
    expect(parseMcpArgs(["register", "--name", "Terminal", "--redirect", "http://127.0.0.1/cb", "--redirect", "https://client.test/cb"])).toEqual({ action: "register", name: "Terminal", redirectUris: ["http://127.0.0.1/cb", "https://client.test/cb"] });
    expect(parseMcpArgs(["approve", "request", "--project", "one", "--project", "two"])).toEqual({ action: "approve", requestId: "request", projectIds: ["one", "two"] });
    expect(parseArgs(["mcp", "status"])).toEqual({ command: "mcp", mcp: { action: "status" } });
  });

  it.each([["approve", "request"], ["approve", "request", "--full"], ["register", "--name", "Client"], ["revoke"], ["status", "--token", "secret"], ["deny", "request", "extra"]])("rejects incomplete or authority-widening arguments %j", (args) => {
    expect(() => parseMcpArgs(args)).toThrow();
  });

  it("routes owner actions through the authenticated host session", async () => {
    const calls = []; const output = [];
    await runMcp(parseMcpArgs(["revoke", "grant"]), { session: { request: async (...args) => { calls.push(args); return { revoked: true }; } }, out: (line) => output.push(line) });
    expect(calls).toEqual([["external-mcp-manage", [{ action: "revoke", grantId: "grant" }]]]);
    expect(output).toEqual(['{"revoked":true}']);
  });

  it("prints help without requiring a running host", async () => {
    const output = [];
    expect(await main(["mcp", "--help"], { out: (line) => output.push(line) })).toBe(0);
    expect(output.join("\n")).toContain("TAU_MCP_ORIGIN");
  });
});
