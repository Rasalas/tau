import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CLIENT_APP, claudeQueryOptions, collectTurnText, createClaudeCodeRuntimeAdapter, runtimePermissionPolicy, type ClaudeQuery } from "./runtime-adapter.js";

interface Call { prompt: string; options: Options }
type Script = (call: Call) => SDKMessage[] | Promise<SDKMessage[]>;

/** A `query` that yields scripted frames; the script sees what the adapter asked for. */
function scripted(script: Script): { query: ClaudeQuery; calls: Call[] } {
  const calls: Call[] = [];
  const query = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    const call: Call = { prompt: params.prompt as string, options: params.options ?? {} };
    calls.push(call);
    async function* run(): AsyncGenerator<SDKMessage, void> {
      for (const frame of await script(call)) yield frame;
    }
    return run() as unknown as ReturnType<ClaudeQuery>;
  }) as unknown as ClaudeQuery;
  return { query, calls };
}

const SESSION = "123e4567-e89b-42d3-a456-426614174000";
const frame = <T extends object>(value: T): SDKMessage => ({ uuid: "u", session_id: SESSION, ...value }) as unknown as SDKMessage;
const init = () => frame({ type: "system", subtype: "init", model: "claude-opus-5" });
const assistant = (text: string, parent: string | null = null) => frame({ type: "assistant", parent_tool_use_id: parent, message: { role: "assistant", content: [{ type: "text", text }] } });
const success = (numTurns = 1, result = "") => frame({ type: "result", subtype: "success", is_error: false, num_turns: numTurns, result });
const failure = (...errors: string[]) => frame({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, errors });
const sdkAbort = () => Object.assign(new Error("Request was aborted."), { name: "AbortError" });
const afterAbort = (signal: AbortSignal): Promise<never> => new Promise((_, reject) => {
  signal.addEventListener("abort", () => reject(sdkAbort()), { once: true });
  if (signal.aborted) reject(sdkAbort());
});

const input = (tauThreadId: string, text: string, extra: Partial<Parameters<ReturnType<typeof createClaudeCodeRuntimeAdapter>["transport"]["sendPrompt"]>[0]> = {}) =>
  ({ cwd: process.cwd(), tauThreadId, sessionId: `provider-${tauThreadId}`, text, ...extra });

describe("Claude Code runtime adapter", () => {
  let directory = "";
  const store = (name: string): string => join(directory, `${name}-sessions.json`);
  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "tau-claude-adapter-")); });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  it("declares its kind, its capabilities and a transport core will accept", () => {
    const adapter = createClaudeCodeRuntimeAdapter({ command: "claude-test", storePath: store("selection") });
    expect(adapter.id).toBe("claude-code");
    expect(adapter.capabilities).toEqual({ skillInvocationDialect: "claude-code", ownsModelSelection: true, interactiveApprovals: true });
    expect(adapter.transport.sendPrompt).toBeTypeOf("function");
  });

  it("maps Tau's access levels onto Claude's permission modes", () => {
    expect(runtimePermissionPolicy("read-only")).toEqual({ permissionMode: "plan" });
    expect(runtimePermissionPolicy("ask")).toEqual({ permissionMode: "default" });
    expect(runtimePermissionPolicy("full")).toEqual({ permissionMode: "auto" });
  });

  it("tells the SDK to run the user's own CLI with the user's own settings, and only adds Tau's identity", () => {
    const abortController = new AbortController();
    const plan = { cwd: "/repo", executable: "/usr/local/bin/claude", claudeSessionId: SESSION, started: false, policy: runtimePermissionPolicy("full"), abortController, env: { PATH: "/bin" } };
    const created = claudeQueryOptions(plan);
    expect(created).toMatchObject({
      cwd: "/repo",
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      permissionMode: "auto",
      sessionId: SESSION,
      env: { PATH: "/bin", CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP },
      abortController,
    });
    expect(created).not.toHaveProperty("resume");
    expect(created).not.toHaveProperty("allowDangerouslySkipPermissions");
    expect(CLIENT_APP).toMatch(/^tau\.claude-code\/\d+\.\d+\.\d+$/u);
    const resumed = claudeQueryOptions({ ...plan, started: true, policy: runtimePermissionPolicy("read-only") });
    expect(resumed).toMatchObject({ resume: SESSION, permissionMode: "plan" });
    expect(resumed).not.toHaveProperty("sessionId");
    expect(() => claudeQueryOptions({ ...plan, claudeSessionId: "not-a-uuid" })).toThrow("must be UUIDs");
    // The ask level needs someone to answer; with hooks the SDK gets the callbacks and the one dialog kind Tau renders.
    expect(() => claudeQueryOptions({ ...plan, policy: runtimePermissionPolicy("ask") })).toThrow("manual approvals are unsupported");
    const canUseTool = vi.fn();
    const onUserDialog = vi.fn();
    expect(claudeQueryOptions({ ...plan, policy: runtimePermissionPolicy("ask"), hooks: { canUseTool, onUserDialog } })).toMatchObject({
      permissionMode: "default",
      canUseTool,
      onUserDialog,
      supportedDialogKinds: ["resume_return"],
    });
    expect(claudeQueryOptions({ ...plan, hooks: { canUseTool } })).not.toHaveProperty("onUserDialog");
  });

  it("collects the main loop's text, skips sub-agent frames and the resume handshake", async () => {
    async function* frames(): AsyncGenerator<SDKMessage> {
      yield init();
      yield success(0);
      yield assistant("Looking.");
      yield assistant("sub-agent narration", "tool-1");
      yield assistant("Done.");
      yield success(2, "Done.");
    }
    await expect(collectTurnText(frames())).resolves.toBe("Looking.\n\nDone.");
    async function* silent(): AsyncGenerator<SDKMessage> { yield init(); yield success(1, "only the result"); }
    await expect(collectTurnText(silent())).resolves.toBe("only the result");
    async function* cut(): AsyncGenerator<SDKMessage> { yield init(); }
    await expect(collectTurnText(cut())).rejects.toThrow("ended without a result");
  });

  it("creates the session on the first turn, resumes it afterwards, and keeps the prompt verbatim", async () => {
    const { query, calls } = scripted((call) => [init(), assistant(call.options.resume ? `resumed:${call.prompt}` : `created:${call.prompt}`), success()]);
    const adapter = createClaudeCodeRuntimeAdapter({ command: "claude", resolveCommand: () => "/opt/claude", storePath: store("transport"), query, env: {} });
    const first = await adapter.transport.sendPrompt(input("session", "--help"));
    const second = await adapter.transport.sendPrompt(input("session", "continue"));
    expect(first.assistantText).toBe("created:--help");
    expect(second.assistantText).toBe("resumed:continue");
    const record = await adapter.sessionStore?.get("session");
    expect(record?.claudeSessionId).toBeTypeOf("string");
    expect(record?.started).toBe(true);
    expect(calls[0]?.options).toMatchObject({ sessionId: record?.claudeSessionId, pathToClaudeCodeExecutable: "/opt/claude", cwd: process.cwd() });
    expect(calls[1]?.options).toMatchObject({ resume: record?.claudeSessionId });
    // The provider session id core passes is display-only; the store keys by Tau's thread id.
    expect(await adapter.sessionStore?.get("provider-session")).toBeUndefined();
  });

  it("streams every frame of a turn in order and still resolves with the reply", async () => {
    const { query } = scripted(() => [init(), assistant("one"), assistant("two"), success()]);
    const adapter = createClaudeCodeRuntimeAdapter({ command: "claude", storePath: store("stream"), query, env: {} });
    const seen: string[] = [];
    await expect(adapter.stream(input("stream-session", "go"), (message) => { seen.push(message.type); })).resolves.toEqual({ assistantText: "one\n\ntwo" });
    expect(seen).toEqual(["system", "assistant", "assistant", "result"]);
  });

  it("opens a live session with the same options a turn gets, minus the prompt", async () => {
    let params: { prompt: unknown; options?: Options } | undefined;
    const query = ((received: { prompt: unknown; options?: Options }) => {
      params = received;
      async function* run(): AsyncGenerator<SDKMessage, void> { yield init(); }
      return Object.assign(run(), { interrupt: vi.fn(), setPermissionMode: vi.fn(), setModel: vi.fn() }) as unknown as ReturnType<ClaudeQuery>;
    }) as unknown as ClaudeQuery;
    const adapter = createClaudeCodeRuntimeAdapter({ command: "claude", resolveCommand: () => "/opt/claude", storePath: store("session"), query, env: { PATH: "/bin" } });
    const seen: string[] = [];
    const exits: unknown[] = [];
    const canUseTool = vi.fn();
    const session = adapter.openSession({ cwd: "/repo", claudeSessionId: SESSION, started: true, permissionLevel: "ask", hooks: { canUseTool }, onMessage: (message) => { seen.push(message.type); }, onExit: (error) => { exits.push(error); } });
    expect(typeof params?.prompt).toBe("object");
    expect(params?.options).toMatchObject({ cwd: "/repo", pathToClaudeCodeExecutable: "/opt/claude", resume: SESSION, permissionMode: "default", canUseTool, includePartialMessages: true, env: { PATH: "/bin", CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP } });
    expect(params?.options?.abortController).toBe(session.abortController);
    await session.close();
    expect(seen).toEqual(["system"]);
    expect(exits).toEqual([undefined]);
  });

  it("aborts a running turn and everything queued behind it without blocking the next turn", async () => {
    const { query } = scripted(async (call) => {
      if (call.prompt !== "hang") return [init(), assistant("ok"), success()];
      return afterAbort(call.options.abortController!.signal);
    });
    const adapter = createClaudeCodeRuntimeAdapter({ command: "claude", storePath: store("abort"), query, env: {} });
    const pending = adapter.transport.sendPrompt(input("abort-session", "hang"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const queued = adapter.transport.sendPrompt(input("abort-session", "queued"));
    await adapter.transport.abort?.("abort-session");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await expect(adapter.transport.sendPrompt(input("abort-session", "again"))).resolves.toEqual({ assistantText: "ok" });
    expect((await adapter.sessionStore?.get("abort-session"))?.lastAttemptOutcome).toBe("started");

    const controller = new AbortController();
    const signalled = adapter.transport.sendPrompt(input("signal-session", "hang", { signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(signalled).rejects.toMatchObject({ name: "AbortError" });
  });

  it("recovers create/resume conflicts and one missing resumed session", async () => {
    const { query } = scripted((call) => {
      if (call.prompt === "conflict" && call.options.sessionId) return [init(), failure(`Session ID ${call.options.sessionId} already exists.`)];
      if (call.prompt === "missing" && call.options.resume) return [init(), failure(`No conversation found with session ID: ${call.options.resume}`)];
      return [init(), assistant(call.options.resume ? "resumed" : "created"), success()];
    });
    const adapter = createClaudeCodeRuntimeAdapter({ command: "claude", storePath: store("recovery"), query, env: {} });

    await expect(adapter.transport.sendPrompt(input("conflict-session", "conflict"))).resolves.toEqual({ assistantText: "resumed" });
    expect(await adapter.sessionStore?.get("conflict-session")).toMatchObject({ started: true, attempted: true, createFallbackUsed: true, attemptCount: 2 });
    await expect(adapter.transport.sendPrompt(input("conflict-session", "next"))).resolves.toEqual({ assistantText: "resumed" });

    await expect(adapter.transport.sendPrompt(input("missing-session", "first"))).resolves.toEqual({ assistantText: "created" });
    await expect(adapter.transport.sendPrompt(input("missing-session", "missing"))).resolves.toEqual({ assistantText: "created" });
    expect(await adapter.sessionStore?.get("missing-session")).toMatchObject({ started: true, createFallbackUsed: true, attemptCount: 3 });
  });

  it("reports an error result together with what the CLI wrote to stderr", async () => {
    const { query } = scripted((call) => {
      call.options.stderr?.("credentials expired\n");
      return [init(), failure("API error", "please log in again")];
    });
    const adapter = createClaudeCodeRuntimeAdapter({ command: "claude", storePath: store("error"), query, env: {} });
    const failed = adapter.transport.sendPrompt(input("error-session", "fail"));
    await expect(failed).rejects.toThrow("API error\nplease log in again");
    await expect(failed).rejects.toThrow("credentials expired");
    expect((await adapter.sessionStore?.get("error-session"))?.lastAttemptOutcome).toBe("failed");
  });

  it("rejects the ask level on the awaited path, which has nobody to answer, before asking the SDK for anything", async () => {
    const { query, calls } = scripted(() => [init(), assistant("must not run"), success()]);
    const adapter = createClaudeCodeRuntimeAdapter({ command: "claude", storePath: store("policy"), query, env: {} });
    await expect(adapter.transport.sendPrompt(input("manual-session", "must reject", { permissionLevel: "ask" }))).rejects.toThrow("manual approvals are unsupported");
    expect(calls).toHaveLength(0);
    await expect(adapter.stream(input("manual-session", "ask away", { permissionLevel: "ask" }), () => undefined, { canUseTool: vi.fn() })).resolves.toEqual({ assistantText: "must not run" });
    expect(calls[0]?.options).toMatchObject({ permissionMode: "default" });
  });
});
