import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OpenCodeClient, OpenCodeHttpError, parseEventBlock } from "./client.js";
import { connectOpenCodeServer, mergedConfigContent, startOpenCodeServer } from "./server.js";
import { startFakeOpenCode } from "./fixtures/fake-server.js";
import { startFakeOpenCode2 } from "./fixtures/fake-server-v2.js";
import { readOpenCodeVersion } from "./host.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-serve.mjs", import.meta.url));
const FAKE_2 = fileURLToPath(new URL("./fixtures/fake-serve-v2.mjs", import.meta.url));

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
      await expect(server.api.health()).resolves.toEqual({ healthy: true, version: "1.18.32" });
      expect(server.api.generation).toBe(1);
      const seen = await new OpenCodeClient({ url: server.url, password: server.password! }).request<{ config: Record<string, unknown>; args: string[] }>("GET", "/config");
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

  it("reports a memory kill, as its scope recorded it, in place of the exit code", async () => {
    const wrap = (oomKilled: boolean) => ({ command, args }: { command: string; args: readonly string[] }) => ({ command, args: [...args], scope: { unit: "tau-opencode-1.scope", oomKilled: async () => oomKilled } });
    const failing = { command: FAKE, cwd: process.cwd(), env: { ...process.env, FAKE_SERVE_FAIL: "1" } };
    await expect(startOpenCodeServer({ ...failing, wrap: wrap(true) })).rejects.toThrow("Killed: out of memory.");
    await expect(startOpenCodeServer({ ...failing, wrap: wrap(false) })).rejects.toThrow(/exited with code 3/u);
  });

  it("kills a server that ignores SIGTERM once the grace is over", async () => {
    const server = await startOpenCodeServer({ command: FAKE, cwd: process.cwd(), env: { ...process.env, FAKE_IGNORE_TERM: "1" }, closeGraceMs: 50 });
    await server.close();
    await expect(server.api.health()).rejects.toThrow();
  });

  it("recognizes an OpenCode 2 server by /api/info and reads its version there", async () => {
    const fake = await startFakeOpenCode2({ password: "pw" });
    try {
      const server = await connectOpenCodeServer(fake.url, "pw");
      expect(server.api.generation).toBe(2);
      await expect(server.api.health()).resolves.toEqual({ healthy: true, version: "2.0.26" });
      await expect(connectOpenCodeServer(fake.url, "wrong")).rejects.toBeInstanceOf(OpenCodeHttpError);
    } finally {
      await fake.close();
    }
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
      await expect(server.api.providers("/repo")).resolves.toMatchObject({ connected: ["opencode", "github-copilot"] });
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

interface SeenEnv { config: Record<string, unknown>; args: string[]; password: string | null; serverPassword: string | null; username: string | null }

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

describe("a local OpenCode 2 server", () => {
  const start = (extra: Partial<Parameters<typeof startOpenCodeServer>[0]> = {}) => startOpenCodeServer({ command: FAKE_2, cwd: process.cwd(), env: { ...process.env }, ...extra });
  const seen = (server: Awaited<ReturnType<typeof start>>) => new OpenCodeClient({ url: server.url, password: server.password! }).request<SeenEnv>("GET", "/api/fake/env");

  it("is told apart by /api/info, though its ready line has no product prefix and /global/health is a web page", async () => {
    const server = await start({ args: ["--print-logs"] });
    try {
      expect(server.local).toBe(true);
      expect(server.api.generation).toBe(2);
      await expect(server.api.health()).resolves.toEqual({ healthy: true, version: "2.0.26" });
      expect((await seen(server)).args).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"]);
      const page = await fetch(`${server.url}/global/health`);
      expect(page.headers.get("content-type")).toBe("text/html");
    } finally {
      await server.close();
    }
    expect(server.closed).toBe(true);
  });

  it("reads the version the program names", async () => {
    await expect(readOpenCodeVersion(FAKE_2)).resolves.toBe("2.0.26");
    const previous = process.env.FAKE_OPENCODE_VERSION;
    process.env.FAKE_OPENCODE_VERSION = "2.1.3";
    try {
      await expect(readOpenCodeVersion(FAKE_2)).resolves.toBe("2.1.3");
      const server = await start();
      try {
        await expect(server.api.health()).resolves.toEqual({ healthy: true, version: "2.1.3" });
      } finally {
        await server.close();
      }
    } finally {
      if (previous === undefined) delete process.env.FAKE_OPENCODE_VERSION;
      else process.env.FAKE_OPENCODE_VERSION = previous;
    }
  });

  it("hands the password over in both variables and drops a user name; the program reads only the one OpenCode 2 reads", async () => {
    const server = await start({ env: { ...process.env, OPENCODE_SERVER_PASSWORD: "stale", OPENCODE_PASSWORD: "stale-too", OPENCODE_SERVER_USERNAME: "me" } });
    try {
      const env = await seen(server);
      expect(server.password).toMatch(/^[\w-]{32}$/u);
      expect(env).toMatchObject({ password: server.password, serverPassword: server.password, username: null });
      await expect(connectOpenCodeServer(server.url, "stale")).rejects.toBeInstanceOf(OpenCodeHttpError);
      await expect(connectOpenCodeServer(server.url, undefined)).rejects.toBeInstanceOf(OpenCodeHttpError);
      await expect(connectOpenCodeServer(server.url, server.password)).resolves.toMatchObject({ local: false, api: { generation: 2 } });
    } finally {
      await server.close();
    }
  });

  it("lists the MCP servers Tau configured, from either generation's config shape", async () => {
    const remote = { type: "remote", url: "http://127.0.0.1:1/mcp" };
    const cases: Array<[Record<string, unknown> | undefined, string[] | undefined]> = [
      [{ mcp: { tau: remote } }, ["tau"]],
      [{ mcp: { servers: { tau: remote, other: remote } } }, ["tau", "other"]],
      [{ mcp: { servers: {} } }, undefined],
      [{ model: "opencode/x" }, undefined],
      [undefined, undefined],
    ];
    for (const [config, names] of cases) {
      const server = await start(config ? { config } : {});
      try {
        expect(server.mcpServers).toEqual(names);
        if (config) expect((await seen(server)).config).toEqual(config);
      } finally {
        await server.close();
      }
    }
  });

  it("keeps the user's own MCP servers when Tau adds its server under mcp.servers", () => {
    const merged = mergedConfigContent(JSON.stringify({ username: "me", mcp: { servers: { mine: { type: "local" } } } }), { mcp: { servers: { tau: { type: "remote" } } } });
    expect(JSON.parse(merged!)).toEqual({ username: "me", mcp: { servers: { mine: { type: "local" }, tau: { type: "remote" } } } });
  });

  it("says why it did not start, with what the program printed", async () => {
    await expect(start({ env: { ...process.env, FAKE_SERVE_FAIL: "1" } })).rejects.toThrow(/exited with code 3[\s\S]*database is locked/u);
  });

  it("refuses a server whose /api/info is garbage with a clear error, and leaves no process behind", async () => {
    const lines: string[] = [];
    await expect(start({ env: { ...process.env, FAKE_INFO_GARBAGE: "1" }, onStderrLine: (line) => lines.push(line) }))
      .rejects.toThrow(/OpenCode's server did not answer: This server does not answer like OpenCode 1/u);
    const pid = Number(/^pid (\d+)$/u.exec(lines.find((line) => line.startsWith("pid "))!)![1]);
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
  });
});
