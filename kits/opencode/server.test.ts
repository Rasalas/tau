import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OpenCodeHttpError, parseEventBlock } from "./client.js";
import { connectOpenCodeServer, mergedConfigContent, startOpenCodeServer } from "./server.js";
import { startFakeOpenCode } from "./fixtures/fake-server.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-serve.mjs", import.meta.url));

describe("a local OpenCode server", () => {
  it("starts on 127.0.0.1 with a password of its own and Tau's config over the user's", async () => {
    const server = await startOpenCodeServer({
      command: FAKE,
      args: ["--print-logs"],
      cwd: process.cwd(),
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ username: "me", mcp: { mine: { type: "local", command: ["x"] } } }) },
      config: { mcp: { tau: { type: "remote", url: "http://127.0.0.1:1/mcp" } } },
    });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(server.local).toBe(true);
      expect(server.password).toMatch(/^[\w-]{32}$/u);
      await expect(server.client.health()).resolves.toEqual({ healthy: true, version: "1.18.32" });
      const seen = await server.client.request<{ config: Record<string, unknown>; args: string[] }>("GET", "/config");
      expect(seen.args).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"]);
      expect(seen.config).toEqual({ username: "me", mcp: { mine: { type: "local", command: ["x"] }, tau: { type: "remote", url: "http://127.0.0.1:1/mcp" } } });
    } finally {
      await server.close();
    }
    expect(server.closed).toBe(true);
  });

  it("says why it did not start, with what the program printed", async () => {
    await expect(startOpenCodeServer({ command: FAKE, cwd: process.cwd(), env: { ...process.env, FAKE_SERVE_FAIL: "1" } }))
      .rejects.toThrow(/exited with code 3[\s\S]*database is locked/u);
  });

  it("kills a server that ignores SIGTERM once the grace is over", async () => {
    const server = await startOpenCodeServer({ command: FAKE, cwd: process.cwd(), env: { ...process.env, FAKE_IGNORE_TERM: "1" }, closeGraceMs: 50 });
    await server.close();
    await expect(server.client.health()).rejects.toThrow();
  });

  it("keeps a config it cannot read out of the merge", () => {
    expect(mergedConfigContent("not json", { a: 1 })).toBe('{"a":1}');
    expect(mergedConfigContent('{"a":1}', undefined)).toBe('{"a":1}');
  });
});

describe("a server the user runs", () => {
  it("is reached with its password, and refused without it", async () => {
    const fake = await startFakeOpenCode({ password: "pw" });
    try {
      const server = await connectOpenCodeServer(`${fake.url}/`, "pw");
      expect(server.local).toBe(false);
      await expect(server.client.providers("/repo")).resolves.toMatchObject({ connected: ["opencode", "github-copilot"] });
      await expect(connectOpenCodeServer(fake.url, "wrong")).rejects.toBeInstanceOf(OpenCodeHttpError);
    } finally {
      await fake.close();
    }
  });
});

describe("the event stream's framing", () => {
  it("reads a block's data lines as one event", () => {
    expect(parseEventBlock('id: 1\ndata: {"type":"session.idle",\ndata: "properties":{"sessionID":"s"}}')).toEqual({ type: "session.idle", properties: { sessionID: "s" } });
    expect(parseEventBlock(": heartbeat")).toBeUndefined();
    expect(parseEventBlock("data: nope")).toBeUndefined();
  });
});
