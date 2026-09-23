import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravitySession, SIGN_IN_REQUIRED, acpSpawnInput, type AntigravitySessionOptions } from "./acp-session.js";
import { fakeAgent, until, type FakeAgent } from "../_acp/fake.js";
import { AUTH_URL_PREFIX } from "./profile.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const link = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&response_type=code&state=st&redirect_uri=http%3A%2F%2F127.0.0.1%3A43125%2F";

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-agy-session-"));
  directories.push(directory);
  return directory;
}

function scripted(agent: FakeAgent, extras: { resume?: boolean; mcp?: { http?: boolean; sse?: boolean } } = {}) {
  agent.respond("initialize", () => ({
    protocolVersion: 1,
    agentInfo: { name: "antigravity-acp", version: "agy_acp_server_1.1.1" },
    authMethods: [{ id: "oauth-personal", name: "Google account" }],
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: extras.resume === false ? undefined : {} },
      auth: { logout: {} },
      // What agy_acp_server 1.1.1 answers.
      mcpCapabilities: extras.mcp ?? { http: true, sse: true },
    },
  }));
  agent.respond("authenticate", () => ({}));
  agent.respond("session/new", () => ({
    sessionId: "acp-session",
    configOptions: [
      { type: "select", id: "model", name: "Model", category: "model", currentValue: "gemini-3.8-flash-medium", options: [{ group: "gemini", name: "Gemini", options: [{ value: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" }, { value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" }] }] },
      { type: "select", id: "mode", name: "Mode", category: "mode", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "yolo", name: "Turbo" }] },
    ],
  }));
  agent.respond("session/resume", () => ({ configOptions: [] }));
  const current: Record<string, string> = { model: "gemini-3.8-flash-medium", mode: "default" };
  agent.respond("session/set_config_option", (params) => {
    const request = params as { configId: string; value: string };
    current[request.configId] = request.value;
    return { configOptions: [
      { type: "select", id: "model", name: "Model", category: "model", currentValue: current.model, options: [{ value: "gemini-3.8-flash-medium", name: "Medium" }, { value: "gemini-3.8-flash-low", name: "Low" }] },
      { type: "select", id: "mode", name: "Mode", category: "mode", currentValue: current.mode, options: [{ value: "default", name: "Default" }, { value: "yolo", name: "Turbo" }] },
    ] };
  });
}

function options(agent: FakeAgent, cwd: string, overrides: Partial<AntigravitySessionOptions> = {}): AntigravitySessionOptions {
  return {
    executable: { executablePath: "/opt/agy/agy_acp_server.par", harnessPath: "/opt/agy/localharness_external", source: "override" },
    profile: { geminiHome: "/state/profile", acpDirectory: "/state/profile/antigravity-acp", tokenPath: "/state/profile/antigravity-acp/acp_token.json", settingsPath: "/state/profile/antigravity-acp/settings.json" },
    cwd,
    platform: "darwin",
    baseEnv: { PATH: "/bin", GEMINI_API_KEY: "x" },
    browser: "helper %s",
    clientVersion: "0.2.0",
    spawn: () => agent.process,
    onUpdate: () => undefined,
    onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    timeouts: { cancelMs: 50 },
    ...overrides,
  };
}

describe("AntigravitySession", () => {
  it("builds the spawn input from the release, the profile and the browser helper", () => {
    const input = acpSpawnInput({ ...options(fakeAgent(), "/repo"), platform: "linux" });
    expect(input).toMatchObject({ command: "/opt/agy/agy_acp_server.par", args: ["--uid="], cwd: "/repo" });
    expect(input.env).toMatchObject({ PATH: "/bin", GEMINI_HOME: "/state/profile", ANTIGRAVITY_HARNESS_PATH: "/opt/agy/localharness_external", BROWSER: "helper %s" });
    expect(input.env).not.toHaveProperty("GEMINI_API_KEY");
  });

  it("shakes hands, creates a session, lists models and modes, and sets them through config options", async () => {
    const agent = fakeAgent();
    scripted(agent);
    const updates: unknown[] = [];
    const session = await AntigravitySession.open(options(agent, await scratch(), { onUpdate: (update) => updates.push(update) }));
    expect(agent.received.map((message) => message.method)).toEqual(["initialize", "authenticate"]);
    expect(agent.received[0]!.params).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: "tau", version: "0.2.0" } });
    const setup = await session.newSession();
    expect(setup.sessionId).toBe("acp-session");
    expect(session.modelOptions().map((option) => option.value)).toEqual(["gemini-3.8-flash-medium", "gemini-3.8-flash-low"]);
    expect(session.currentModel()).toBe("gemini-3.8-flash-medium");
    expect(session.modeId).toBe("default");
    await session.setModel("gemini-3.8-flash-low");
    await session.setMode("yolo");
    await session.setMode("yolo");
    expect(agent.received.filter((message) => message.method === "session/set_config_option").map((message) => message.params)).toEqual([
      { sessionId: "acp-session", configId: "model", value: "gemini-3.8-flash-low" },
      { sessionId: "acp-session", configId: "mode", value: "yolo" },
    ]);
    await expect(session.setModel("nope")).rejects.toThrow(/does not offer/u);
    agent.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } });
    agent.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "other", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "no" } } } });
    await until(() => updates.length === 1);
    await session.close();
  });

  it("forwards the user's MCP servers when a session is created or resumed", async () => {
    const agent = fakeAgent();
    scripted(agent);
    const mcpServers = [{ name: "pencil", command: "/opt/pencil", args: [], env: [] }];
    const session = await AntigravitySession.open(options(agent, await scratch(), { mcpServers }));
    await session.newSession();
    await session.resumeSession("acp-session");
    const sent = agent.received.filter((message) => message.method === "session/new" || message.method === "session/resume");
    expect(sent.map((message) => (message.params as { mcpServers: unknown }).mcpServers)).toEqual([mcpServers, mcpServers]);
    await session.close();
  });

  it("sends an http or sse server only to an agent that takes that transport", async () => {
    const tau = { type: "http", name: "tau", url: "http://127.0.0.1:4100/mcp", headers: [{ name: "Authorization", value: "Bearer secret" }] };
    const events = { type: "sse", name: "events", url: "http://127.0.0.1:4200/sse", headers: [] };
    const pencil = { name: "pencil", command: "/opt/pencil", args: [], env: [] };
    const sentWith = async (mcp: { http?: boolean; sse?: boolean }) => {
      const agent = fakeAgent();
      scripted(agent, { mcp });
      const session = await AntigravitySession.open(options(agent, await scratch(), { mcpServers: [pencil, tau, events] }));
      await session.newSession();
      await session.close();
      return (agent.received.find((message) => message.method === "session/new")!.params as { mcpServers: unknown }).mcpServers;
    };
    await expect(sentWith({ http: true, sse: true })).resolves.toEqual([pencil, tau, events]);
    await expect(sentWith({ http: true })).resolves.toEqual([pencil, tau]);
    await expect(sentWith({})).resolves.toEqual([pencil]);
  });

  it("shakes hands without signing in when asked to, so a sign-out never opens a browser", async () => {
    const agent = fakeAgent();
    scripted(agent);
    agent.respond("logout", () => ({}));
    const session = await AntigravitySession.open(options(agent, await scratch(), { authenticate: false }));
    expect(agent.received.map((message) => message.method)).toEqual(["initialize"]);
    await session.logout();
    expect(agent.received.some((message) => message.method === "logout")).toBe(true);
    await session.close();
  });

  it("runs a prompt, serves permission and workspace file requests, and refuses paths outside the workspace", async () => {
    const agent = fakeAgent();
    scripted(agent);
    const cwd = await scratch();
    await writeFile(join(cwd, "notes.txt"), "one\ntwo\nthree\n");
    const onPermission = vi.fn(async (request: { options: Array<{ optionId: string }> }) => ({ outcome: { outcome: "selected" as const, optionId: request.options[0]!.optionId } }));
    const session = await AntigravitySession.open(options(agent, cwd, { onPermission: onPermission as never }));
    await session.newSession();
    agent.respond("session/prompt", async (_params, _id) => {
      agent.send({ jsonrpc: "2.0", id: 900, method: "session/request_permission", params: { sessionId: "acp-session", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }], toolCall: { toolCallId: "t1", title: "Write notes" } } });
      agent.send({ jsonrpc: "2.0", id: 901, method: "fs/read_text_file", params: { sessionId: "acp-session", path: "notes.txt", line: 2, limit: 1 } });
      agent.send({ jsonrpc: "2.0", id: 902, method: "fs/write_text_file", params: { sessionId: "acp-session", path: join(cwd, "out", "new.txt"), content: "written" } });
      agent.send({ jsonrpc: "2.0", id: 903, method: "fs/read_text_file", params: { sessionId: "acp-session", path: "../../etc/passwd" } });
      await until(() => agent.received.filter((message) => typeof message.id === "number" && message.id >= 900).length === 4);
      return { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 4 } };
    });
    const response = await session.prompt([{ type: "text", text: "hello" }]);
    expect(response.stopReason).toBe("end_turn");
    const answers = Object.fromEntries(agent.received.filter((message) => typeof message.id === "number" && message.id >= 900).map((message) => [message.id, message]));
    expect(answers[900]).toEqual({ jsonrpc: "2.0", id: 900, result: { outcome: { outcome: "selected", optionId: "allow" } } });
    expect(answers[901]).toEqual({ jsonrpc: "2.0", id: 901, result: { content: "two" } });
    expect(answers[902]).toEqual({ jsonrpc: "2.0", id: 902, result: {} });
    expect(answers[903]).toMatchObject({ error: { code: -32602 } });
    expect(await readFile(join(cwd, "out", "new.txt"), "utf8")).toBe("written");
    expect(onPermission).toHaveBeenCalledTimes(1);
    await session.close();
  });

  it("says it takes forms, and answers the schema's and the SDK's elicitation in their own shapes", async () => {
    const agent = fakeAgent();
    scripted(agent);
    const onElicitation = vi.fn(async () => ({ action: "accept" as const, content: { env: "prd" } }));
    const session = await AntigravitySession.open(options(agent, await scratch(), { onElicitation }));
    expect(agent.received.find((message) => message.method === "initialize")?.params).toMatchObject({ clientCapabilities: { elicitation: { form: {} } } });
    await session.newSession();
    const form = { mode: "form", message: "Where?", requestedSchema: { type: "object", properties: { env: { type: "string", enum: ["stg", "prd"] } } } };
    agent.send({ jsonrpc: "2.0", id: 910, method: "session/elicitation", params: { sessionId: "acp-session", ...form } });
    agent.send({ jsonrpc: "2.0", id: 911, method: "elicitation/create", params: { sessionId: "acp-session", ...form } });
    agent.send({ jsonrpc: "2.0", id: 912, method: "session/elicitation", params: { sessionId: "acp-session", mode: "url", url: "https://example.com", elicitationId: "e", message: "Open" } });
    agent.send({ jsonrpc: "2.0", id: 913, method: "session/elicitation", params: { sessionId: "another", ...form } });
    await until(() => agent.received.filter((message) => typeof message.id === "number" && message.id >= 910).length === 4);
    const answers = Object.fromEntries(agent.received.filter((message) => typeof message.id === "number" && message.id >= 910).map((message) => [message.id, message.result]));
    expect(answers).toEqual({
      910: { action: { action: "accept", content: { env: "prd" } } },
      911: { action: "accept", content: { env: "prd" } },
      912: { action: { action: "decline" } },
      913: { action: { action: "cancel" } },
    });
    expect(onElicitation).toHaveBeenCalledTimes(2);
    await session.close();
  });

  it("cancels a running turn through the notification, and takes the process down when the agent ignores it", async () => {
    const agent = fakeAgent();
    scripted(agent);
    const exit = vi.fn();
    const session = await AntigravitySession.open(options(agent, await scratch(), { onExit: exit }));
    await session.newSession();
    agent.respond("session/prompt", () => new Promise(() => undefined));
    const turn = session.prompt([{ type: "text", text: "go" }]);
    turn.catch(() => undefined);
    await until(() => agent.received.some((message) => message.method === "session/prompt"));
    await session.cancel();
    expect(agent.received.some((message) => message.method === "session/cancel" && !("id" in message))).toBe(true);
    await expect(turn).rejects.toBeInstanceOf(Error);
    expect(session.closed).toBe(true);
  });

  it("reports the sign-in link when asked to, and fails the handshake when nobody can show it", async () => {
    const agent = fakeAgent();
    scripted(agent);
    agent.respond("authenticate", async () => {
      agent.sendRaw(`${AUTH_URL_PREFIX}${link}`);
      await until(() => agent.lines.length >= 0);
      return {};
    });
    const onSignIn = vi.fn();
    const session = await AntigravitySession.open(options(agent, await scratch(), { onSignIn }));
    expect(onSignIn).toHaveBeenCalledWith(expect.objectContaining({ state: "st", redirectUri: "http://127.0.0.1:43125/" }));
    await session.close();

    const silent = fakeAgent();
    scripted(silent);
    silent.respond("authenticate", () => new Promise(() => { silent.stderr(`__TAU_ANTIGRAVITY_AUTH_URL__${JSON.stringify(link)}`); }));
    await expect(AntigravitySession.open(options(silent, await scratch()))).rejects.toMatchObject({ code: -32000, message: SIGN_IN_REQUIRED });
  });
});
