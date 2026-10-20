import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { DEFAULT_BACKGROUND_LIMIT } from "./lifecycle-queue.js";
import { PiHost } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { ThreadRuntime } from "./thread-runtime.js";

/** A live Pi thread that records what was delivered to it. */
function fakeThread(threadId: string, delivered: string[], images = false, nativeFiles = false): ThreadRuntime {
  let hasMessages = false;
  const adapter = nativeFiles ? { ...PI_AGENT_RUNTIME_ADAPTER, capabilities: { ...PI_AGENT_RUNTIME_ADAPTER.capabilities, fileAttachments: true } } : PI_AGENT_RUNTIME_ADAPTER;
  const backend = {
    kind: "pi" as const,
    runtimeAdapter: adapter,
    threadId,
    providerSessionId: threadId,
    cwd: "/repo",
    turnReporting: "streamed" as const,
    capabilities: {
      journal: { entries: () => [], appendCustomEntry: () => undefined, appendMessage: () => undefined },
    },
    preparePrompt: async (text: string) => ({
      tauThreadId: threadId,
      providerSessionId: threadId,
      sessionId: threadId,
      backendKind: "pi" as const,
      runtimeCapabilities: adapter.capabilities,
      visibleText: text,
      runtimeText: text,
      sourceFingerprint: clientMessageFingerprint(text, []),
    }),
    composerCommands: () => [],
    prompt: async (input: { text: string; onAdmitted?: (accepted: boolean) => void }) => {
      delivered.push(`${threadId}:${input.text}`);
      hasMessages = true;
      input.onAdmitted?.(true);
      return {};
    },
    state: () => ({
      streaming: false,
      idle: true,
      hasMessages,
      sessionFile: `/${threadId}.jsonl`,
      activeTools: [],
      supportsImageInput: images,
      extensionCount: 0,
    }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }),
    models: async () => [],
    transcript: async () => [],
    persist: async () => undefined,
    setTitle: async () => undefined,
    abort: async () => undefined,
    dispose: async () => undefined,
    start: async () => undefined,
    waitForIdle: async () => undefined,
  };
  const runtime = {
    session: { sessionId: threadId, abort: async () => undefined, dispose: async () => undefined },
    dispose: async () => undefined,
  };
  return new ThreadRuntime(backend as never, runtime as never);
}

/** A host with one thread on screen and every background start held open. */
function hostWithHeldStarts() {
  const delivered: string[] = [];
  const history = { list: () => [], isHidden: () => false, iconFor: async () => undefined, remember: async () => undefined };
  const host = new PiHost("/repo", () => undefined, history as never, false, false);
  const internals = host as unknown as Record<string, any>;
  internals.rememberProject = async () => {};
  internals.index.refreshShell = async () => {};
  internals.index.refresh = async () => {};
  internals.index.startRecovery = () => {};
  internals.prewarm.scheduleThreads = () => {};
  internals.prewarm.scheduleSpare = () => {};
  internals.projects.label = () => undefined;

  const active = fakeThread("active", delivered);
  internals.threads.adopt({ threadId: "active", cwd: "/repo", runtime: active, isolation: "in-process" });
  internals.threads.setActive("active");
  internals.cwd = "/repo";

  let opening = 0;
  let peakOpening = 0;
  const releases: Array<() => void> = [];
  let opened = 0;
  internals.runtimes.open = async () => {
    opening += 1;
    peakOpening = Math.max(peakOpening, opening);
    await new Promise<void>((resolve) => { releases.push(resolve); });
    opening -= 1;
    opened += 1;
    return fakeThread(`child-${opened}`, delivered);
  };

  const start = (title: string) => internals.startThread({ cwd: "/repo", prompt: `work on ${title}` });
  return {
    host,
    internals,
    delivered,
    start,
    releases,
    inFlight: () => opening,
    peak: () => peakOpening,
  };
}

describe("PiHost background thread starts", () => {
  it("builds several background threads at once instead of one after another", async () => {
    const bench = hostWithHeldStarts();
    const starts = Array.from({ length: 20 }, (_, index) => bench.start(`T${index}`));
    await vi.waitFor(() => { expect(bench.inFlight()).toBe(DEFAULT_BACKGROUND_LIMIT); });
    // Genuinely overlapping, and still bounded: the old queue admitted one.
    expect(bench.peak()).toBe(DEFAULT_BACKGROUND_LIMIT);
    while (bench.releases.length > 0) {
      bench.releases.pop()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(starts);
    expect(bench.peak()).toBe(DEFAULT_BACKGROUND_LIMIT);
  });

  it("delivers a prompt to the thread on screen while background threads are being built", async () => {
    const bench = hostWithHeldStarts();
    const starts = Array.from({ length: 20 }, (_, index) => bench.start(`T${index}`));
    await vi.waitFor(() => { expect(bench.inFlight()).toBe(DEFAULT_BACKGROUND_LIMIT); });

    // Nothing has been released, so every background start still holds the lane.
    const prepared = await bench.host.preparePrompt("hello", "active");
    await bench.host.prompt("hello", [], "active", undefined, prepared);
    expect(bench.delivered).toContain("active:hello");

    while (bench.releases.length > 0) {
      bench.releases.pop()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(starts);
  });
});

describe("PiHost background starts on another runtime backend", () => {
  it("opens the named backend and keeps the parent link in the index", async () => {
    const bench = hostWithHeldStarts();
    const opened: Array<{ kind: string; cwd: string; options: unknown }> = [];
    bench.internals.seam.backends.set("fake", { kind: "fake" });
    bench.internals.runtimes.openExternal = async (kind: string, threadId: string, cwd: string, options: unknown) => {
      opened.push({ kind, cwd, options });
      return fakeThread(threadId, bench.delivered);
    };
    const started = await bench.internals.startThread({ cwd: "/repo", prompt: "hello", backend: "fake", parent: { threadId: "active" } });
    expect(opened).toEqual([{ kind: "fake", cwd: "/repo", options: { resume: false, adopt: false } }]);
    expect(bench.internals.index.parentOf(started.sessionId)).toBe("active");
    await vi.waitFor(() => { expect(bench.delivered).toContain(`${started.sessionId}:hello`); });
  });

  it("hands a tool list to a backend that restricts its tools, and refuses it for any other", async () => {
    const bench = hostWithHeldStarts();
    const opened: unknown[] = [];
    bench.internals.seam.backends.set("strict", { kind: "strict", restrictsTools: true });
    bench.internals.seam.backends.set("loose", { kind: "loose", label: "Loose" });
    bench.internals.runtimes.openExternal = async (_kind: string, threadId: string, _cwd: string, options: unknown) => {
      opened.push(options);
      return fakeThread(threadId, bench.delivered);
    };
    await bench.internals.startThread({ cwd: "/repo", prompt: "hello", backend: "strict", tools: ["read", "tau_spawn_thread"] });
    expect(opened).toEqual([{ resume: false, adopt: false, tools: ["read", "tau_spawn_thread"] }]);

    await expect(bench.internals.startThread({ cwd: "/repo", prompt: "hello", backend: "loose", tools: ["read"] }))
      .rejects.toThrow("The Loose runtime cannot restrict its tools.");
    await expect(bench.internals.startThread({ cwd: "/repo", prompt: "hello", tools: ["read"] }))
      .rejects.toThrow("The pi runtime cannot restrict its tools when a thread starts");
    expect(opened).toHaveLength(1);
    expect(bench.inFlight()).toBe(0);
  });

  it("delivers shared images and host file references through background prompt admission", async () => {
    const bench = hostWithHeldStarts();
    const attachment = { kind: "image" as const, name: "shot.png", mimeType: "image/png", data: "aGVsbG8=", size: 5 };
    const file = { kind: "file" as const, name: "spec.md", mimeType: "text/markdown", path: "/shared/spec.md", size: 5 };
    bench.internals.seam.backends.set("claude-code", { kind: "claude-code" });
    bench.internals.runtimes.openExternal = async () => fakeThread("child", bench.delivered, true);
    const prompt = vi.spyOn(bench.host, "prompt");
    await bench.internals.startThread({ cwd: "/repo", prompt: "read these", backend: "claude-code", attachments: [attachment, file] });
    expect(prompt).toHaveBeenCalledWith("read these\n\nAttached files:\n- /shared/spec.md", [attachment], "child", undefined, expect.any(Object));
    expect(bench.delivered).toContain("child:read these\n\nAttached files:\n- /shared/spec.md");
  });

  it("keeps file payloads native when the selected backend accepts them", async () => {
    const bench = hostWithHeldStarts();
    const file = { kind: "file" as const, name: "spec.md", mimeType: "text/markdown", path: "/shared/spec.md", size: 5 };
    bench.internals.seam.backends.set("codex", { kind: "codex" });
    bench.internals.runtimes.openExternal = async () => fakeThread("native", bench.delivered, false, true);
    const prompt = vi.spyOn(bench.host, "prompt");
    await bench.internals.startThread({ cwd: "/repo", prompt: "read this", backend: "codex", attachments: [file] });
    expect(prompt).toHaveBeenCalledWith("read this", [file], "native", undefined, expect.any(Object));
  });

  it("rejects before admission and removes the unused thread", async () => {
    const bench = hostWithHeldStarts();
    bench.internals.seam.backends.set("codex", { kind: "codex" });
    bench.internals.runtimes.openExternal = async () => fakeThread("rejected", bench.delivered);
    bench.internals.discardFailedStart = vi.fn(async () => undefined);
    vi.spyOn(bench.host, "prompt").mockRejectedValue(new Error("Authentication failed"));
    await expect(bench.internals.startThread({ cwd: "/repo", prompt: "hello", backend: "codex" })).rejects.toThrow("Authentication failed");
    expect(bench.internals.threads.has("rejected")).toBe(false);
    expect(bench.internals.discardFailedStart).toHaveBeenCalledWith(expect.objectContaining({ backend: expect.objectContaining({ threadId: "rejected" }) }));
  });

  it("refuses a backend nobody registered before it creates anything", async () => {
    const bench = hostWithHeldStarts();
    await expect(bench.internals.startThread({ cwd: "/repo", prompt: "hello", backend: "missing" }))
      .rejects.toThrow('Runtime backend "missing" is not installed');
    expect(bench.inFlight()).toBe(0);
  });
});


describe("background start preparation", () => {
  it("awaits preparation on the new thread before delivering its first prompt", async () => {
    const bench = hostWithHeldStarts();
    bench.internals.seam.backends.set("fake", { kind: "fake" });
    bench.internals.runtimes.openExternal = async (_kind: string, id: string) => fakeThread(id, bench.delivered);
    let release!: () => void;
    const beforePrompt = vi.fn(async (thread) => {
      expect(thread.cwd).toBe("/repo");
      expect(thread.entries()).toEqual([]);
      await new Promise<void>((resolve) => { release = resolve; });
    });
    const pending = bench.host.startThread({ cwd: "/repo", backend: "fake", prompt: "inspect", beforePrompt });
    await vi.waitFor(() => expect(beforePrompt).toHaveBeenCalledTimes(1));
    expect(bench.delivered).toEqual([]);
    release();
    const started = await pending;
    await vi.waitFor(() => expect(bench.delivered).toEqual([`${started.sessionId}:inspect`]));
  });

  it("removes the unused thread when preparation rejects", async () => {
    const bench = hostWithHeldStarts();
    let created = "";
    bench.internals.seam.backends.set("fake", { kind: "fake" });
    bench.internals.runtimes.openExternal = async (_kind: string, id: string) => { created = id; return fakeThread(id, bench.delivered); };
    await expect(bench.host.startThread({ cwd: "/repo", backend: "fake", prompt: "inspect", beforePrompt: async () => { throw new Error("Preparation refused"); } })).rejects.toThrow("Preparation refused");
    expect(bench.delivered).toEqual([]);
    expect(created).not.toBe("");
    expect(bench.internals.threads.get(created)).toBeUndefined();
  });
});

it("keeps automatic spare preparation behind an admitted turn's held preflight", async () => {
  vi.useFakeTimers();
  const delivered: string[] = [];
  const history = { list: () => [], isHidden: () => false, iconFor: async () => undefined, remember: async () => undefined, flush: async () => undefined };
  // Construct PiHost so the preparation queue uses the actual components gate.
  const host = new PiHost("/repo", () => undefined, history as never, false, false);
  const internals = host as unknown as Record<string, any>;
  const active = fakeThread("active", delivered);
  internals.threads.adopt({ threadId: "active", cwd: "/repo", runtime: active, isolation: "in-process" });
  internals.threads.setActive("active");
  internals.index.scannedOnce = true;
  internals.index.refreshShell = async () => {};
  internals.prewarm.port.automatic = true;
  internals.prewarm.port.isDirectory = () => true;
  const opened = vi.spyOn(internals.runtimes, "open").mockResolvedValue(fakeThread("spare", delivered));
  vi.spyOn(internals.runtimes, "dispose").mockResolvedValue(undefined);
  // Session creation is a runtime boundary; keep this fixture out of Pi's real directory.
  const create = vi.spyOn(SessionManager, "create").mockReturnValue({ getSessionId: () => "spare" } as never);
  let release!: () => void;
  let reached!: () => void;
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  internals.turnObservers.add({ prepare: async () => { reached(); await held; } });
  const pending = host.prompt("foreground work", [], "active");
  try {
    await entered;
    expect(internals.turnsInFlight.get("active")?.writer?.pid).toBe(process.pid);
    expect(active.state.streaming).toBe(false);
    expect(active.adapterPending).toBe(0);
    expect(internals.lifecycle.currentOperation).toBeUndefined();
    internals.prewarm.scheduleSpare("/repo");
    await vi.advanceTimersByTimeAsync(100);
    expect(opened, "optional runtime work must wait for foreground preflight").not.toHaveBeenCalled();
    release();
    await pending;
    await vi.advanceTimersByTimeAsync(200);
    expect(opened).toHaveBeenCalledOnce();
  } finally {
    release();
    await pending;
    await host.dispose();
    internals.prewarm.preparation.dispose();
    create.mockRestore();
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it("releases a new thread of another backend whose start configuration fails", async () => {
  const bench = hostWithHeldStarts();
  bench.internals.seam.backends.set("fake", {
    kind: "fake", label: "Fake", adapter: PI_AGENT_RUNTIME_ADAPTER,
    open: async (threadId: string) => Object.assign(fakeThread(threadId, bench.delivered).backend, { kind: "fake" }),
  });
  vi.spyOn(bench.internals.runtimes, "dispose").mockResolvedValue(undefined);
  const result = await bench.host.newSession("hello", [], "/repo", undefined, { backendKind: "fake", sessionId: "draft" } as never, { mode: "plan" });
  expect((result as { submission?: { accepted: boolean } }).submission?.accepted).toBe(false);
  expect(bench.internals.threads.list().map((record: { threadId: string }) => record.threadId)).toEqual(["active"]);
});

describe("a prompt whose runtime may go while it prepares", () => {
  function preparing() {
    const delivered: string[] = [];
    const history = { list: () => [], isHidden: () => false, iconFor: async () => undefined, remember: async () => undefined };
    const host = new PiHost("/repo", () => undefined, history as never, false, false);
    const internals = host as unknown as Record<string, any>;
    internals.index.refreshShell = async () => {};
    vi.spyOn(internals.runtimes, "dispose").mockResolvedValue(undefined);
    const thread = fakeThread("background", delivered);
    const state = thread.backend.state.bind(thread.backend);
    thread.backend.state = () => ({ ...state(), hasMessages: true });
    internals.threads.adopt({ threadId: "background", cwd: "/repo", runtime: thread, isolation: "in-process" });
    let reached!: () => void;
    let release!: (error?: Error) => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const held = new Promise<void>((resolve, reject) => { release = (error) => { if (error) reject(error); else resolve(); }; });
    internals.turnObservers.add({ prepare: async () => { reached(); await held; } });
    return { host, internals, thread, delivered, entered, release };
  }

  it("keeps the runtime of a prompt that is still preparing", async () => {
    const bench = preparing();
    const pending = bench.host.prompt("queued work", [], "background");
    await bench.entered;
    expect(bench.internals.threads.idleThreadIds(0)).toEqual([]);
    bench.release();
    await pending;
    expect(bench.delivered).toEqual(["background:queued work"]);
  });

  it("rejects the prompt and forgets its turn when the released runtime's preparation fails", async () => {
    const bench = preparing();
    const pending = bench.host.prompt("queued work", [], "background");
    await bench.entered;
    await bench.internals.threads.release("background");
    bench.release(new Error("Preparation failed"));
    await expect(pending).rejects.toThrow("Preparation failed");
    expect(bench.internals.turnsInFlight.get("background")).toBeUndefined();
    expect(bench.delivered).toEqual([]);
  });

  it("settles the prompt when the released runtime refuses it before admission", async () => {
    const bench = preparing();
    (bench.thread.backend as { prompt: unknown }).prompt = async () => { throw new Error("Runtime stopped"); };
    const pending = bench.host.prompt("queued work", [], "background");
    await bench.entered;
    await bench.internals.threads.release("background");
    bench.release();
    await expect(pending).rejects.toThrow("Runtime stopped");
    expect(bench.internals.turnsInFlight.get("background")).toBeUndefined();
  });
});
