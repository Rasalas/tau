import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUiPrompt, ThreadIndexSnapshot } from "../shared/contracts.js";
import { ExternalMcpAuthorization, LOCAL_MCP_ISSUER } from "./external-mcp-authorization.js";
import { callExternalMcpControlTool, runtimeHoldsCeiling, type ExternalMcpControlHost } from "./external-mcp-control-tools.js";
import type { ExternalMcpExecution } from "./external-mcp-policy.js";
import { EXTERNAL_MCP_THREAD_ENTRY, ExternalMcpThreads, type ExternalMcpThreadHost } from "./external-mcp-threads.js";
import type { HostThread, HostThreadStartOptions, HostTurnObserver } from "./host-extension-contracts.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

interface FakeThread { id: string; kind: string; streaming: boolean; idle: boolean; entries: unknown[] }

/** A host whose Access extension records every level it is told, as the real one keeps them per thread. */
async function fixture(options: { access?: "active" | "missing" | "loose" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "tau-mcp-control-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const events: string[] = [];
  const levels = new Map<string, string>();
  const live = new Map<string, FakeThread>();
  const observers = new Set<HostTurnObserver>();
  const activations = new Set<(id: string) => void>();
  const marks = new Map<string, unknown>();
  let clamp: ((id: string) => string | undefined) | undefined;
  const index: ThreadIndexSnapshot = {
    projects: [{ name: "A", workspaceId: "a", path: "/private/a", lastOpenedAt: 1 }, { name: "B", workspaceId: "b", path: "/private/b", lastOpenedAt: 1 }],
    sessions: [
      { id: "owner-a", title: "Owner's thread", workspaceId: "a", projectPath: "/private/a", projectName: "A", path: "/s/owner", modifiedAt: 5, messageCount: 2 },
      { id: "owner-b", title: "Other project", workspaceId: "b", projectPath: "/private/b", projectName: "B", path: "/s/b", modifiedAt: 5, messageCount: 2 },
      { id: "remote-a", title: "Remote", workspaceId: "a", projectPath: "/r", projectName: "A", path: "/r/s", modifiedAt: 5, messageCount: 2, machine: { id: "m", name: "M" } },
    ], complete: true,
  };
  const prompts: ExtensionUiPrompt[] = [];
  let counter = 0;
  const hostThread = (thread: FakeThread): HostThread => ({
    sessionId: thread.id, cwd: "/private/a", backendKind: thread.kind, sessionFile: undefined,
    isStreaming: () => thread.streaming, isIdle: () => thread.idle, waitForIdle: async () => undefined, isCurrent: () => true,
    sessionName: () => undefined, transcript: async () => [], complete: async () => "", modelApi: () => undefined,
    shortcuts: () => [], runShortcut: async () => false,
    // As `ThreadRuntime.appendJournalEntry`: only Pi keeps a journal.
    entries: () => thread.entries, appendEntry: (customType, data) => {
      if (thread.kind !== "pi") throw new Error(`The ${thread.kind} runtime has no journal.`);
      events.push(`entry:${thread.id}`); thread.entries.push({ type: "custom", customType, data });
    },
  });
  const host: ExternalMcpControlHost & ExternalMcpThreadHost = {
    threadIndexSnapshot: () => index,
    loadTranscript: async () => { throw new Error("unused"); },
    resolveWorkspacePath: (id) => `/private/${id}`,
    startThread: vi.fn(async (start: HostThreadStartOptions) => {
      const thread: FakeThread = { id: `started-${++counter}`, kind: start.backend ?? "pi", streaming: false, idle: true, entries: [] };
      live.set(thread.id, thread);
      events.push(`open:${thread.id}:${start.cwd}`);
      try { await start.beforePrompt?.(hostThread(thread)); } catch (error) { live.delete(thread.id); events.push(`discard:${thread.id}`); throw error; }
      for (const observer of observers) await observer.prepare?.(thread.id, "turn");
      events.push(`prompt:${thread.id}:${levels.get(thread.id)}`);
      thread.streaming = true; thread.idle = false;
      index.sessions.push({ id: thread.id, title: "Started", workspaceId: "a", projectPath: "/private/a", projectName: "A", path: `/s/${thread.id}`, modifiedAt: 9, messageCount: 1, backendKind: thread.kind });
      return { sessionId: thread.id, cwd: start.cwd };
    }),
    sendToThread: vi.fn(async (id: string, text: string, delivery: string) => { events.push(`send:${id}:${delivery}:${levels.get(id)}:${text}`); }),
    abort: vi.fn(async (id: string) => { events.push(`abort:${id}`); const thread = live.get(id); if (thread) { thread.streaming = false; thread.idle = true; } }),
    liveThread: (id) => { const thread = live.get(id); return thread && hostThread(thread); },
    replayOpenUiPrompts: () => prompts,
    invokeHostExtension: vi.fn(async (extensionId: string, command: string, input: unknown) => {
      if (options.access === "missing") throw new Error("Host extension tau.access is not installed.");
      const { threadId, level } = input as { threadId: string; level: string };
      expect([extensionId, command]).toEqual(["tau.access", "thread-level"]);
      levels.set(threadId, level);
      events.push(`level:${threadId}:${level}`);
      return options.access === "loose" ? "full" : level;
    }),
    observeTurns: (observer) => { observers.add(observer); return () => observers.delete(observer); },
    observeExtensionActivation: (listener) => { activations.add(listener); return () => activations.delete(listener); },
    setThreadCeiling: (provider) => { clamp = provider; },
    markMcpClient: (id, client) => { marks.set(id, client); },
  };
  const threads = await ExternalMcpThreads.open({ path: join(dir, "threads.json") });
  threads.attach(host);
  const auth = await ExternalMcpAuthorization.open({ storePath: join(dir, "tokens.json"), issuer: LOCAL_MCP_ISSUER, revoked: (grantId) => { void threads.revoked(grantId); } });
  cleanup.push(() => auth.close());
  const token = async (control: boolean, execution?: ExternalMcpExecution, projectIds = ["a"]) => (await auth.createLocalToken({ name: "Client", projectIds, scopes: control ? ["tau:read", "tau:threads"] : ["tau:read"], ...(execution ? { execution } : {}) })).token;
  const call = async (secret: string, name: string, args: Record<string, unknown>, signal = new AbortController().signal) => {
    const result = await callExternalMcpControlTool(auth, secret, host, threads, name, args, signal);
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  };
  return { dir, auth, host, threads, token, call, events, levels, live, index, prompts, observers, activations, marks, clamp: (id: string) => clamp?.(id) };
}

describe("external MCP thread control", () => {
  it("applies the grant's ceiling before the first prompt and records which grant may control the thread", async () => {
    const f = await fixture();
    const secret = await f.token(true);
    const started = await f.call(secret, "tau_start_thread", { projectId: "a", prompt: "Fix the bug", title: "Bug" });
    expect(started).toMatchObject({ threadId: "started-1", projectId: "a", ceiling: "ask" });
    expect(f.events).toEqual(["open:started-1:/private/a", "level:started-1:ask", "entry:started-1", "level:started-1:ask", "prompt:started-1:ask"]);
    expect(f.live.get("started-1")!.entries).toEqual([{ type: "custom", customType: EXTERNAL_MCP_THREAD_ENTRY, data: expect.objectContaining({ execution: "ask" }) }]);
    const disk = JSON.parse(await readFile(join(f.dir, "threads.json"), "utf8")) as { threads: Array<{ threadId: string; grantId: string; execution: string }> };
    expect(disk.threads).toEqual([expect.objectContaining({ threadId: "started-1", projectId: "a", execution: "ask", grantId: f.auth.localTokens()[0]!.id })]);
    expect(await readFile(join(f.dir, "threads.json"), "utf8")).not.toContain(secret);
  });

  it("re-applies the ceiling when a resumed thread prepares a turn, also for a fork that only carries the entry", async () => {
    const f = await fixture();
    await f.call(await f.token(true, "read-only"), "tau_start_thread", { projectId: "a", prompt: "Look around" });
    // A restart: the Access extension forgot every level; the registry and the entries remain.
    f.levels.clear();
    const reopened = await ExternalMcpThreads.open({ path: join(f.dir, "threads.json") });
    f.observers.clear();
    reopened.attach(f.host);
    await reopened.restore();
    expect(f.levels.get("started-1")).toBe("read-only");
    f.levels.clear();
    for (const observer of f.observers) await observer.prepare?.("started-1", "next");
    expect(f.levels.get("started-1")).toBe("read-only");
    f.live.set("fork", { id: "fork", kind: "pi", streaming: false, idle: true, entries: [...f.live.get("started-1")!.entries] });
    for (const observer of f.observers) await observer.prepare?.("fork", "next");
    expect(f.levels.get("fork")).toBe("read-only");
    expect(reopened.owner("fork")).toBeUndefined();
    for (const observer of f.observers) await observer.prepare?.("owner-a", "next");
    expect(f.levels.has("owner-a")).toBe(false);
  });

  it("fails closed when the Access extension cannot hold the ceiling, and lets a full ceiling through", async () => {
    const missing = await fixture({ access: "missing" });
    const refused = missing.call(await missing.token(true, "ask"), "tau_start_thread", { projectId: "a", prompt: "x" });
    await expect(refused).rejects.toThrow("turn on the Access extension");
    expect(missing.events).toEqual(["open:started-1:/private/a", "discard:started-1"]);
    await expect(missing.call(await missing.token(true, "full"), "tau_start_thread", { projectId: "a", prompt: "x" })).resolves.toMatchObject({ ceiling: "full" });
    const loose = await fixture({ access: "loose" });
    await expect(loose.call(await loose.token(true, "auto"), "tau_start_thread", { projectId: "a", prompt: "x" })).rejects.toThrow("could not confirm");
  });

  it.each(["tau_start_thread", "tau_send_message", "tau_stop_thread", "tau_thread_status"])("%s needs the tau:threads scope and an approved project", async (name) => {
    const f = await fixture();
    const args = name === "tau_start_thread" ? { prompt: "x" } : name === "tau_send_message" ? { threadId: "owner-a", text: "x" } : { threadId: "owner-a" };
    await expect(f.call(await f.token(false), name, { projectId: "a", ...args })).rejects.toThrow("access_denied");
    const control = await f.token(true);
    await expect(f.call(control, name, { projectId: "b", ...args })).rejects.toThrow("access_denied");
    await expect(f.call(control, name, { projectId: "a", ...args, extra: true })).rejects.toThrow("invalid_request");
    await expect(f.call("tau_mcp_local_forged", name, { projectId: "a", ...args })).rejects.toThrow("invalid_grant");
    expect(f.host.startThread).not.toHaveBeenCalled();
    expect(f.host.sendToThread).not.toHaveBeenCalled();
  });

  it("resolves thread ids within the named project and refuses remote threads", async () => {
    const f = await fixture();
    const secret = await f.token(true, "ask", ["a", "b"]);
    for (const args of [{ projectId: "a", threadId: "owner-b" }, { projectId: "a", threadId: "remote-a" }, { projectId: "a", threadId: "../../x" }]) {
      await expect(f.call(secret, "tau_thread_status", args)).rejects.toThrow("access_denied");
    }
  });

  it("controls only the threads its own grant started; the rest stay read-only", async () => {
    const f = await fixture();
    const mine = await f.token(true);
    const other = await f.token(true);
    const { threadId } = await f.call(mine, "tau_start_thread", { projectId: "a", prompt: "Start" });
    for (const [secret, id] of [[mine, "owner-a"], [other, threadId]] as const) {
      await expect(f.call(secret, "tau_send_message", { projectId: "a", threadId: id, text: "hi" })).rejects.toThrow("only control threads it started");
      await expect(f.call(secret, "tau_stop_thread", { projectId: "a", threadId: id })).rejects.toThrow("only control threads it started");
    }
    expect(await f.call(other, "tau_thread_status", { projectId: "a", threadId })).toMatchObject({ state: "running", controllable: false });
    expect(await f.call(mine, "tau_thread_status", { projectId: "a", threadId })).toMatchObject({ state: "running", controllable: true, ceiling: "ask", runtime: "pi" });
    expect(f.host.sendToThread).not.toHaveBeenCalled();
    expect(f.host.abort).not.toHaveBeenCalled();
  });

  it("steers a running thread and starts a turn on an idle one, re-applying the ceiling first", async () => {
    const f = await fixture();
    const secret = await f.token(true, "auto");
    const { threadId } = await f.call(secret, "tau_start_thread", { projectId: "a", prompt: "Start" }) as { threadId: string };
    f.levels.clear();
    expect(await f.call(secret, "tau_send_message", { projectId: "a", threadId, text: "also this" })).toMatchObject({ delivery: "steered", ceiling: "auto" });
    expect(await f.call(secret, "tau_send_message", { projectId: "a", threadId, text: "later", delivery: "queue" })).toMatchObject({ delivery: "queued" });
    expect(await f.call(secret, "tau_stop_thread", { projectId: "a", threadId })).toEqual({ threadId, stopped: true });
    expect(await f.call(secret, "tau_stop_thread", { projectId: "a", threadId })).toEqual({ threadId, stopped: false });
    expect(await f.call(secret, "tau_send_message", { projectId: "a", threadId, text: "next" })).toMatchObject({ delivery: "started" });
    expect(f.events.filter((event) => event.startsWith("send:"))).toEqual([`send:${threadId}:steer:auto:also this`, `send:${threadId}:queue:auto:later`, `send:${threadId}:prompt:auto:next`]);
  });

  it("reports a question waiting for the owner", async () => {
    const f = await fixture();
    f.prompts.push({ id: "q", sessionId: "owner-a", kind: "confirm", title: "Run npm install?", message: "secret detail" });
    const status = await f.call(await f.token(true), "tau_thread_status", { projectId: "a", threadId: "owner-a" });
    expect(status).toMatchObject({ state: "waiting-for-answer", lastActivityAt: 5, controllable: false, question: { kind: "confirm", title: "Run npm install?" } });
    expect(JSON.stringify(status)).not.toContain("secret detail");
  });

  it("drives only runtimes known to hold the ceiling", async () => {
    const f = await fixture();
    for (const [runtime, ceiling] of [["antigravity", "read-only"], ["machine", "full"], ["acp@gemini", "ask"], ["acp@gemini", "auto"], ["acp@gemini", "read-only"], ["unknown", "ask"]] as const) {
      await expect(f.call(await f.token(true, ceiling), "tau_start_thread", { projectId: "a", prompt: "x", runtime })).rejects.toThrow("cannot hold");
    }
    expect(f.host.startThread).not.toHaveBeenCalled();
    expect(runtimeHoldsCeiling("acp@gemini", "full")).toBe(true);
    expect(runtimeHoldsCeiling("codex@work", "read-only")).toBe(true);
    expect(runtimeHoldsCeiling("antigravity", "ask")).toBe(true);
  });

  it("starts a thread on a runtime without a journal, its ceiling held by the registry alone", async () => {
    const f = await fixture();
    const { threadId } = await f.call(await f.token(true, "ask"), "tau_start_thread", { projectId: "a", prompt: "x", runtime: "claude-code" }) as { threadId: string };
    expect(f.live.get(threadId)!.entries).toEqual([]);
    expect(f.events).toContain(`prompt:${threadId}:ask`);
    expect(f.threads.owner(threadId)).toMatchObject({ execution: "ask", journaled: false });
    expect(f.clamp(threadId)).toBe("ask");
  });

  it("never drops a journal-less thread's record to make room, and refuses a start instead", async () => {
    const f = await fixture();
    const record = (i: number, journaled: boolean) => ({ threadId: `old-${i}`, grantId: "g", projectId: "a", execution: "ask", startedAt: i + 1, journaled });
    const path = join(f.dir, "threads.json");
    const full = Array.from({ length: 4096 }, (_, i) => record(i, false));
    await writeFile(path, JSON.stringify({ version: 1, threads: [record(-1, true), record(0, false), ...full.slice(2)] }));
    const reopened = await ExternalMcpThreads.open({ path });
    reopened.attach(f.host);
    const thread = (id: string, kind: string) => ({ sessionId: id, backendKind: kind, appendEntry: () => undefined });
    await reopened.claim(thread("new-1", "codex"), { grantId: "g", projectId: "a", execution: "ask", startedAt: 1 });
    expect(reopened.owner("old--1")).toBeUndefined();
    expect(reopened.owner("old-0")).toBeDefined();
    await expect(reopened.claim(thread("new-2", "codex"), { grantId: "g", projectId: "a", execution: "ask", startedAt: 2 })).rejects.toThrow("starts no more");
    expect(reopened.owner("new-2")).toBeUndefined();
    expect(reopened.owner("old-0")).toBeDefined();
    reopened.close();
  });

  it("revocation stops the grant's running turns, cancels its starts and blocks every further call", async () => {
    const f = await fixture();
    const secret = await f.token(true);
    const { threadId } = await f.call(secret, "tau_start_thread", { projectId: "a", prompt: "Start" }) as { threadId: string };
    const grantId = f.auth.localTokens()[0]!.id;
    await f.auth.revokeGrant(grantId);
    await vi.waitFor(() => expect(f.events).toContain(`abort:${threadId}`));
    await expect(f.call(secret, "tau_thread_status", { projectId: "a", threadId })).rejects.toThrow("invalid_grant");
    // A start whose grant is revoked before its first prompt never reaches the runtime.
    const next = await f.token(true);
    let release!: () => void;
    vi.mocked(f.host.invokeHostExtension).mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return "ask"; });
    const starting = f.call(next, "tau_start_thread", { projectId: "a", prompt: "Late" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await f.auth.revokeGrant(f.auth.localTokens()[0]!.id);
    release();
    await expect(starting).rejects.toThrow();
    expect(f.events.some((event) => event.startsWith("prompt:started-2"))).toBe(false);
    expect(f.events).toContain("discard:started-2");
  });

  it("puts every recorded ceiling back the moment the Access extension activates again, and clamps meanwhile", async () => {
    const f = await fixture();
    const { threadId } = await f.call(await f.token(true, "read-only"), "tau_start_thread", { projectId: "a", prompt: "Look" }) as { threadId: string };
    expect(f.clamp(threadId)).toBe("read-only");
    expect(f.clamp("owner-a")).toBeUndefined();
    // A reload: the new instance holds no levels, and no turn is prepared.
    f.levels.clear();
    for (const listener of f.activations) listener("tau.scheduling");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.levels.has(threadId)).toBe(false);
    for (const listener of f.activations) listener("tau.access");
    await vi.waitFor(() => expect(f.levels.get(threadId)).toBe("read-only"));
    f.threads.close();
    expect(f.clamp(threadId)).toBeUndefined();
    expect(f.activations.size).toBe(0);
  });

  it("marks a started thread with its client's name and ceiling, again after a restart", async () => {
    const f = await fixture();
    const secret = (await f.auth.createLocalToken({ name: "Claude Code", projectIds: ["a"], scopes: ["tau:read", "tau:threads"] })).token;
    const { threadId } = await f.call(secret, "tau_start_thread", { projectId: "a", prompt: "Hi" }) as { threadId: string };
    expect(f.marks.get(threadId)).toEqual({ name: "Claude Code", ceiling: "ask" });
    f.marks.clear();
    const reopened = await ExternalMcpThreads.open({ path: join(f.dir, "threads.json") });
    reopened.attach(f.host);
    expect(f.marks.get(threadId)).toEqual({ name: "Claude Code", ceiling: "ask" });
    expect(f.marks.has("owner-a")).toBe(false);
    reopened.close();
  });
});
