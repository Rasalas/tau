import { execFile } from "node:child_process";
import { createServer, type Server } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { HostExecutionPolicy } from "tau/host-extension";
import { NETWORK_NOTE, NetworkSandbox, createPiNetworkExtension, type SandboxManagerLike, type SandboxRuntimeConfigLike } from "./pi-network.js";

const LIMITED: HostExecutionPolicy = { network: "loopback", allowHosts: ["pypi.org"], reasons: ["Limited for a test."], sources: ["tau.servers"] };
const OPEN: HostExecutionPolicy = { network: "any", allowHosts: [], reasons: [], sources: [] };

function fakeManager(overrides: Partial<SandboxManagerLike> = {}) {
  const configs: SandboxRuntimeConfigLike[] = [];
  const manager: SandboxManagerLike = {
    initialize: vi.fn(async (config: SandboxRuntimeConfigLike) => { configs.push(config); }),
    updateConfig: vi.fn((config: SandboxRuntimeConfigLike) => { configs.push(config); }),
    wrapWithSandbox: vi.fn(async (command: string) => `sandboxed ${command}`),
    reset: vi.fn(async () => undefined),
    ...overrides,
  };
  return { manager, configs };
}

type Handler = (event: Record<string, unknown>) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler>();
  return { pi: { on: (name: string, handler: Handler) => { handlers.set(name, handler); } }, handlers };
}

describe("NetworkSandbox", () => {
  it("runs a command unchanged without a limit and never loads the sandbox for it", async () => {
    const load = vi.fn();
    const sandbox = new NetworkSandbox({ load, platform: "darwin" });
    expect(await sandbox.wrap("/p", "curl example.com", OPEN)).toEqual({ command: "curl example.com" });
    expect(load).not.toHaveBeenCalled();
  });

  it("wraps a limited command with loopback open, files untouched and only the allowed hosts", async () => {
    const { manager, configs } = fakeManager();
    const sandbox = new NetworkSandbox({ load: async () => ({ SandboxManager: manager }), platform: "darwin" });
    expect(await sandbox.wrap("/p", "npm install", LIMITED)).toEqual({ command: "sandboxed npm install" });
    expect(configs[0]).toEqual({
      network: { allowedDomains: ["pypi.org"], deniedDomains: [], strictAllowlist: true, allowLocalBinding: true, allowAllUnixSockets: true },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [], disabled: true },
    });
    await sandbox.wrap("/p", "ls", LIMITED);
    expect(manager.initialize).toHaveBeenCalledTimes(1);
    expect(manager.updateConfig).not.toHaveBeenCalled();
    await sandbox.wrap("/q", "ls", { ...LIMITED, allowHosts: ["api.example.com"] });
    expect(configs.at(-1)?.network.allowedDomains).toEqual(["api.example.com", "pypi.org"]);
    await sandbox.dispose();
    expect(manager.reset).toHaveBeenCalled();
  });

  it("refuses on a platform without a sandbox", async () => {
    const load = vi.fn();
    const sandbox = new NetworkSandbox({ load, platform: "win32" });
    const result = await sandbox.wrap("/p", "dir", LIMITED);
    expect(result).toEqual({ refusal: "Limited for a test. Tau has no sandbox for Windows, so Tau did not run this command." });
    expect(await sandbox.availability()).toEqual({ available: false, reason: "Tau has no sandbox for Windows" });
    expect(load).not.toHaveBeenCalled();
  });

  it("refuses while the sandbox cannot start, and tries again for the next command", async () => {
    let fail = true;
    const { manager } = fakeManager({ initialize: vi.fn(async () => { if (fail) throw new Error("Sandbox dependencies not available: bubblewrap (bwrap) not installed"); }) });
    const log = vi.fn();
    const sandbox = new NetworkSandbox({ load: async () => ({ SandboxManager: manager }), platform: "linux", ripgrep: () => "/usr/bin/rg", log });
    const refused = await sandbox.wrap("/p", "ls", LIMITED);
    expect(refused).toMatchObject({ refusal: expect.stringContaining("bubblewrap (bwrap) not installed") });
    expect(manager.reset).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("servers.network.sandbox-failed", expect.stringContaining("bubblewrap"));
    fail = false;
    expect(await sandbox.wrap("/p", "ls", LIMITED)).toEqual({ command: "sandboxed ls" });
    expect(vi.mocked(manager.initialize).mock.calls[1]?.[0].ripgrep).toEqual({ command: "/usr/bin/rg" });
  });
});

describe("Pi network extension", () => {
  it("rewrites a limited bash call and notes the limit when it fails", async () => {
    const { manager } = fakeManager();
    const sandbox = new NetworkSandbox({ load: async () => ({ SandboxManager: manager }), platform: "darwin" });
    const policy = vi.fn(async () => LIMITED);
    const { pi, handlers } = fakePi();
    createPiNetworkExtension({ policy, sandbox })(pi as never, { sessionId: "s", cwd: "/project" });
    const input = { command: "curl https://example.com" };
    expect(await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "t1", input })).toBeUndefined();
    expect(input.command).toBe("sandboxed curl https://example.com");
    expect(policy).toHaveBeenCalledWith("/project");
    const content = [{ type: "text", text: "curl: (56) CONNECT tunnel failed, response 403" }];
    expect(handlers.get("tool_result")!({ toolName: "bash", toolCallId: "t1", isError: true, content })).toEqual({ content: [...content, { type: "text", text: NETWORK_NOTE }] });
    // Once per call, and never for a call it did not wrap.
    expect(handlers.get("tool_result")!({ toolName: "bash", toolCallId: "t1", isError: true, content })).toBeUndefined();
    const read = { path: "a" };
    expect(await handlers.get("tool_call")!({ toolName: "read", toolCallId: "t2", input: read })).toBeUndefined();
    expect(read).toEqual({ path: "a" });
  });

  it("leaves an unlimited project's commands as they are", async () => {
    const { pi, handlers } = fakePi();
    const sandbox = { wrap: vi.fn() };
    createPiNetworkExtension({ policy: async () => OPEN, sandbox })(pi as never, { sessionId: "s", cwd: "/p" });
    const input = { command: "curl example.com" };
    expect(await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "t", input })).toBeUndefined();
    expect(input.command).toBe("curl example.com");
    expect(sandbox.wrap).not.toHaveBeenCalled();
  });

  it("blocks a command it cannot hold to the limit, PowerShell included", async () => {
    const { pi, handlers } = fakePi();
    createPiNetworkExtension({ policy: async () => LIMITED, sandbox: { wrap: async () => ({ refusal: "No sandbox here." }) } })(pi as never, { sessionId: "s", cwd: "/p" });
    expect(await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "t", input: { command: "ls" } })).toEqual({ block: true, reason: "No sandbox here." });
    expect(await handlers.get("tool_call")!({ toolName: "powershell", toolCallId: "u", input: { command: "dir" } })).toEqual({
      block: true,
      reason: "Limited for a test. PowerShell cannot be held to it, so Tau did not run this command.",
    });
  });
});

const PROBE = `
const net = require("node:net");
const attempt = (host, port) => new Promise((done) => {
  const socket = net.connect({ host, port });
  socket.on("connect", () => { socket.destroy(); done(host + " connected"); });
  socket.on("error", (error) => done(host + " " + error.code));
});
(async () => { console.log(await attempt("127.0.0.1", Number(process.argv[1]))); console.log(await attempt("192.0.2.1", 9)); })();
`;

// The library itself, on the platform the team develops on: loopback reaches a
// local port, TEST-NET is refused by the sandbox before a packet leaves.
describe.runIf(process.platform === "darwin")("NetworkSandbox with sandbox-runtime on macOS", () => {
  it("lets a command reach 127.0.0.1 and refuses 192.0.2.1", async () => {
    const server: Server = createServer((socket) => socket.end()).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const sandbox = new NetworkSandbox({ load: () => import("@anthropic-ai/sandbox-runtime") });
    try {
      const wrapped = await sandbox.wrap("/p", `"${process.execPath}" -e '${PROBE}' ${port}`, LIMITED);
      if (!("command" in wrapped)) throw new Error(wrapped.refusal);
      const output = await new Promise<string>((resolve, reject) => {
        execFile("bash", ["-c", wrapped.command], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)));
      });
      expect(output.trim().split("\n")).toEqual(["127.0.0.1 connected", "192.0.2.1 EPERM"]);
    } finally {
      await sandbox.dispose();
      server.close();
    }
  }, 30_000);
});
