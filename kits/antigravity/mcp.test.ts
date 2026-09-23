import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { geminiConfigDirectory, mcpServersFromSettings, readMcpServers, toAcpMcpServer, withTauServer } from "./mcp.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("the user's MCP servers", () => {
  it("maps Gemini's three server shapes onto ACP's, env and headers as name/value pairs", () => {
    expect(toAcpMcpServer("pencil", { command: "/opt/pencil", args: ["--app", "code"], env: { TOKEN: "abc", bad: 3 } }))
      .toEqual({ name: "pencil", command: "/opt/pencil", args: ["--app", "code"], env: [{ name: "TOKEN", value: "abc" }] });
    expect(toAcpMcpServer("remote", { httpUrl: "https://mcp.example/x", headers: { Authorization: "Bearer t" } }))
      .toEqual({ type: "http", name: "remote", url: "https://mcp.example/x", headers: [{ name: "Authorization", value: "Bearer t" }] });
    expect(toAcpMcpServer("stream", { url: "https://mcp.example/sse" }))
      .toEqual({ type: "sse", name: "stream", url: "https://mcp.example/sse", headers: [] });
  });

  it("leaves out entries it cannot express, and reads none from a file that is missing or broken", async () => {
    expect(toAcpMcpServer("nameless", {})).toBeUndefined();
    expect(toAcpMcpServer("", { command: "x" })).toBeUndefined();
    expect(mcpServersFromSettings({ mcpServers: { good: { command: "a" }, bad: { note: "no transport" } } }).map((server) => server.name)).toEqual(["good"]);
    expect(mcpServersFromSettings({})).toEqual([]);
    expect(mcpServersFromSettings("nonsense")).toEqual([]);

    const directory = await mkdtemp(join(tmpdir(), "tau-agy-mcp-"));
    directories.push(directory);
    expect(await readMcpServers(directory)).toEqual([]);
    await writeFile(join(directory, "settings.json"), "{ broken");
    expect(await readMcpServers(directory)).toEqual([]);
    await writeFile(join(directory, "settings.json"), JSON.stringify({ mcpServers: { pencil: { command: "/opt/pencil" } } }));
    expect(await readMcpServers(directory)).toEqual([{ name: "pencil", command: "/opt/pencil", args: [], env: [] }]);
    expect(geminiConfigDirectory("/home/x")).toBe("/home/x/.gemini");
  });
});

describe("Tau's own server", () => {
  it("joins the user's servers as HTTP with the thread's credential, and takes the name from a user server", () => {
    const tau = { name: "tau", url: "http://127.0.0.1:4100/mcp", token: "secret", headers: { Authorization: "Bearer secret" } };
    const pencil = { name: "pencil", command: "/opt/pencil", args: [], env: [] };
    expect(withTauServer([pencil, { name: "tau", command: "/their/tau", args: [], env: [] }], tau)).toEqual([
      pencil,
      { type: "http", name: "tau", url: "http://127.0.0.1:4100/mcp", headers: [{ name: "Authorization", value: "Bearer secret" }] },
    ]);
    expect(withTauServer([pencil], undefined)).toEqual([pencil]);
  });
});
