import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { ThreadRuntimeLifecycle, composeShellCommandPrefix, type ThreadRuntimeLifecyclePort } from "./thread-runtime-lifecycle.js";
import { PARENT_LINK_ENTRY, parentLinkEntry } from "./session-lineage.js";
import type { RuntimeSessionInfo } from "./host-extensions.js";
import { ThreadRuntime } from "./thread-runtime.js";
import { SessionHeldElsewhereError, SessionLocks } from "./session-locks.js";
import { isUnavailableBackend } from "./unavailable-thread-backend.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { UNLIMITED_EXECUTION_POLICY, type HostExecutionPolicy } from "./host-execution-policy.js";

function externalBackend(threadId: string, options: { streaming?: boolean } = {}) {
  return {
    kind: "test" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId,
    providerSessionId: threadId,
    cwd: "/repo",
    turnReporting: "awaited" as const,
    capabilities: {},
    state: () => ({ streaming: options.streaming ?? false, idle: !options.streaming, hasMessages: false, activeTools: [], supportsImageInput: false, extensionCount: 0, title: "Named" }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: [], allTools: [] }),
    models: async () => [],
    composerCommands: () => [],
    transcript: async () => [],
    persist: async () => undefined,
    setTitle: async () => undefined,
    preparePrompt: async () => undefined,
    prompt: async () => ({}),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    start: async () => undefined,
    waitForIdle: async () => undefined,
  };
}

function makeLifecycle(overrides: Partial<ThreadRuntimeLifecyclePort> = {}, backends: Record<string, unknown> = {}) {
  const adopted: ThreadRuntime[] = [];
  const emitted: Array<{ threadId: string; event?: string }> = [];
  const released: string[] = [];
  const port: ThreadRuntimeLifecyclePort = {
    safeMode: false,
    agentDir: "/agent",
    cwd: () => "/repo",
    activeSessionFile: () => undefined,
    adapterFor: () => PI_AGENT_RUNTIME_ADAPTER,
    priceUsage: () => undefined,
    executionPolicy: async () => UNLIMITED_EXECUTION_POLICY,
    requireBackend: (kind) => {
      const provider = backends[kind];
      if (!provider) throw new Error(`Runtime backend "${kind}" is not installed`);
      return provider as never;
    },
    permissionLevel: () => "full",
    sessionFile: () => ({}) as never,
    runtimeExtensions: () => [],
    runtimeExtensionNames: () => [],
    runtimeModes: () => [],
    threadLifecycle: { beforeOpen: vi.fn(async () => undefined) } as never,
    turnObservers: { closed: vi.fn(async () => undefined) } as never,
    clientTurns: { settle: vi.fn() } as never,
    extensionUi: { cancelFor: vi.fn(), ask: vi.fn(async () => ({ confirmed: true })) } as never,
    projection: { mapping: () => ({}) } as never,
    projects: { name: () => "repo", knownLabel: () => undefined } as never,
    binding: { bind: vi.fn(async () => undefined), installHooks: vi.fn() } as never,
    lifecycleMetrics: { isActive: () => false, begin: vi.fn(), end: vi.fn() } as never,
    adopt: async (thread) => { adopted.push(thread); },
    currentRuntime: () => undefined,
    liveThreadForPath: () => undefined,
    indexedSession: () => undefined,
    presentUi: () => true,
    releaseTool: (id) => { released.push(id); },
    emitMessage: (threadId) => { emitted.push({ threadId }); },
    emitRuntimeEvent: (threadId, event) => { emitted.push({ threadId, event: event.type }); },
    logRuntimePhase: () => undefined,
    log: () => undefined,
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
    runtimeUnavailable: vi.fn(),
    sessionLocks: new SessionLocks(),
    ...overrides,
  };
  return { lifecycle: new ThreadRuntimeLifecycle(port), port, adopted, emitted, released };
}

describe("ThreadRuntimeLifecycle", () => {
  it("refuses a non-Pi backend in safe mode", async () => {
    const { lifecycle } = makeLifecycle({ safeMode: true });
    await expect(lifecycle.openExternal("test", "thread", "/repo")).rejects.toThrow("Tau safe mode");
  });

  it("adopts an opened external thread and carries its title over", async () => {
    const backend = externalBackend("thread");
    const provider = { open: async () => backend };
    const { lifecycle, adopted } = makeLifecycle({}, { test: provider });
    const thread = await lifecycle.openExternal("test", "thread", "/repo");
    expect(thread.adapterTitle).toBe("Named");
    expect(adopted).toEqual([thread]);
  });

  it("gives an external thread the tool cards its runtime kept, and none when reading them fails", async () => {
    const entry = { id: "k/activity-1", anchorMessageId: "m1", status: "completed" as const, tools: [{ id: "a", name: "bash", args: {}, status: "done" as const, startedAt: 1 }] };
    const kept = { ...externalBackend("thread"), capabilities: { activityHistory: { load: async () => [entry], save: async () => undefined } } };
    const { lifecycle } = makeLifecycle({}, { test: { open: async () => kept } });
    expect((await lifecycle.openExternal("test", "thread", "/repo")).adapterActivity).toEqual([entry]);

    const broken = { ...externalBackend("other"), capabilities: { activityHistory: { load: async () => { throw new Error("unreadable"); }, save: async () => undefined } } };
    const logs: string[] = [];
    const failing = makeLifecycle({ log: (label) => { logs.push(label); } }, { test: { open: async () => broken } });
    expect((await failing.lifecycle.openExternal("test", "other", "/repo")).adapterActivity).toEqual([]);
    expect(logs).toContain("activity.load.failed");
  });

  it("leaves an unadopted external thread out of the registry", async () => {
    const provider = { open: async () => externalBackend("thread") };
    const { lifecycle, adopted } = makeLifecycle({}, { test: provider });
    await lifecycle.openExternal("test", "thread", "/repo", { adopt: false });
    expect(adopted).toEqual([]);
  });

  it("delivers a backend's own messages to the transcript of the live thread", async () => {
    let deliver!: (message: { role: string; text: string }) => void;
    const provider = {
      open: async (_id: string, _cwd: string, _options: unknown, context: { onMessage: (message: unknown) => void }) => {
        deliver = context.onMessage as never;
        return externalBackend("thread");
      },
    };
    const live = { adapterMessages: [] as unknown[] };
    const { lifecycle, emitted } = makeLifecycle({ currentRuntime: () => live as never }, { test: provider });
    await lifecycle.openExternal("test", "thread", "/repo");
    deliver({ role: "assistant", text: "done" });
    expect(live.adapterMessages).toHaveLength(1);
    expect(emitted).toEqual([{ threadId: "thread" }]);
  });

  it("routes a streamed backend's runtime events to the host under the thread's id", async () => {
    let report!: (event: { type: string }) => void;
    const provider = {
      open: async (_id: string, _cwd: string, _options: unknown, context: { onEvent: (event: unknown) => void }) => {
        report = context.onEvent as never;
        return externalBackend("thread");
      },
    };
    const { lifecycle, emitted } = makeLifecycle({}, { test: provider });
    await lifecycle.openExternal("test", "thread", "/repo");
    report({ type: "turn-started" });
    expect(emitted).toEqual([{ threadId: "thread", event: "turn-started" }]);
  });

  it("puts a backend's question on the workbench dialog surface under the thread's id", async () => {
    let ask!: (prompt: { kind: string; title: string }) => Promise<unknown>;
    const provider = {
      open: async (_id: string, _cwd: string, _options: unknown, context: { ask: (prompt: unknown) => Promise<unknown> }) => {
        ask = context.ask as never;
        return externalBackend("thread");
      },
    };
    const { lifecycle, port } = makeLifecycle({}, { test: provider });
    await lifecycle.openExternal("test", "thread", "/repo");
    await expect(ask({ kind: "confirm", title: "Approve Bash?" })).resolves.toEqual({ confirmed: true });
    expect(port.extensionUi.ask).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "confirm", title: "Approve Bash?", sessionId: "thread", id: expect.stringMatching(/^backend-/u) }),
      undefined,
    );
  });

  it("tells a backend what its thread's folder may reach, asked afresh each time", async () => {
    let policy!: () => Promise<HostExecutionPolicy>;
    const provider = {
      open: async (_id: string, _cwd: string, _options: unknown, context: { executionPolicy: () => Promise<HostExecutionPolicy> }) => {
        policy = context.executionPolicy;
        return externalBackend("thread");
      },
    };
    const limited: HostExecutionPolicy = { network: "loopback", allowHosts: [], reasons: ["Limited."], sources: ["kit"] };
    const executionPolicy = vi.fn(async () => limited);
    const { lifecycle } = makeLifecycle({ executionPolicy }, { test: provider });
    await lifecycle.openExternal("test", "thread", "/repo/sub");
    expect(executionPolicy).not.toHaveBeenCalled();
    await expect(policy()).resolves.toBe(limited);
    await policy();
    expect(executionPolicy).toHaveBeenCalledTimes(2);
    expect(executionPolicy).toHaveBeenCalledWith("/repo/sub");
  });

  it("hands a live thread back instead of opening its session file twice", async () => {
    const existing = new ThreadRuntime(externalBackend("thread") as never);
    const { lifecycle } = makeLifecycle({ liveThreadForPath: () => existing });
    await expect(lifecycle.openForPath("/a.jsonl", "resume")).resolves.toBe(existing);
    expect(lifecycle.isOpening("/a.jsonl")).toBe(false);
  });

  it("shares one open between concurrent callers for the same path", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const backend = externalBackend("thread");
    const provider = {
      lookup: async () => ({ threadId: "thread", cwd: "/repo" }),
      open: async () => { await gate; return backend; },
    };
    const { lifecycle } = makeLifecycle({ indexedSession: () => ({ id: "thread", backendKind: "test" }) as never }, { test: provider });
    const first = lifecycle.openForPath("/a.jsonl", "resume");
    const second = lifecycle.openForPath("/a.jsonl", "resume");
    expect(lifecycle.isOpening("/a.jsonl")).toBe(true);
    release();
    expect(await first).toBe(await second);
    expect(lifecycle.isOpening("/a.jsonl")).toBe(false);
  });

  it("refuses to open a thread with a different backend than persisted (ADR 0005)", async () => {
    const provider = { lookup: async () => ({ threadId: "thread", cwd: "/repo" }), open: async () => externalBackend("thread") };
    const { lifecycle } = makeLifecycle(
      { indexedSession: () => ({ id: "thread", backendKind: "existing-backend" }) as never },
      { "existing-backend": provider, "requested-backend": provider },
    );
    await expect(lifecycle.openForPath("/a.jsonl", "resume", false, "requested-backend" as never))
      .rejects.toThrow(/belongs to backend existing-backend.*refusing to open it as requested-backend/u);
  });

  it("refuses a path whose backend no longer knows the thread", async () => {
    const provider = { lookup: async () => undefined };
    const { lifecycle } = makeLifecycle({ indexedSession: () => ({ id: "thread", backendKind: "test" }) as never }, { test: provider });
    await expect(lifecycle.openForPath("/a.jsonl", "resume")).rejects.toThrow("no longer available");
  });

  it("opens a thread read-only when its runtime cannot start, and says why", async () => {
    const provider = {
      adapter: PI_AGENT_RUNTIME_ADAPTER,
      lookup: async () => ({ threadId: "thread", cwd: "/repo", title: "Kept", updatedAt: 5, messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }] }),
      open: async () => { throw new Error("The Codex CLI was not found."); },
    };
    const { lifecycle, port, adopted } = makeLifecycle({ indexedSession: () => ({ id: "thread", backendKind: "test" }) as never }, { test: provider });
    const thread = await lifecycle.openForPath("/a.jsonl", "resume");
    expect(adopted).toEqual([thread]);
    expect(thread.adapterMessages.map((message) => message.text)).toEqual(["hello", "hi"]);
    expect(thread.state).toMatchObject({ streaming: false, idle: true, hasMessages: true, title: "Kept" });
    expect(port.runtimeUnavailable).toHaveBeenCalledWith("thread", "The Codex CLI was not found.");
    await expect(thread.backend.prompt({ text: "again", delivery: "prompt" } as never)).rejects.toThrow("The Codex CLI was not found.");

    // A prewarm in the background still fails, and a runtime that starts clears the mark.
    await expect(lifecycle.openForPath("/b.jsonl", "resume", true)).rejects.toThrow("not found");
    provider.open = async () => externalBackend("thread") as never;
    await lifecycle.openForPath("/c.jsonl", "resume");
    expect(port.runtimeUnavailable).toHaveBeenLastCalledWith("thread", undefined);
  });

  it("aborts a streaming backend before disposing it and releases its tools", async () => {
    const backend = externalBackend("thread", { streaming: true });
    const thread = new ThreadRuntime(backend as never);
    thread.tools.set("call", {} as never);
    const { lifecycle, released, port } = makeLifecycle();
    await lifecycle.dispose(thread);
    expect(backend.abort).toHaveBeenCalled();
    expect(backend.dispose).toHaveBeenCalled();
    expect(released).toEqual(["call"]);
    expect(port.turnObservers.closed).toHaveBeenCalledWith("thread");
  });

  it("collects a failing teardown into one aggregate", async () => {
    const backend = externalBackend("thread");
    backend.dispose = vi.fn(async () => { throw new Error("dispose failed"); });
    const thread = new ThreadRuntime(backend as never);
    const { lifecycle } = makeLifecycle();
    await expect(lifecycle.dispose(thread)).rejects.toThrow(AggregateError);
  });

  it("answers a stable resource fingerprint that safe mode changes", () => {
    const full = makeLifecycle().lifecycle;
    const safe = makeLifecycle({ safeMode: true }).lifecycle;
    expect(full.fingerprint("/repo")).toBe(full.fingerprint("/repo"));
    expect(full.fingerprint("/repo")).not.toBe(safe.fingerprint("/repo"));
    expect(full.fingerprint("/repo")).not.toBe(full.fingerprint("/other"));
  });
});

describe("shell command prefixes of runtime extensions", () => {
  const noop: ExtensionFactory = () => undefined;

  it("puts the extensions' lines before the user's own and adds nothing when none asks", () => {
    expect(composeShellCommandPrefix([], undefined)).toBeUndefined();
    expect(composeShellCommandPrefix([{ name: "a", factory: noop, shellCommandPrefix: " " }], "")).toBeUndefined();
    expect(composeShellCommandPrefix([{ name: "a", factory: noop }], "shopt -s expand_aliases")).toBe("shopt -s expand_aliases");
    expect(composeShellCommandPrefix(
      [{ name: "a", factory: noop, shellCommandPrefix: "renice -n 10 -p $$" }, { name: "b", factory: noop }],
      "shopt -s expand_aliases",
    )).toBe("renice -n 10 -p $$\nshopt -s expand_aliases");
  });

  it.skipIf(process.platform === "win32")("runs them in the shell outside a command a tool_call handler wrapped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-shell-prefix-"));
    try {
      // A sandbox-like wrapper: the command runs in a shell of its own, which it marks.
      const wrap: ExtensionFactory = (pi) => {
        pi.on("tool_call", (event) => {
          const input = event.input as { command: string };
          input.command = `/bin/bash -c 'WRAPPED=yes; ${input.command.replaceAll("'", "'\\''")}'`;
          return undefined;
        });
      };
      const sessions: RuntimeSessionInfo[] = [];
      const { lifecycle } = makeLifecycle({
        runtimeExtensions: (_settings, session) => {
          sessions.push(session);
          return [{ name: "wrap", factory: wrap }, { name: "prefix", factory: noop, shellCommandPrefix: "echo prefix:${WRAPPED:-no}" }];
        },
      });
      const sessionManager = SessionManager.inMemory(dir);
      sessionManager.appendCustomEntry(PARENT_LINK_ENTRY, parentLinkEntry("parent-thread"));
      const create = (lifecycle as unknown as { create: (options: unknown) => Promise<{ session: any }> }).create;
      const { session } = await create({ cwd: dir, agentDir: dir, sessionManager });
      expect(sessions).toEqual([{ sessionId: sessionManager.getSessionId(), cwd: dir, parentThreadId: "parent-thread" }]);
      // Pi re-reads its settings files on every reload; the line has to outlive that.
      await session.settingsManager.reload();
      expect(session.settingsManager.getShellCommandPrefix()).toBe("echo prefix:${WRAPPED:-no}");

      const args = { command: "echo command:$WRAPPED" };
      await session.agent.beforeToolCall({ toolCall: { id: "call-1", name: "bash" }, args });
      const result = await session.getToolDefinition("bash").execute("call-1", args, undefined, undefined, undefined);
      const text = result.content.map((part: { text?: string }) => part.text ?? "").join("");
      expect(text).toBe("prefix:no\ncommand:yes\n");
      session.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("temperature and max tokens from Tau's config", () => {
  /** A model on 127.0.0.1 speaking OpenAI's streamed chat completions; it keeps each request body. */
  async function fakeModel() {
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
      request.on("end", () => {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
        const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "fake-1" };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] }));
        response.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    return { baseUrl: `http://127.0.0.1:${port}/v1`, bodies, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it("reach the provider request of a real turn, also after a reload, and a later edit applies to the next turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-sampling-"));
    const model = await fakeModel();
    try {
      const models = { providers: { "tau-fake": { baseUrl: model.baseUrl, api: "openai-completions", apiKey: "fake", models: [{ id: "fake-1", name: "Fake 1", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 4_096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } };
      await writeFile(join(dir, "models.json"), JSON.stringify(models));
      await writeFile(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "tau-fake", defaultModel: "fake-1" }));
      await mkdir(join(dir, ".tau"));
      await writeFile(join(dir, ".tau", "config.json"), JSON.stringify({ temperature: 0.2, maxTokens: 1234 }));
      const { lifecycle } = makeLifecycle({ agentDir: dir });
      const create = (lifecycle as unknown as { create: (options: unknown) => Promise<{ session: any }> }).create;
      const { session } = await create({ cwd: dir, agentDir: dir, sessionManager: SessionManager.inMemory(dir) });

      await session.prompt("hello");
      expect(model.bodies.at(-1)).toMatchObject({ model: "fake-1", temperature: 0.2, max_completion_tokens: 1234 });

      // Pi rebuilds its settings from the files on every reload.
      await session.reload();
      await writeFile(join(dir, ".tau", "config.json"), JSON.stringify({ temperature: 0.7 }));
      await session.prompt("again");
      // Cleared, the limit is the model's own again.
      expect(model.bodies.at(-1)).toMatchObject({ temperature: 0.7, max_completion_tokens: 4096 });
      session.dispose();
    } finally {
      await model.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a Pi session two hosts on one machine both reach", () => {
  const SESSION_ID = "shared-session";

  /** A session file both hosts find, in a folder that exists, as their shared `~/.pi/agent/sessions` would hold it. */
  async function sharedSession(dir: string): Promise<string> {
    const path = join(dir, `${SESSION_ID}.jsonl`);
    const timestamp = new Date(Date.UTC(2026, 0, 1)).toISOString();
    await writeFile(path, [
      JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp, cwd: dir }),
      JSON.stringify({ type: "message", id: "entry-1", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "Count" }], timestamp: 1 } }),
      JSON.stringify({ type: "message", id: "entry-2", parentId: "entry-1", timestamp, message: { role: "assistant", content: [{ type: "text", text: "One" }], timestamp: 2 } }),
      "",
    ].join("\n"));
    return path;
  }

  it("is written by one of them; the other reads it and writes nothing until it is let go", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-shared-session-"));
    try {
      const path = await sharedSession(dir);
      const first = makeLifecycle({ agentDir: dir, cwd: () => dir, sessionLocks: new SessionLocks({ dataFolder: "/data/window" }) });
      const second = makeLifecycle({ agentDir: dir, cwd: () => dir, sessionLocks: new SessionLocks({ dataFolder: "/data/service" }) });
      const live = await first.lifecycle.openForPath(path, "resume");
      expect(isUnavailableBackend(live.backend)).toBe(false);
      const before = await readFile(path, "utf8");

      await expect(second.lifecycle.openForPath(path, "resume", true)).rejects.toThrow(SessionHeldElsewhereError);
      const held = await second.lifecycle.openForPath(path, "resume");
      expect(isUnavailableBackend(held.backend)).toBe(true);
      expect(held.threadId).toBe(SESSION_ID);
      expect(held.sessionFile).toBe(path);
      // Read from the file, the first host's own additions included.
      expect(held.entries.filter((entry) => (entry as { type: string }).type === "message")).toHaveLength(2);
      const why = `This thread is open in another Tau host (pid ${process.pid}, data folder /data/window). It is read-only here until that host closes it.`;
      expect(second.port.runtimeUnavailable).toHaveBeenCalledWith(SESSION_ID, why);
      await expect(held.backend.prompt({} as never)).rejects.toThrow(why);
      expect(() => held.appendJournalEntry("note", {})).toThrow(why);
      expect(await readFile(path, "utf8")).toBe(before);

      // The first host lets go; the next open in the second one gets the runtime.
      await first.lifecycle.dispose(live);
      const taken = await second.lifecycle.openForPath(path, "resume");
      expect(isUnavailableBackend(taken.backend)).toBe(false);
      expect(second.port.runtimeUnavailable).toHaveBeenLastCalledWith(SESSION_ID, undefined);
      await expect(first.lifecycle.openForPath(path, "resume", true)).rejects.toThrow(SessionHeldElsewhereError);
      await second.lifecycle.dispose(taken);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  /** A session in Pi's format 2 without its last newline: two repairs Pi's open would write. */
  async function olderSession(dir: string, name: string): Promise<string> {
    const path = join(dir, `${name}.jsonl`);
    const timestamp = new Date(Date.UTC(2026, 0, 1)).toISOString();
    await writeFile(path, [
      JSON.stringify({ type: "session", version: 2, id: name, timestamp, cwd: dir }),
      JSON.stringify({ type: "message", id: "entry-1", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "Count" }], timestamp: 1 } }),
    ].join("\n"));
    return path;
  }

  it("is not repaired by the host that only reads it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-shared-session-"));
    try {
      const path = await olderSession(dir, SESSION_ID);
      const writer = new SessionLocks({ dataFolder: "/data/window" });
      await writer.acquire(path);
      const before = await readFile(path, "utf8");
      const reader = makeLifecycle({ agentDir: dir, cwd: () => dir, sessionLocks: new SessionLocks({ dataFolder: "/data/service" }) });

      const held = await reader.lifecycle.openForPath(path, "resume");
      expect(isUnavailableBackend(held.backend)).toBe(true);
      expect(held.entries.filter((entry) => (entry as { type: string }).type === "message")).toHaveLength(1);
      await expect(reader.lifecycle.openRecent(dir, dir)).rejects.toThrow(SessionHeldElsewhereError);
      expect(await readFile(path, "utf8")).toBe(before);

      // Free again: the host that opens it now repairs it, holding it while Pi does.
      writer.releaseAll();
      const manager = await reader.lifecycle.openRecent(dir, dir);
      expect(manager.getSessionFile()).toBe(path);
      expect(JSON.parse((await readFile(path, "utf8")).split("\n")[0]!)).toMatchObject({ version: 3 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
