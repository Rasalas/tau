import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { query as sdkQuery, type SpawnOptions, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { createClaudeCodeRuntimeAdapter, type ClaudeQuery, type ClaudeSessionInput } from "./runtime-adapter.js";

const SESSION = "123e4567-e89b-42d3-a456-426614174000";
const TOKEN = "dummy-token-4711";
const mcpServer = { name: "tau", url: "http://127.0.0.1:4100/mcp", token: TOKEN, headers: { Authorization: `Bearer ${TOKEN}` } };

type Answer = "answer" | "silent" | "fail" | "error";

/** Stands in for the CLI behind the SDK's spawn hook: records its argv and what arrives on stdin, in order. */
function fakeCli(setServers: Answer = "answer") {
  const spawns: SpawnOptions[] = [];
  const stdin: Array<{ type: string; subtype?: string; request?: Record<string, unknown> }> = [];
  const spawn = (options: SpawnOptions): SpawnedProcess => {
    spawns.push(options);
    const input = new PassThrough();
    const output = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin: input, stdout: output, killed: false, exitCode: null as number | null,
      kill: () => { output.end(); child.emit("exit", null, "SIGTERM"); return true; },
    });
    let pending = "";
    input.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        const line = JSON.parse(pending.slice(0, end)) as { type: string; request_id?: string; request?: { subtype: string } };
        pending = pending.slice(end + 1);
        stdin.push({ type: line.type, ...(line.request ? { subtype: line.request.subtype, request: line.request } : {}) });
        if (line.type !== "control_request") continue;
        const subtype = line.request!.subtype;
        let response: Record<string, unknown> = { subtype: "success", request_id: line.request_id, response: {} };
        if (subtype === "initialize") response = { ...response, response: { commands: [], agents: [], output_style: "default", available_output_styles: ["default"], models: [], account: {} } };
        if (subtype === "mcp_set_servers") {
          if (setServers === "silent") continue;
          if (setServers === "fail") response = { subtype: "error", request_id: line.request_id, error: `rejected ${TOKEN}` };
          else response = { ...response, response: { added: [], removed: [], errors: setServers === "error" ? { tau: `refused ${TOKEN}` } : {} } };
        }
        output.write(`${JSON.stringify({ type: "control_response", response })}\n`);
      }
    });
    input.on("end", () => { output.end(); child.emit("exit", 0, null); });
    return child;
  };
  return { spawn, spawns, stdin };
}

function open(cli: ReturnType<typeof fakeCli>, input: Partial<ClaudeSessionInput> = {}, mcpTimeoutMs?: number, extraArgs?: Record<string, string | null>) {
  // The real SDK with the fake CLI behind it: what reaches argv and stdin is what the SDK builds.
  const query = ((params: Parameters<ClaudeQuery>[0]) => sdkQuery({ ...params, options: { ...params.options, spawnClaudeCodeProcess: cli.spawn } })) as ClaudeQuery;
  const adapter = createClaudeCodeRuntimeAdapter({ command: "claude", resolveCommand: () => "/opt/cli", storePath: "/unused", query, env: { PATH: "/bin" }, ...(extraArgs ? { extraArgs } : {}), ...(mcpTimeoutMs !== undefined ? { mcpTimeoutMs } : {}) });
  const unavailable: Array<[string[], string]> = [];
  const session = adapter.openSession({
    cwd: "/repo", claudeSessionId: SESSION, started: false, permissionLevel: "full", mcpServer,
    onMessage: () => undefined, onExit: () => undefined,
    onMcpUnavailable: (servers, reason) => { unavailable.push([servers, reason]); },
    ...input,
  });
  return { session, unavailable };
}

const requests = (cli: ReturnType<typeof fakeCli>, subtype: string) => cli.stdin.filter((frame) => frame.subtype === subtype);
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe("Tau's MCP server over the control channel", () => {
  it("keeps the token out of the CLI's argv and sends the server on stdin before the first prompt", async () => {
    const cli = fakeCli();
    const { session, unavailable } = open(cli);
    session.send("hello", "next").catch(() => undefined);
    await expect.poll(() => cli.stdin.some((frame) => frame.type === "user")).toBe(true);

    const { args, env } = cli.spawns[0]!;
    expect(JSON.stringify(args)).not.toContain(TOKEN);
    expect(args).not.toContain("--mcp-config");
    expect(JSON.stringify(env)).not.toContain(TOKEN);
    expect(args).toContain("--allowedTools");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__tau");

    const registration = requests(cli, "mcp_set_servers");
    expect(registration).toHaveLength(1);
    expect(registration[0]!.request).toMatchObject({ servers: { tau: { type: "http", url: mcpServer.url, headers: mcpServer.headers } } });
    // The turn needs the tools: nothing reaches the CLI as a prompt before they are registered.
    expect(cli.stdin.findIndex((frame) => frame.subtype === "mcp_set_servers")).toBeLessThan(cli.stdin.findIndex((frame) => frame.type === "user"));
    expect(unavailable).toEqual([]);
    await session.close();
  });

  it("registers the server on resume as well, and with a tool restriction that sets strict MCP config", async () => {
    const cli = fakeCli();
    const { session } = open(cli, { started: true, tools: ["read"] });
    await expect.poll(() => requests(cli, "mcp_set_servers").length).toBe(1);
    expect(cli.spawns[0]!.args).toContain(`--resume=${SESSION}`);
    expect(cli.spawns[0]!.args).toContain("--strict-mcp-config");
    expect(JSON.stringify(cli.spawns[0]!.args)).not.toContain(TOKEN);
    await session.close();
  });

  it("passes the guide's reading tools and disabled hooks to the real SDK without exposing its credential", async () => {
    const cli = fakeCli();
    const { session } = open(cli, { tools: ["read", "grep", "find", "ls", "read_pull_request_diff", "submit_pull_request_guide"] });
    try {
      await expect.poll(() => requests(cli, "mcp_set_servers").length).toBe(1);
      const args = cli.spawns[0]!.args;
      const flag = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
      expect(flag("--tools")?.split(",")).toEqual(["Read", "Grep", "Glob"]);
      expect(JSON.parse(flag("--settings")!)).toMatchObject({ disableAllHooks: true });
      expect(args).toContain("--strict-mcp-config");
      expect(JSON.stringify(args)).not.toContain(TOKEN);
      expect(requests(cli, "mcp_set_servers")[0]!.request).toMatchObject({ servers: { tau: { headers: mcpServer.headers } } });
    } finally { await session.close(); }
  });

  it.each([{ tools: "default" }, { "mcp-config": "/fixture/servers.json" }] as Record<string, string | null>[])("refuses instance launch overrides before the real SDK can spawn: %j", (extraArgs) => {
    const cli = fakeCli();
    expect(() => open(cli, { tools: ["read", "grep", "find", "ls", "read_pull_request_diff", "submit_pull_request_guide"] }, undefined, extraArgs)).toThrow("restricted tools cannot use extra launch arguments");
    expect(cli.spawns).toEqual([]);
    expect(cli.stdin).toEqual([]);
  });

  it("registers nothing when the host has no endpoint", async () => {
    const cli = fakeCli();
    const { session } = open(cli, { mcpServer: undefined });
    await settled();
    expect(requests(cli, "mcp_set_servers")).toHaveLength(0);
    await session.close();
  });

  it("names the server, never the CLI's error text, when the CLI could not connect it", async () => {
    const cli = fakeCli("error");
    const { session, unavailable } = open(cli);
    session.send("hello", "next").catch(() => undefined);
    await expect.poll(() => unavailable.length).toBe(1);
    expect(unavailable).toEqual([[["tau"], "failed"]]);
    expect(JSON.stringify(unavailable)).not.toContain(TOKEN);
    // The prompt still goes out: the thread runs, without the tools.
    await expect.poll(() => cli.stdin.some((frame) => frame.type === "user")).toBe(true);
    await session.close();
  });

  it("reports a rejected registration", async () => {
    const cli = fakeCli("fail");
    const { session, unavailable } = open(cli);
    await expect.poll(() => unavailable.length).toBe(1);
    expect(unavailable).toEqual([[["tau"], "failed"]]);
    await session.close();
  });

  it("reports a CLI that never answers, instead of hanging the thread", async () => {
    const cli = fakeCli("silent");
    const { session, unavailable } = open(cli, {}, 10);
    session.send("hello", "next").catch(() => undefined);
    await expect.poll(() => unavailable.length).toBe(1);
    expect(unavailable).toEqual([[["tau"], "timeout"]]);
    await expect.poll(() => cli.stdin.some((frame) => frame.type === "user")).toBe(true);
    await session.close();
  });

  it("does not report anything for a session closed while it waited", async () => {
    const cli = fakeCli("silent");
    const { session, unavailable } = open(cli);
    await expect.poll(() => requests(cli, "mcp_set_servers").length).toBe(1);
    await session.close();
    await settled();
    expect(unavailable).toEqual([]);
  });
});
