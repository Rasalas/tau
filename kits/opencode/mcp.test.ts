import { describe, expect, it } from "vitest";
import type { HostMcpConnection } from "tau/host-extension";
import { openCodeMcpConfig } from "./mcp.js";

const server: HostMcpConnection = { name: "tau", url: "http://127.0.0.1:9/mcp", token: "tok", headers: { Authorization: "Bearer tok" } };

describe("Tau's MCP server as OpenCode config", () => {
  it("writes OpenCode 1's shape by default, with the server enabled", () => {
    const expected = { mcp: { tau: { type: "remote", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer tok" }, oauth: false, enabled: true } } };
    expect(openCodeMcpConfig(server)).toEqual(expected);
    expect(openCodeMcpConfig(server, 1)).toEqual(expected);
  });

  it("writes OpenCode 2's shape under mcp.servers, outside Code Mode", () => {
    expect(openCodeMcpConfig(server, 2)).toEqual({
      mcp: { servers: { tau: { type: "remote", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer tok" }, oauth: false, codemode: false } } },
    });
  });

  it("leaves `enabled` out of generation 2 and `codemode` out of generation 1", () => {
    const one = (openCodeMcpConfig(server, 1).mcp as Record<string, Record<string, unknown>>).tau!;
    const two = ((openCodeMcpConfig(server, 2).mcp as { servers: Record<string, Record<string, unknown>> }).servers).tau!;
    expect(one).not.toHaveProperty("codemode");
    expect(two).not.toHaveProperty("enabled");
  });

  it("copies the headers, so a later change to the connection does not reach the config", () => {
    const headers: Record<string, string> = { Authorization: "Bearer tok" };
    const config = openCodeMcpConfig({ ...server, headers }, 2);
    headers.Authorization = "Bearer other";
    expect(JSON.stringify(config)).toContain("Bearer tok");
  });
});
