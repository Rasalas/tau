import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { localMcpUrl, parseMcpArgs, runMcp, serveMcpStdio } from "./tau-mcp.mjs";
import { main, parseArgs } from "./tau.mjs";

describe("tau mcp", () => {
  it("registers exact callbacks and approves only explicit project ids", () => {
    expect(parseMcpArgs(["register", "--name", "Terminal", "--redirect", "http://127.0.0.1/cb", "--redirect", "https://client.test/cb"])).toEqual({ action: "register", name: "Terminal", redirectUris: ["http://127.0.0.1/cb", "https://client.test/cb"] });
    expect(parseMcpArgs(["approve", "request", "--project", "one", "--project", "two"])).toEqual({ action: "approve", requestId: "request", projectIds: ["one", "two"] });
    expect(parseArgs(["mcp", "status"])).toEqual({ command: "mcp", mcp: { action: "status" } });
  });

  it("grants thread control only when asked, with a named ceiling", () => {
    expect(parseMcpArgs(["approve", "request", "--project", "one", "--threads"])).toEqual({ action: "approve", requestId: "request", projectIds: ["one"], scope: "tau:read tau:threads" });
    expect(parseMcpArgs(["approve", "request", "--threads", "--ceiling", "full", "--project", "one"])).toEqual({ action: "approve", requestId: "request", projectIds: ["one"], scope: "tau:read tau:threads", execution: "full" });
    expect(() => parseMcpArgs(["approve", "request", "--project", "one", "--ceiling", "full"])).toThrow();
    expect(() => parseMcpArgs(["approve", "request", "--project", "one", "--threads", "--ceiling", "root"])).toThrow();
    expect(parseMcpArgs(["serve"])).toEqual({ action: "serve" });
  });

  it("finds the local listener's kept port, and refuses while it is off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-mcp-cli-"));
    try {
      expect(() => localMcpUrl(dir, {})).toThrow("listener is off");
      await writeFile(join(dir, "external-mcp-local.json"), JSON.stringify({ version: 1, enabled: true, port: 41234 }));
      expect(localMcpUrl(dir, {})).toBe("http://127.0.0.1:41234/mcp");
      expect(localMcpUrl(dir, { TAU_MCP_URL: "http://127.0.0.1:1/mcp" })).toBe("http://127.0.0.1:1/mcp");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("bridges stdio lines to the listener with the token and the negotiated version", async () => {
    const input = new PassThrough(); const output = new PassThrough(); const lines = [];
    output.on("data", (chunk) => lines.push(...String(chunk).split("\n").filter(Boolean)));
    const requests = [];
    const fetch = async (url, init) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      const message = JSON.parse(init.body);
      if (message.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } }));
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (message.method === "denied") return new Response('{"error":"invalid_token"}', { status: 401 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
    };
    const done = serveMcpStdio({ url: "http://127.0.0.1:9/mcp", token: "tau_mcp_local_x", input, output, fetch });
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n{"jsonrpc":"2.0","id":3,"method":"denied"}\nnot json\n');
    input.end();
    expect(await done).toBe(0);
    expect(requests.every((request) => request.headers.authorization === "Bearer tau_mcp_local_x")).toBe(true);
    expect(requests.slice(1).every((request) => request.headers["mcp-protocol-version"] === "2025-06-18")).toBe(true);
    const replies = lines.map((line) => JSON.parse(line));
    expect(replies.map((reply) => reply.id).sort()).toEqual([1, 2, 3, null].sort());
    expect(replies.find((reply) => reply.id === 3).error.message).toContain("401");
    await expect(serveMcpStdio({ url: "http://127.0.0.1:9/mcp", token: undefined, input, output, fetch })).rejects.toThrow("TAU_MCP_TOKEN");
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
