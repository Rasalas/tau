import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HostMachineServices,
  HostMachineEvent,
  HostMachine,
  HostTrashedThread,
  HostExtension,
  HostExtensionContext,
  HostExtensionServices,
  HostSessionSummary,
  HostMcpTool,
  HostMcpToolProvider,
  HostThreadLifecycle,
  HostTurnObserver,
} from "tau/host-extension";
import type { UiSession } from "tau";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { ownedProcessTree } from "../../src/main/test-support/owned-process-tree.js";
import { MACHINE_STATE_TOPIC, MACHINE_META_EVENT, MACHINE_TRASH_EVENT } from "./machine-state.js";
import { DAY_MS, railSections } from "./meta.js";
import { createThreadRailHostExtension } from "./host.js";
import { META_EVENT, REVIEW_EXTENSION_ID, THREAD_RAIL_EXTENSION_ID, TRASH_EVENT, type RailState } from "./protocol.js";

const NOW = 1_000_000_000_000;
const made: string[] = [];
const registries: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.dispose()));
  await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-thread-rail-"));
  made.push(directory);
  return directory;
}

interface Setup {
  watchShelf?: (input: unknown) => unknown;
  machines?: HostMachineServices;
  stateDir?: string;
  sessions?: HostSessionSummary[];
  modified?: Record<string, number>;
  review?: (workspace: string, input: { fresh?: boolean }) => unknown;
  integrated?: (workspace: string, targets?: string[]) => unknown;
  /** Review Kit's answer about the requests threads link. */
  linked?: (threadIds: string[]) => unknown;
  /** The host's thread index (`sessions.refreshIndex`). */
  index?: UiSession[];
  /** Review Kit's `thread-request-links`. */
  requestLinks?: (input: { threadIds?: string[]; query?: string }) => unknown;
  now?: () => number;
}

async function harness(setup: Setup = {}) {
  const stateDir = setup.stateDir ?? await scratch();
  const events: PublishedKitEvent[] = [];
  const observers: HostTurnObserver[] = [];
  const toolProviders: HostMcpToolProvider[] = [];
  const instructions: unknown[] = [];
  const runtimeExtensions: string[] = [];
  const lifecycles: HostThreadLifecycle[] = [];
  const start = vi.fn(async (options: { cwd: string }) => ({ sessionId: `started-${start.mock.calls.length}`, cwd: options.cwd }));
  const trash: Array<{ sessionId: string }> = [];
  const removed = vi.fn(async (sessionId: string) => { trash.push({ sessionId }); });
  const restored = vi.fn(async (sessionId: string) => { trash.splice(trash.findIndex((entry) => entry.sessionId === sessionId), 1); });
  const services: Partial<HostExtensionServices> = {
    stateDir,
    machines: setup.machines ?? machineServices().services,
    sessions: {
      list: async () => setup.sessions ?? [],
      start,
      remove: removed,
      restore: restored,
      purge: restored,
      trash: async () => [...trash],
      refreshIndex: async () => ({ version: 1, type: "thread-index", index: { projects: [], sessions: setup.index ?? [] } }),
    } as unknown as HostExtensionServices["sessions"],
    mcp: {
      registerTools: (provider) => { toolProviders.push(provider); return () => undefined; },
      gate: () => () => undefined,
      registerInstructions: (provider) => { instructions.push(provider); return () => undefined; },
      connect: async () => undefined,
    },
    registerRuntimeExtension: (name) => { runtimeExtensions.push(name); return () => undefined; },
    registerTurnObserver: (observer) => { observers.push(observer); return () => undefined; },
    registerThreadLifecycle: (lifecycle) => { lifecycles.push(lifecycle); return () => undefined; },
  };
  const registry = await activateHostKit(
    createThreadRailHostExtension({
      now: setup.now ?? (() => NOW),
      sweepMs: 1_000_000_000,
      modifiedAt: async (path) => setup.modified?.[path],
    }),
    services,
    (event) => events.push(event),
  );
  registries.push(registry);
  if (setup.review || setup.watchShelf || setup.requestLinks) {
    const review: HostExtension = {
      id: REVIEW_EXTENSION_ID,
      name: "Review Kit",
      activate(context: HostExtensionContext) {
        if (setup.watchShelf) context.registerCommand("watch-shelf", setup.watchShelf, { access: "owner", callers: [THREAD_RAIL_EXTENSION_ID] });
        if (setup.requestLinks) context.registerCommand("thread-request-links", (input) => setup.requestLinks!(input as { threadIds?: string[]; query?: string }), { access: "read", callers: [THREAD_RAIL_EXTENSION_ID] });
        context.registerCommand("pr-status", (input) => setup.review?.((input as { workspace: string }).workspace, input as { fresh?: boolean }), { callers: [THREAD_RAIL_EXTENSION_ID] });
        if (setup.linked) context.registerCommand("thread-requests", (input) => setup.linked!((input as { threadIds: string[] }).threadIds), { callers: [THREAD_RAIL_EXTENSION_ID] });
      },
    };
    await registry.activate(review);
    await registry.activate({
      id: "tau.workspace", name: "Workspace Kit",
      activate(context) {
        context.registerCommand("thread-work-integrated", (input) => setup.integrated
          ? setup.integrated((input as { workspace: string }).workspace, (input as { targets?: string[] }).targets)
          : { integrated: true }, { access: "read", callers: [THREAD_RAIL_EXTENSION_ID] });
      },
    });
  }
  const invoke = (command: string, input?: unknown) => registry.invoke(THREAD_RAIL_EXTENSION_ID, command, input) as Promise<RailState>;
  /** The tools one thread is offered over MCP, by name. */
  const tools = async (threadId: string) => {
    const offered = (await Promise.all(toolProviders.map((provider) => provider({ sessionId: threadId, cwd: "/project" })))).flat();
    return new Map<string, HostMcpTool>(offered.map((tool) => [tool.name, tool]));
  };
  return { invoke, events, observers, lifecycles, start, stateDir, removed, restored, registry, tools, instructions, runtimeExtensions };
}

function machineServices(initial: HostMachine[] = [], self = "here") {
  let list = initial;
  const listeners = new Set<(machines: readonly HostMachine[]) => void>();
  const indexListeners = new Set<(machine: string) => void>();
  const watched = new Map<string, (event: HostMachineEvent) => void>();
  const stopped = vi.fn();
  const call = vi.fn<HostMachineServices["call"]>(async (_machine, _extension, command) => command === "trash" ? [] : { threads: {}, settings: { onMerged: true, onClosed: true } });
  const services: HostMachineServices = {
    self: { id: self, name: self, version: "1" },
    list: () => list,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeIndex: (listener) => { indexListeners.add(listener); return () => { indexListeners.delete(listener); }; },
    call,
    request: async () => undefined,
    upload: async () => ({ id: "blob", size: 0, sha256: "" }),
    watch: (machine, topic, listener) => {
      expect(topic).toBe(MACHINE_STATE_TOPIC);
      watched.set(machine, listener);
      return () => { watched.delete(machine); stopped(machine); };
    },
  };
  return {
    services, call, watched, stopped, listeners, indexListeners,
    update(next: HostMachine[]) { list = next; for (const listener of listeners) listener(next); },
    index(machine: string) { for (const listener of indexListeners) listener(machine); },
    emit(machine: string, name: string, payload: unknown) { watched.get(machine)?.({ name, payload }); },
  };
}

const rex: HostMachine = { id: "rex", name: "Rex", status: "connected" };
const proxy = (id: string): HostSessionSummary => ({ sessionId: id, path: `tau-thread:machine:${id}`, cwd: "/rex/project" });
const remoteTrash = (sessionId: string): HostTrashedThread => ({ sessionId, cwd: "/rex/project", title: "Deleted", backendKind: "pi", deletedAt: NOW, purgeAt: NOW + DAY_MS });

const session = (id: string, cwd: string): HostSessionSummary => ({ sessionId: id, path: `/sessions/${id}.jsonl`, cwd });

describe("Thread Rail host", () => {
  it("keeps thread meta in its state folder, pushes each change and reads it back after a restart", async () => {
    const { invoke, events, stateDir } = await harness();
    const state = await invoke("patch", { patches: { a: { pinned: true, pinOrder: 0 }, b: { order: 2, bogus: true } } });
    expect(state.threads).toEqual({ a: { pinned: true, pinOrder: 0 }, b: { order: 2 } });
    expect(events.filter((event) => event.name === META_EVENT).at(-1)?.payload).toEqual(state);

    await vi.waitFor(async () => {
      const stored = JSON.parse(await readFile(join(stateDir, THREAD_RAIL_EXTENSION_ID, "thread-meta.json"), "utf8"));
      expect(stored).toMatchObject({ version: 1, threads: { a: { pinned: true } } });
    });
    const again = await harness({ stateDir });
    const restored = await again.invoke("state");
    expect(restored.threads).toEqual(state.threads);
    expect(restored.settings).toEqual(state.settings);
    expect(restored.publication?.epoch).not.toBe(state.publication?.epoch);
  });

  it("takes a thread off the shelf and out of a snooze when a prompt arrives, and records its activity", async () => {
    let now = NOW;
    const { invoke, observers } = await harness({ now: () => now });
    await invoke("patch", { patches: { settled: { settledAt: 1, settledBy: "user" }, snoozed: { snoozedUntil: NOW + DAY_MS } } });
    now += 10;
    observers[0]!.accepted?.("settled", "turn-1", { deferBefore: false });
    observers[0]!.accepted?.("snoozed", "turn-2", { deferBefore: false });
    const state = await invoke("state");
    expect(state.threads.settled).toEqual({ keptAt: NOW + 10, activityAt: NOW + 10 });
    expect(state.threads.snoozed).toEqual({ activityAt: NOW + 10 });
  });

  it("settles a quiet thread and one whose request merged, but never one that is running", async () => {
    const sessions = [session("quiet", "/project"), session("shared", "/project"), session("merged", "/worktrees/merged"), session("busy", "/worktrees/busy")];
    const review = vi.fn((workspace: string) => ({ request: { url: `https://example.test/${workspace}`, state: "merged" } }));
    const { invoke, observers } = await harness({
      sessions,
      modified: { "/sessions/quiet.jsonl": NOW - 10 * DAY_MS, "/sessions/shared.jsonl": NOW, "/sessions/merged.jsonl": NOW, "/sessions/busy.jsonl": NOW - 10 * DAY_MS },
      review,
      linked: () => ({ merged: [{ url: "https://example.test//worktrees/merged", state: "merged" }] }),
    });
    await invoke("settings", { inactiveDays: 3 });
    observers[0]!.accepted?.("busy", "turn", { deferBefore: false });

    const state = await invoke("sweep");
    expect(review).not.toHaveBeenCalled();
    expect(state.threads.quiet).toMatchObject({ settledBy: "inactive" });
    expect(state.threads.merged).toMatchObject({ settledBy: "pr-merged", settledForRequest: "https://example.test//worktrees/merged" });
    expect(state.threads.shared).toBeUndefined();
    expect(state.threads.busy?.settledAt).toBeUndefined();
  });

  it("settles a thread once every request it links has ended, whatever its checkout", async () => {
    const sessions = [session("done", "/project"), session("waiting", "/project"), session("plain", "/project")];
    const linked = vi.fn(() => ({
      done: [{ url: "https://example.test/pr/1", state: "merged" }, { url: "https://example.test/pr/2", state: "closed" }],
      waiting: [{ url: "https://example.test/pr/3", state: "merged" }, { url: "https://example.test/pr/4" }],
    }));
    const { invoke } = await harness({ sessions, review: () => ({}), linked });
    const state = await invoke("sweep");
    expect(linked).toHaveBeenCalledWith(["done", "waiting", "plain"]);
    expect(state.threads.done).toMatchObject({ settledBy: "pr-merged", settledForRequest: "https://example.test/pr/1 https://example.test/pr/2" });
    expect(state.threads.waiting).toBeUndefined();
    expect(state.threads.plain).toBeUndefined();
  });

  it("keeps a quiet thread whose request is open or unreadable, and still settles one without Review Kit", async () => {
    const sessions = [session("plain", "/project"), session("open", "/project"), session("unknown", "/project")];
    const modified = Object.fromEntries(sessions.map((entry) => [`/sessions/${entry.sessionId}.jsonl`, NOW - 10 * DAY_MS]));
    const linked = () => ({
      open: [{ url: "https://example.test/pr/1", state: "open" }],
      unknown: [{ url: "https://example.test/pr/2" }],
    });
    const quiet = await harness({ sessions, modified, review: () => ({}), linked });
    await quiet.invoke("settings", { inactiveDays: 3, onMerged: false });
    const state = await quiet.invoke("sweep");
    expect(state.threads.plain).toMatchObject({ settledBy: "inactive" });
    expect(state.threads.open).toBeUndefined();
    expect(state.threads.unknown).toBeUndefined();

    const broken = await harness({ sessions, modified, review: () => ({}), linked: () => { throw new Error("provider offline"); } });
    await broken.invoke("settings", { inactiveDays: 3, onMerged: false });
    expect((await broken.invoke("sweep")).threads).toEqual({});

    const without = await harness({ sessions, modified });
    await without.invoke("settings", { inactiveDays: 3, onMerged: false });
    expect(Object.keys((await without.invoke("sweep")).threads).sort()).toEqual(["open", "plain", "unknown"]);
  });

  it("refreshes and settles merged work when a turn ends, without waiting for the periodic sweep", async () => {
    const { invoke, observers } = await harness({
      sessions: [session("done", "/worktrees/done")],
      review: () => ({}),
      linked: () => ({ done: [{ url: "https://example.test/pr/42", state: "merged" }] }),
    });
    observers[0]!.accepted?.("done", "turn", { deferBefore: false });
    expect((await invoke("sweep")).threads.done?.settledAt).toBeUndefined();
    await observers[0]!.ended?.("done", "turn", {} as never);
    await vi.waitFor(async () => expect((await invoke("state")).threads.done?.settledBy).toBe("pr-merged"));
  });

  it("settles after a request notification but leaves shared-checkout siblings alone", async () => {
    const review = vi.fn(() => ({ request: { url: "https://example.test/pr/unrelated", state: "merged" } }));
    const { invoke } = await harness({
      sessions: [session("done", "/project"), session("sibling", "/project")],
      review,
      linked: () => ({ done: [{ url: "https://example.test/pr/42", state: "merged" }] }),
    });
    await invoke("requests-changed", { threadId: "done" });
    await vi.waitFor(async () => expect((await invoke("state")).threads.done?.settledBy).toBe("pr-merged"));
    expect((await invoke("state")).threads.sibling).toBeUndefined();
    expect(review).not.toHaveBeenCalled();
  });

  it("does not lose a turn-ending recheck while an earlier sweep is in flight", async () => {
    let resolveIntegration!: (value: unknown) => void;
    const integration = new Promise((resolve) => { resolveIntegration = resolve; });
    const integrated = vi.fn(() => integration);
    const { invoke, observers } = await harness({
      sessions: [session("done", "/worktrees/done")],
      review: () => ({}),
      linked: () => ({ done: [{ url: "https://example.test/pr/42", state: "merged" }], continued: [{ url: "https://example.test/pr/42", state: "merged" }] }),
      integrated,
    });
    // Even same-millisecond activity must invalidate the old integration result.
    await invoke("patch", { patches: { done: { activityAt: NOW } } });
    const sweeping = invoke("sweep");
    await vi.waitFor(() => expect(integrated).toHaveBeenCalled());
    observers[0]!.accepted?.("done", "turn", { deferBefore: false });
    await observers[0]!.ended?.("done", "turn", {} as never);
    resolveIntegration({ integrated: true });
    expect((await sweeping).threads.done?.settledAt).toBeUndefined();
    await vi.waitFor(async () => expect((await invoke("state")).threads.done?.settledBy).toBe("pr-merged"));
  });

  it("does not settle a new turn accepted while an integration read is in flight", async () => {
    let resolveIntegration!: (value: unknown) => void;
    const integration = new Promise((resolve) => { resolveIntegration = resolve; });
    const integrated = vi.fn(() => integration);
    const { invoke, observers } = await harness({
      sessions: [session("continued", "/worktrees/continued")],
      review: () => ({}),
      linked: () => ({ done: [{ url: "https://example.test/pr/42", state: "merged" }], continued: [{ url: "https://example.test/pr/42", state: "merged" }] }),
      integrated,
    });
    const sweeping = invoke("sweep");
    // Wait until the sweep reaches the integration read before accepting more work.
    await vi.waitFor(() => expect(integrated).toHaveBeenCalled());
    observers[0]!.accepted?.("continued", "next", { deferBefore: false });
    resolveIntegration({ integrated: true });
    expect((await sweeping).threads.continued?.settledAt).toBeUndefined();
  });

  it("does not settle on an old merged PR while the checkout has outstanding work", async () => {
    let integrated = false;
    const { invoke } = await harness({
      sessions: [session("continued", "/worktrees/continued")],
      review: () => ({ request: { url: "https://example.test/pr/40", state: "merged" } }),
      linked: () => ({ continued: [{ url: "https://example.test/pr/40", state: "merged" }] }),
      integrated: () => ({ integrated }),
    });
    expect((await invoke("sweep")).threads.continued?.settledAt).toBeUndefined();
    integrated = true;
    expect((await invoke("sweep")).threads.continued?.settledBy).toBe("pr-merged");
  });

  it("checks the merged PR's base, not the branch the worktree started from", async () => {
    const integrated = vi.fn((_workspace: string, targets?: string[]) => ({ integrated: targets?.includes("main") === true }));
    const { invoke } = await harness({
      sessions: [session("rebased", "/worktrees/rebased")],
      review: () => ({ request: { url: "https://example.test/pr/63", state: "merged" } }),
      linked: () => ({ rebased: [{ url: "https://example.test/pr/63", state: "merged", baseRef: "main" }] }),
      integrated,
    });
    expect((await invoke("sweep")).threads.rebased?.settledBy).toBe("pr-merged");
    expect(integrated).toHaveBeenCalledWith("/worktrees/rebased", ["main"]);
  });

  it("does not treat an unavailable integration check as proof that the work landed", async () => {
    const { invoke } = await harness({
      sessions: [session("continued", "/worktrees/continued")],
      review: () => ({ request: { url: "https://example.test/pr/40", state: "merged" } }),
      integrated: () => { throw new Error("Git unavailable"); },
    });
    expect((await invoke("sweep")).threads.continued?.settledAt).toBeUndefined();
  });

  it("wakes a snooze that ran out on the next sweep", async () => {
    let now = NOW;
    const { invoke } = await harness({ now: () => now });
    await invoke("patch", { patches: { a: { snoozedUntil: NOW + 60_000 } } });
    now += 61_000;
    expect((await invoke("sweep")).threads).toEqual({});
  });

  it("starts a thread off screen in a folder and records the group it was started with", async () => {
    const { invoke, start } = await harness();
    const cwd = await scratch();
    const started = await invoke("start", { cwd, prompt: " fix it ", model: { provider: "openai", id: "gpt-5.6-luna" }, siblingGroupId: "group-1" }) as unknown as { sessionId: string };
    expect(start).toHaveBeenCalledWith({ cwd, prompt: "fix it", model: { provider: "openai", id: "gpt-5.6-luna" } });
    expect((await invoke("state")).threads[started.sessionId]).toEqual({ activityAt: NOW, siblingGroupId: "group-1", model: "openai/gpt-5.6-luna" });
    await expect(invoke("start", { cwd: "relative/path", prompt: "x" })).rejects.toThrow(/not a folder/u);
    await expect(invoke("start", { cwd, prompt: "  " })).rejects.toThrow(/no prompt/u);
  });

  it("forwards runtime, attachments and native skill context to the host start seam", async () => {
    const { invoke, start } = await harness();
    const cwd = await scratch();
    const attachments = [{ kind: "file", name: "spec.md", mimeType: "text/markdown", path: "/shared/spec.md", size: 10 }];
    const skillDraft = { source: "skill", name: "tdd", visibleText: "/tdd", command: "/skill:tdd" };
    await invoke("start", { cwd, prompt: "fix it", backend: "codex", attachments, skillDraft, thinkingLevel: "high", mode: "plan" });
    expect(start).toHaveBeenCalledWith({ cwd, prompt: "fix it", backend: "codex", attachments, skillDraft, thinkingLevel: "high", mode: "plan" });
  });

  it("takes over core's old pins and settled shelf once", async () => {
    const { invoke } = await harness();
    const first = await invoke("import", { pinned: ["p"], settled: ["s"] });
    expect(first.threads).toEqual({ p: { pinned: true, pinOrder: 0 }, s: { settledAt: NOW, settledBy: "user" } });
    await invoke("patch", { patches: { p: null } });
    expect((await invoke("import", { pinned: ["p"] })).threads.p).toBeUndefined();
  });

  it("settles imported threads for Onboarding Kit, leaving threads that already have meta alone", async () => {
    const { invoke, registry } = await harness();
    await invoke("patch", { patches: { pinned: { pinned: true, pinOrder: 0 } } });
    let handOver: ((input: unknown) => Promise<unknown>) | undefined;
    await registry.activate({
      id: "tau.onboarding",
      name: "Onboarding",
      activate(context: HostExtensionContext) { handOver = (input) => context.invokeHostExtension(THREAD_RAIL_EXTENSION_ID, "settle-imported", input); },
    });
    expect(await handOver!({ threadIds: ["new", "pinned", ""] })).toEqual({ settled: 1 });
    const { threads } = await invoke("state");
    expect(threads.new).toEqual({ settledAt: NOW, settledBy: "import" });
    expect(threads.pinned).toEqual({ pinned: true, pinOrder: 0 });
    // Handing the same ids over again changes nothing.
    expect(await handOver!({ threadIds: ["new"] })).toEqual({ settled: 0 });
  });

  it("refuses settle-imported to any other kit", async () => {
    const { registry } = await harness();
    let call: (() => Promise<unknown>) | undefined;
    await registry.activate({
      id: "tau.other",
      name: "Other",
      activate(context: HostExtensionContext) { call = () => context.invokeHostExtension(THREAD_RAIL_EXTENSION_ID, "settle-imported", { threadIds: ["x"] }); },
    });
    await expect(call!()).rejects.toThrow();
  });

  it("forgets a deleted thread", async () => {
    const { invoke, lifecycles } = await harness();
    await invoke("patch", { patches: { gone: { pinned: true } } });
    await lifecycles[0]!.threadDeleted?.("gone", "/project");
    expect((await invoke("state")).threads).toEqual({});
  });

  it("shares only requested local settlement times with Workspace and refuses unrelated kits", async () => {
    const sessions: HostSessionSummary[] = [
      { sessionId: "settled", path: "/sessions/settled.jsonl", cwd: "/project" },
      { sessionId: "active", path: "/sessions/active.jsonl", cwd: "/project" },
      proxy("rex~remote"),
    ];
    const { invoke, registry } = await harness({ sessions, index: [{ id: "codex", path: "tau-thread:codex:codex", title: "Codex", projectPath: "/project", projectName: "project", modifiedAt: NOW, messageCount: 1, backendKind: "codex" }] });
    await invoke("patch", { patches: { settled: { settledAt: NOW, settledBy: "user" }, codex: { settledAt: NOW, settledBy: "user" }, missing: { settledAt: NOW } } });
    let read: ((ids: string[]) => Promise<unknown>) | undefined;
    let unauthorized: (() => Promise<unknown>) | undefined;
    await registry.activate({
      id: "tau.workspace", name: "Workspace",
      activate(context) { read = (threadIds) => context.invokeHostExtension(THREAD_RAIL_EXTENSION_ID, "thread-settlements", { threadIds }); },
    });
    await registry.activate({
      id: "tau.other", name: "Other",
      activate(context) { unauthorized = () => context.invokeHostExtension(THREAD_RAIL_EXTENSION_ID, "thread-settlements", { threadIds: ["settled"] }); },
    });
    expect(await read!(["settled", "codex", "active", "missing", "rex~remote"])).toEqual({ settled: NOW, codex: NOW });
    expect(await read!(["active"])).toEqual({});
    await expect(unauthorized!()).rejects.toThrow();
    await invoke("patch", { patches: { settled: { settledAt: null } } });
    expect(await read!(["settled"])).toEqual({});
  });

  it("archives an idle thread, refuses a running one, and new work brings an archived thread back", async () => {
    const { invoke, observers } = await harness();
    observers[0]!.accepted?.("busy", "turn", { deferBefore: false });
    await expect(invoke("archive", { threadId: "busy" })).rejects.toThrow(/running thread/u);
    const state = await invoke("archive", { threadId: "idle" });
    expect(state.threads.idle).toEqual({ archivedAt: NOW });
    observers[0]!.accepted?.("idle", "turn-2", { deferBefore: false });
    expect((await invoke("state")).threads.idle).toEqual({ activityAt: NOW });
  });

  it("deletes into the host's trash, keeps the meta until the purge and tells every client", async () => {
    const { invoke, events, lifecycles, removed, restored } = await harness();
    await invoke("patch", { patches: { gone: { pinned: true, pinOrder: 0 } } });
    await invoke("remove", { threadId: "gone" });
    expect(removed).toHaveBeenCalledWith("gone");
    expect(events.filter((event) => event.name === TRASH_EVENT).at(-1)?.payload).toEqual([{ sessionId: "gone" }]);
    expect((await invoke("state")).threads.gone).toEqual({ pinned: true, pinOrder: 0 });

    await invoke("restore", { threadId: "gone" });
    expect(restored).toHaveBeenCalledWith("gone");
    expect(events.filter((event) => event.name === TRASH_EVENT).at(-1)?.payload).toEqual([]);
    await expect(invoke("remove", {})).rejects.toThrow(/threadId/u);
    await lifecycles[0]!.threadDeleted?.("gone", "/project");
    expect((await invoke("state")).threads).toEqual({});
  });
});


const shell = (id: string, title: string, extra: Partial<UiSession> = {}): UiSession =>
  ({ id, path: `/sessions/${id}.jsonl`, title, modifiedAt: NOW - 1000, projectPath: "/project", projectName: "tau", messageCount: 2, ...extra });
const callTool = async (tool: HostMcpTool | undefined, params: unknown) => JSON.parse((await tool!.execute("call", params as never, undefined, undefined, undefined as never) as { content: Array<{ text: string }> }).content[0]!.text);

describe("Thread Rail agent tools", () => {
  it("offers the tools over MCP and to Pi, with instructions on how to mention a thread", async () => {
    const { tools, instructions, runtimeExtensions } = await harness();
    expect([...(await tools("t1")).keys()]).toEqual(["tau_find_threads", "tau_thread_organize"]);
    expect((await tools("t1")).get("tau_find_threads")!.annotations).toEqual({ readOnlyHint: true });
    expect(runtimeExtensions).toEqual(["tau-thread-directory"]);
    expect(instructions).toHaveLength(1);
  });

  it("settles its own thread when the run ends well, and only then", async () => {
    let now = NOW;
    const { tools, observers, invoke } = await harness({ now: () => now, index: [shell("t1", "Fix it")] });
    const organize = (await tools("t1")).get("tau_thread_organize");
    const observer = observers[0]!;

    observer.accepted?.("t1", "turn-1", { deferBefore: false });
    expect(await callTool(organize, { action: "settle" })).toEqual({ threadId: "t1", action: "settle", applied: false, appliesWhenRunEnds: true });
    expect((await invoke("state")).threads.t1?.settledAt).toBeUndefined();
    now += 5;
    observer.runEnded?.("t1", "completed");
    expect((await invoke("state")).threads.t1).toMatchObject({ settledAt: NOW + 5, settledBy: "agent" });

    // A failed run keeps the thread as it was.
    observer.accepted?.("t1", "turn-2", { deferBefore: false });
    expect((await invoke("state")).threads.t1?.settledAt).toBeUndefined();
    await callTool(organize, { action: "settle" });
    observer.runEnded?.("t1", "failed");
    expect((await invoke("state")).threads.t1?.settledAt).toBeUndefined();
  });

  it("drops the request when a message queues behind the run, the user stops it or the agent takes it back", async () => {
    const { tools, observers, invoke } = await harness({ index: [shell("t1", "Fix it")] });
    const organize = (await tools("t1")).get("tau_thread_organize");
    const observer = observers[0]!;
    const ends = async () => { observer.runEnded?.("t1", "completed"); return (await invoke("state")).threads.t1?.settledAt; };

    observer.accepted?.("t1", "turn-1", { deferBefore: false });
    await callTool(organize, { action: "settle" });
    observer.accepted?.("t1", "turn-2", { deferBefore: true });
    expect(await ends()).toBeUndefined();

    observer.accepted?.("t1", "turn-3", { deferBefore: false });
    await callTool(organize, { action: "settle" });
    await observer.stopped?.("t1");
    expect(await ends()).toBeUndefined();

    observer.accepted?.("t1", "turn-4", { deferBefore: false });
    await callTool(organize, { action: "settle" });
    await callTool(organize, { action: "unsettle" });
    expect(await ends()).toBeUndefined();
  });

  it("settles and snoozes an idle thread at once, validates the snooze and wakes or reopens on request", async () => {
    const { tools, invoke } = await harness({ index: [shell("t1", "Me"), shell("t2", "Other")] });
    const organize = (await tools("t1")).get("tau_thread_organize");
    expect(await callTool(organize, { action: "settle", threadId: "t2" })).toMatchObject({ applied: true });
    expect((await invoke("state")).threads.t2).toMatchObject({ settledBy: "agent" });
    expect(await callTool(organize, { action: "unsettle", threadId: "t2" })).toMatchObject({ applied: true });
    expect((await invoke("state")).threads.t2?.settledAt).toBeUndefined();

    const until = new Date(NOW + DAY_MS).toISOString();
    expect(await callTool(organize, { action: "snooze", threadId: "t2", snoozedUntil: until })).toMatchObject({ applied: true });
    expect((await invoke("state")).threads.t2?.snoozedUntil).toBe(NOW + DAY_MS);
    await callTool(organize, { action: "unsnooze", threadId: "t2" });
    expect((await invoke("state")).threads.t2?.snoozedUntil).toBeUndefined();

    await expect(callTool(organize, { action: "snooze", threadId: "t2" })).rejects.toThrow("snoozedUntil");
    await expect(callTool(organize, { action: "snooze", threadId: "t2", snoozedUntil: new Date(NOW - 1).toISOString() })).rejects.toThrow("future");
    await expect(callTool(organize, { action: "settle", threadId: "nope" })).rejects.toThrow("No thread nope");
  });

  it("snoozes a running thread when its run ends", async () => {
    const { tools, observers, invoke } = await harness({ index: [shell("t1", "Me")] });
    observers[0]!.accepted?.("t1", "turn-1", { deferBefore: false });
    await callTool((await tools("t1")).get("tau_thread_organize"), { action: "snooze", snoozedUntil: new Date(NOW + DAY_MS).toISOString() });
    observers[0]!.runEnded?.("t1", "completed");
    expect((await invoke("state")).threads.t1?.snoozedUntil).toBe(NOW + DAY_MS);
  });

  it.skipIf(process.platform === "win32")("snoozing keeps owned shell work alive and reports the thread as running", async () => {
    const tree = await ownedProcessTree();
    try {
      const { tools, observers, invoke } = await harness({ index: [shell("t1", "Run tests")] });
      observers[0]!.accepted?.("t1", "turn-1", { deferBefore: false });
      await invoke("patch", { patches: { t1: { snoozedUntil: NOW + DAY_MS } } });
      expect((await invoke("state")).threads.t1?.snoozedUntil).toBe(NOW + DAY_MS);
      const directory = await callTool((await tools("t1")).get("tau_find_threads"), {});
      expect(directory.threads[0]).toMatchObject({ threadId: "t1", running: true, snoozed: true });
      expect(tree.alive()).toEqual(tree.pids);
      await tree.stop();
      await expect.poll(tree.alive, { timeout: 20_000 }).toEqual([]);
    } finally { await tree.close(); }
  });

  it("lists threads with their rail state, links and requests, and filters by state, words and request", async () => {
    const index = [
      shell("t1", "Fix the rail", { modifiedAt: NOW - 10, projectLabel: "fix/rail" }),
      shell("t2", "Write [docs]", { modifiedAt: NOW - 20 }),
      shell("t3", "Old work", { modifiedAt: NOW - 30 }),
      shell("t4", "Agent child", { modifiedAt: NOW - 5, parentThreadId: "t1" }),
      shell("t5", "Gone", { modifiedAt: NOW - 40 }),
      shell("t6", "Other machine", { machine: { id: "rex", name: "Rex" } }),
    ];
    const requestLinks = vi.fn((input: { threadIds?: string[]; query?: string }) => {
      const pr = { url: "https://github.com/acme/tau/pull/95", repository: "acme/tau", number: 95, state: "open", title: "Rail fix", headBranch: "fix/rail" };
      if (input.query) return input.query.includes("95") ? { t2: [pr] } : {};
      return Object.fromEntries((input.threadIds ?? []).filter((id) => id === "t2").map((id) => [id, [pr]]));
    });
    const { tools, invoke, observers } = await harness({ index, requestLinks });
    await invoke("patch", { patches: { t2: { snoozedUntil: NOW + DAY_MS }, t3: { settledAt: NOW - 5, settledBy: "user" }, t5: { archivedAt: NOW - 1 } } });
    observers[0]!.accepted?.("t1", "turn-1", { deferBefore: false });
    const find = (await tools("t1")).get("tau_find_threads");

    const all = await callTool(find, {});
    expect(all.threads.map((thread: { threadId: string }) => thread.threadId)).toEqual(["t1", "t2", "t3"]);
    expect(all.total).toBe(3);
    expect(all.threads[0]).toMatchObject({ link: "[Fix the rail](tau://thread?thread=t1)", state: "active", running: true, current: true, branch: "fix/rail", snoozed: false, settled: false });
    expect(all.threads[1]).toMatchObject({ link: "[Write docs](tau://thread?thread=t2)", state: "snoozed", snoozed: true, snoozedUntil: new Date(NOW + DAY_MS).toISOString(), pullRequests: [expect.objectContaining({ number: 95 })] });
    expect(all.threads[2]).toMatchObject({ state: "settled", settled: true, settledBy: "user" });

    const ids = async (params: unknown) => (await callTool(find, params)).threads.map((thread: { threadId: string }) => thread.threadId);
    expect(await ids({ snoozed: true })).toEqual(["t2"]);
    expect(await ids({ settled: false })).toEqual(["t1", "t2"]);
    expect(await ids({ state: "settled" })).toEqual(["t3"]);
    expect(await ids({ state: "archived" })).toEqual(["t5"]);
    expect(await ids({ includeSubagents: true })).toEqual(["t4", "t1", "t2", "t3"]);
    expect(await ids({ query: "rail" })).toEqual(["t1"]);
    expect(await ids({ query: "fix/rail" })).toEqual(["t1"]);
    expect(await ids({ query: "#95" })).toEqual(["t2"]);
    expect(await ids({ limit: 1 })).toEqual(["t1"]);
  });

  it("lists threads without Review Kit, just without requests", async () => {
    const { tools } = await harness({ index: [shell("t1", "Only")] });
    const found = await callTool((await tools("x")).get("tau_find_threads"), { query: "only" });
    expect(found.threads).toHaveLength(1);
    expect(found.threads[0].pullRequests).toBeUndefined();
  });
});

describe("Thread Rail machine ownership", () => {
  it("keeps local metadata and trash when a peer projects the same composite id", async () => {
    const machines = machineServices([rex]);
    machines.call.mockImplementation(async (_machine, _extension, command) => command === "trash" ? [remoteTrash("local")] : { threads: { local: { settledAt: 1, pinned: true } } });
    const sessions = [session("rex~local", "/local")];
    const { invoke, events, lifecycles } = await harness({ machines: machines.services, sessions });
    const patch = { settledAt: NOW, settledBy: "user" };
    expect((await invoke("patch", { patches: { "rex~local": patch } })).threads).toEqual({ "rex~local": patch });
    expect(machines.call.mock.calls.filter((call) => call[2] === "patch")).toEqual([]);
    machines.emit("rex", MACHINE_META_EVENT, { threads: { local: { pinned: true } } });
    expect((await invoke("state")).threads).toEqual({ "rex~local": patch });
    expect(await invoke("trash")).toEqual([]);
    await invoke("remove", { threadId: "rex~local" });
    sessions.length = 0;
    await lifecycles[0]!.sweep?.({ sessions: [], liveThreads: [], projectPaths: [], deleted: [] });
    machines.emit("rex", MACHINE_META_EVENT, { threads: { local: { settledAt: 2 } } });
    machines.emit("rex", MACHINE_TRASH_EVENT, [remoteTrash("local")]);
    expect((await invoke("state")).threads).toEqual({ "rex~local": patch });
    expect(await invoke("trash")).toEqual([{ sessionId: "rex~local" }]);
    await vi.waitFor(() => expect(events.filter((event) => event.name === TRASH_EVENT).at(-1)?.payload).toEqual([{ sessionId: "rex~local" }]));
  });

  it("groups remote patches by machine, keeps the whole suffix and preserves indexed local ids", async () => {
    const machines = machineServices([rex]);
    const remote: RailState = { threads: {}, settings: { onMerged: true, onClosed: true } };
    machines.call.mockImplementation(async (_machine, _extension, command, input) => {
      if (command === "patch") Object.assign(remote.threads, (input as { patches: RailState["threads"] }).patches);
      return command === "trash" ? [] : remote;
    });
    const { invoke, stateDir } = await harness({ machines: machines.services, sessions: [proxy("rex~t1"), proxy("rex~saved~thread"), session("rex~local", "/local")] });
    const state = await invoke("patch", { patches: { "rex~t1": { settledAt: NOW, settledBy: "user" }, "rex~saved~thread": { pinned: true }, "rex~local": { pinned: true } } });
    expect(machines.call).toHaveBeenCalledWith("rex", THREAD_RAIL_EXTENSION_ID, "patch", { patches: { t1: { settledAt: NOW, settledBy: "user" }, "saved~thread": { pinned: true } } });
    expect(state.threads).toEqual({ "rex~t1": { settledAt: NOW, settledBy: "user" }, "rex~saved~thread": { pinned: true }, "rex~local": { pinned: true } });
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(stateDir, THREAD_RAIL_EXTENSION_ID, "thread-meta.json"), "utf8")).threads).toEqual({ "rex~local": { pinned: true } }));
  });

  it("reads home-only state initially and after index changes, and forwards live meta without echo", async () => {
    const machines = machineServices([rex]);
    let meta = { t1: { settledAt: 1 } };
    machines.call.mockImplementation(async (_machine, _extension, command) => command === "trash" ? [] : { threads: meta, settings: { inactiveDays: 99, onMerged: false, onClosed: false } });
    const { invoke, events } = await harness({ machines: machines.services });
    await vi.waitFor(async () => expect((await invoke("state")).threads).toEqual({ "rex~t1": { settledAt: 1 } }));
    expect(machines.call).toHaveBeenCalledWith("rex", THREAD_RAIL_EXTENSION_ID, "state", { homeOnly: true });
    expect((await invoke("state")).settings).toEqual({ onMerged: true, onClosed: false, workingSection: false });
    meta = { t1: { settledAt: 2 } };
    machines.index("rex");
    await vi.waitFor(async () => expect((await invoke("state")).threads["rex~t1"]).toEqual({ settledAt: 2 }));
    events.length = 0;
    machines.emit("rex", MACHINE_META_EVENT, { threads: { "saved~thread": { pinned: true } } });
    expect((await invoke("state")).threads).toEqual({ "rex~saved~thread": { pinned: true } });
    expect(events.filter((event) => event.name === META_EVENT)).toHaveLength(1);
    expect(events.filter((event) => event.topic)).toEqual([]);
    await invoke("patch", { patches: { local: { pinned: true } } });
    expect(events.find((event) => event.name === MACHINE_META_EVENT)).toMatchObject({ topic: MACHINE_STATE_TOPIC, payload: { threads: { local: { pinned: true } } } });
    expect((await invoke("state", { homeOnly: true })).threads).toEqual({ local: { pinned: true } });
  });

  it("does not sweep, wake, observe or publish legacy proxy metadata stored locally", async () => {
    const stateDir = await scratch();
    const folder = join(stateDir, THREAD_RAIL_EXTENSION_ID);
    await mkdir(folder);
    await writeFile(join(folder, "thread-meta.json"), JSON.stringify({ version: 1, threads: { "rex~t1": { snoozedUntil: NOW - 1, activityAt: NOW - 10 * DAY_MS }, local: { snoozedUntil: NOW - 1 } }, settings: { inactiveDays: 1, onMerged: true, onClosed: true } }));
    const machines = machineServices([rex]);
    const review = vi.fn(() => ({ request: { url: "https://example.test/merged", state: "merged" } }));
    const { invoke, observers, events, lifecycles } = await harness({ stateDir, machines: machines.services, sessions: [proxy("rex~t1")], modified: { "tau-thread:machine:rex~t1": NOW - 10 * DAY_MS }, review });
    observers[0]!.accepted?.("rex~t1", "turn", { deferBefore: false });
    await observers[0]!.ended?.("rex~t1", "turn", "completed");
    await lifecycles[0]!.threadDeleted?.("rex~t1", "/rex/project");
    await invoke("sweep");
    expect(review).not.toHaveBeenCalled();
    expect((await invoke("state", { homeOnly: true })).threads).toEqual({});
    expect(events.filter((event) => event.topic && event.name === MACHINE_META_EVENT).every((event) => Object.keys((event.payload as RailState).threads).length === 0)).toBe(true);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(folder, "thread-meta.json"), "utf8")).threads).toEqual({ "rex~t1": { snoozedUntil: NOW - 1, activityAt: NOW - 10 * DAY_MS } }));
  });

  it("forwards archive and trash actions, including a deleted remote id absent from the index", async () => {
    const machines = machineServices([rex]);
    const { invoke, removed, restored } = await harness({ machines: machines.services, sessions: [proxy("rex~saved~thread")] });
    for (const command of ["archive", "remove", "restore", "purge"]) {
      await invoke(command, { threadId: "rex~saved~thread" });
      expect(machines.call).toHaveBeenCalledWith("rex", THREAD_RAIL_EXTENSION_ID, command, { threadId: "saved~thread" });
    }
    await invoke("restore", { threadId: "rex~deleted~thread" });
    expect(machines.call).toHaveBeenCalledWith("rex", THREAD_RAIL_EXTENSION_ID, "restore", { threadId: "deleted~thread" });
    await invoke("remove", { threadId: "unknown~local" });
    expect(removed).toHaveBeenCalledWith("unknown~local");
    expect(restored).not.toHaveBeenCalled();
  });

  it("keeps remote trash accessible for restore and purge, with live trash changes", async () => {
    const machines = machineServices([rex]);
    let trash = [remoteTrash("saved~thread")];
    machines.call.mockImplementation(async (_machine, _extension, command) => {
      if (command === "restore" || command === "purge") trash = [];
      return command === "trash" ? trash : { threads: {} };
    });
    const { invoke, events } = await harness({ machines: machines.services });
    await vi.waitFor(async () => expect(await invoke("trash")).toEqual([{ ...remoteTrash("saved~thread"), sessionId: "rex~saved~thread" }]));
    expect(machines.call).toHaveBeenCalledWith("rex", THREAD_RAIL_EXTENSION_ID, "trash", { homeOnly: true });
    await invoke("restore", { threadId: "rex~saved~thread" });
    expect(await invoke("trash")).toEqual([]);
    machines.emit("rex", MACHINE_TRASH_EVENT, [remoteTrash("other"), { ...remoteTrash("here~indirect"), backendKind: "machine" }]);
    await vi.waitFor(() => expect(events.filter((event) => event.name === TRASH_EVENT).at(-1)?.payload).toEqual([{ ...remoteTrash("other"), sessionId: "rex~other" }]));
    expect(events.filter((event) => event.topic)).toEqual([]);
    await invoke("purge", { threadId: "rex~other" });
    expect(await invoke("trash")).toEqual([]);
  });

  it("retains watches through reconnect, drops removed machines and disposes every subscription", async () => {
    const machines = machineServices([rex]);
    machines.call.mockImplementation(async (_machine, _extension, command) => command === "trash" ? [] : { threads: { t1: { pinned: true } } });
    const { invoke, registry } = await harness({ machines: machines.services });
    await vi.waitFor(async () => expect((await invoke("state")).threads["rex~t1"]).toEqual({ pinned: true }));
    machines.update([{ ...rex, status: "offline" }]);
    expect((await invoke("state")).threads).toEqual({ "rex~t1": { pinned: true } });
    expect(machines.watched.size).toBe(1);
    machines.update([rex]);
    await vi.waitFor(async () => expect((await invoke("state")).threads["rex~t1"]).toEqual({ pinned: true }));
    machines.update([]);
    expect(machines.stopped).toHaveBeenCalledWith("rex");
    expect((await invoke("state")).threads).toEqual({});
    machines.update([rex]);
    await registry.dispose();
    expect(machines.watched.size).toBe(0);
    expect(machines.listeners.size).toBe(0);
    expect(machines.indexListeners.size).toBe(0);
  });

  it("does not deadlock activation or mirror proxy metadata across reciprocal connections", async () => {
    const left = machineServices([{ ...rex, status: "offline" }], "here");
    const right = machineServices([{ id: "here", name: "Here", status: "offline" }], "rex");
    const leftHost = await harness({ machines: left.services, sessions: [session("a", "/here"), proxy("rex~b")] });
    const rightHost = await harness({ machines: right.services, sessions: [session("b", "/rex"), proxy("here~a")] });
    left.call.mockImplementation(async (_machine, _extension, command, input) => rightHost.invoke(command, input));
    right.call.mockImplementation(async (_machine, _extension, command, input) => leftHost.invoke(command, input));
    await leftHost.invoke("patch", { patches: { a: { pinned: true } } });
    await rightHost.invoke("patch", { patches: { b: { settledAt: NOW } } });
    left.update([rex]);
    right.update([{ id: "here", name: "Here", status: "connected" }]);
    await vi.waitFor(async () => {
      expect((await leftHost.invoke("state")).threads).toEqual({ a: { pinned: true }, "rex~b": { settledAt: NOW } });
      expect((await rightHost.invoke("state")).threads).toEqual({ b: { settledAt: NOW }, "here~a": { pinned: true } });
    });
    left.index("rex");
    right.index("here");
    await vi.waitFor(async () => {
      expect((await leftHost.invoke("state", { homeOnly: true })).threads).toEqual({ a: { pinned: true } });
      expect((await rightHost.invoke("state", { homeOnly: true })).threads).toEqual({ b: { settledAt: NOW } });
    });
  });
});


describe("Thread Rail machine cache races", () => {
  it("keeps remote settled metadata when this host restarts while the peer is offline", async () => {
    const machines = machineServices([rex]);
    machines.call.mockImplementation(async (_machine, _extension, command) => command === "trash" ? [] : { threads: { t1: { settledAt: NOW, settledBy: "user" } } });
    const first = await harness({ machines: machines.services, sessions: [proxy("rex~t1")] });
    await vi.waitFor(async () => expect((await first.invoke("state")).threads["rex~t1"]?.settledAt).toBe(NOW));
    await first.registry.dispose();
    machines.update([{ ...rex, status: "offline" }]);
    const restarted = await harness({ stateDir: first.stateDir, machines: machines.services, sessions: [proxy("rex~t1")] });
    expect((await restarted.invoke("state")).threads["rex~t1"]?.settledAt).toBe(NOW);
  });
  it("accepts a slow home-state read while more thread-index notifications arrive", async () => {
    const machines = machineServices([rex]);
    const answers: Array<(value: unknown) => void> = [];
    machines.call.mockImplementation(async (_machine, _extension, command) => command === "trash" ? [] : new Promise((resolve) => answers.push(resolve)));
    const { invoke } = await harness({ machines: machines.services });
    machines.index("rex");
    machines.index("rex");
    expect(answers).toHaveLength(1);
    answers[0]!({ threads: { t1: { settledAt: NOW } } });
    await vi.waitFor(async () => expect((await invoke("state")).threads["rex~t1"]?.settledAt).toBe(NOW));
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]!({ threads: { t1: { settledAt: NOW + 1 } } });
    await vi.waitFor(async () => expect((await invoke("state")).threads["rex~t1"]?.settledAt).toBe(NOW + 1));
  });

  it("keeps an acknowledged remote settlement visible without waiting for older state reads", async () => {
    const machines = machineServices([rex]);
    const answers: Array<(value: unknown) => void> = [];
    machines.call.mockImplementation(async (_machine, _extension, command) => command === "state" ? new Promise((resolve) => answers.push(resolve)) : command === "trash" ? [] : undefined);
    const { invoke } = await harness({ machines: machines.services });
    let finished = false;
    const writing = invoke("patch", { patches: { "rex~t1": { settledAt: NOW } } }).then((state) => { finished = true; return state; });
    await vi.waitFor(() => expect(machines.call.mock.calls.some((call) => call[2] === "patch")).toBe(true));
    expect((await invoke("state")).threads["rex~t1"]?.settledAt).toBe(NOW);
    answers[0]!({ threads: {} });
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    expect(finished).toBe(true);
    answers[1]!({ threads: { t1: { settledAt: NOW } } });
    expect((await writing).threads["rex~t1"]?.settledAt).toBe(NOW);
  });

  it("keeps a settled remote thread on the shelf while its machine disconnects", async () => {
    const machines = machineServices([rex]);
    machines.call.mockImplementation(async (_machine, _extension, command) => command === "trash" ? [] : { threads: { t1: { settledAt: NOW, settledBy: "user" } } });
    const { invoke } = await harness({ machines: machines.services, sessions: [proxy("rex~t1")] });
    await vi.waitFor(async () => expect((await invoke("state")).threads["rex~t1"]?.settledAt).toBe(NOW));
    machines.update([{ ...rex, status: "offline" }]);
    const row: UiSession = { id: "rex~t1", path: "tau-thread:machine:rex~t1", title: "Settled on Rex", modifiedAt: NOW, projectPath: "/rex/project", projectName: "project", messageCount: 1, backendKind: "machine", machine: { id: "rex", name: "Rex" } };
    const sections = railSections([row], await invoke("state"), NOW);
    expect(sections.active).toEqual([]);
    expect(sections.settled).toEqual([row]);
  });

  it("keeps a newer peer read ahead of an older machine metadata push", async () => {
    const machines = machineServices([rex]);
    const publication = { epoch: "peer", revision: 2 };
    machines.call.mockImplementation(async (_machine, _extension, command) => command === "trash" ? [] : { threads: { t1: { settledAt: NOW } }, publication });
    const { invoke, events } = await harness({ machines: machines.services, sessions: [proxy("rex~t1")] });
    await vi.waitFor(async () => expect((await invoke("state")).threads["rex~t1"]?.settledAt).toBe(NOW));
    const before = events.filter((event) => event.name === META_EVENT).length;
    machines.emit("rex", MACHINE_META_EVENT, { threads: {}, publication: { ...publication, revision: 1 } });
    expect((await invoke("state")).threads["rex~t1"]?.settledAt).toBe(NOW);
    expect(events.filter((event) => event.name === META_EVENT)).toHaveLength(before);
  });

  it("keeps a live meta push newer than a pending read while still accepting the trash read", async () => {
    const machines = machineServices([rex]);
    let answerState!: (state: unknown) => void;
    let answerTrash!: (trash: unknown) => void;
    machines.call.mockImplementation(async (_machine, _extension, command) => new Promise((resolve) => {
      if (command === "state") answerState = resolve;
      else answerTrash = resolve;
    }));
    const { invoke } = await harness({ machines: machines.services });
    machines.emit("rex", MACHINE_META_EVENT, { threads: { t1: { pinned: true } } });
    answerState({ threads: { t1: { pinned: false } } });
    answerTrash([remoteTrash("gone")]);
    await vi.waitFor(async () => {
      expect((await invoke("state")).threads).toEqual({ "rex~t1": { pinned: true } });
      expect(await invoke("trash")).toEqual([{ ...remoteTrash("gone"), sessionId: "rex~gone" }]);
    });
  });

  it("preserves actual local ownership after a local separator id enters trash", async () => {
    const machines = machineServices([rex]);
    const sessions = [session("rex~local", "/local")];
    const { invoke, removed, restored, lifecycles } = await harness({ machines: machines.services, sessions });
    await invoke("patch", { patches: { "rex~local": { pinned: true } } });
    await invoke("remove", { threadId: "rex~local" });
    sessions.length = 0;
    await lifecycles[0]!.sweep?.({ sessions: [], liveThreads: [], projectPaths: [], deleted: [] });
    expect((await invoke("state", { homeOnly: true })).threads).toEqual({ "rex~local": { pinned: true } });
    await invoke("restore", { threadId: "rex~local" });
    expect(removed).toHaveBeenCalledWith("rex~local");
    expect(restored).toHaveBeenCalledWith("rex~local");
    expect(machines.call.mock.calls.filter((call) => call[2] === "restore")).toEqual([]);
  });

  it("propagates offline writes and the home's archive refusal without writing local proxy meta", async () => {
    const machines = machineServices([{ ...rex, status: "offline" }]);
    machines.call.mockRejectedValue(new Error("Rex is offline."));
    const { invoke } = await harness({ machines: machines.services });
    await expect(invoke("patch", { patches: { "rex~t1": { pinned: true } } })).rejects.toThrow("Rex is offline.");
    await expect(invoke("remove", { threadId: "rex~t1" })).rejects.toThrow("Rex is offline.");
    expect((await invoke("state", { homeOnly: true })).threads).toEqual({});
    machines.update([rex]);
    machines.call.mockImplementation(async (_machine, _extension, command) => {
      if (command === "archive") throw new Error("Cannot archive a running thread.");
      return command === "trash" ? [] : { threads: {} };
    });
    await expect(invoke("archive", { threadId: "rex~t1" })).rejects.toThrow("Cannot archive a running thread.");
    expect((await invoke("state", { homeOnly: true })).threads).toEqual({});
  });
});


describe("Thread Rail old preference import ownership", () => {
  it("imports remote pins and settled ids on their home instead of persisting proxy metadata here", async () => {
    const machines = machineServices([rex]);
    const { invoke, stateDir } = await harness({ machines: machines.services, sessions: [proxy("rex~t1"), session("rex~local", "/local")] });
    await invoke("import", { pinned: ["rex~t1", "rex~local"], settled: ["rex~t1"] });
    expect(machines.call).toHaveBeenCalledWith("rex", THREAD_RAIL_EXTENSION_ID, "patch", { patches: { t1: expect.objectContaining({ pinned: null, settledAt: NOW, settledBy: "user" }) } });
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(stateDir, THREAD_RAIL_EXTENSION_ID, "thread-meta.json"), "utf8"))).toMatchObject({ imported: true, threads: { "rex~local": { pinned: true } } }));
    expect((await invoke("state", { homeOnly: true })).threads).toEqual({ "rex~local": { pinned: true, pinOrder: -1 } });
  });
});


describe("Working preference persistence", () => {
  it("defaults off and survives a host restart and other setting changes", async () => {
    const first = await harness();
    expect((await first.invoke("state")).settings.workingSection).toBe(false);
    expect((await first.invoke("settings", { workingSection: true })).settings.workingSection).toBe(true);
    await first.invoke("settings", { onClosed: true });
    await first.registry.dispose();
    const restarted = await harness({ stateDir: first.stateDir });
    expect((await restarted.invoke("state")).settings).toMatchObject({ workingSection: true, onClosed: true });
    expect((await restarted.invoke("settings", { workingSection: false })).settings.workingSection).toBe(false);
  });
});


it("notifies the declared Review command when a local thread is settled or restored, including undo patches", async () => {
  const shelf = vi.fn();
  const h = await harness({ watchShelf: shelf });
  await h.invoke("patch", { patches: { a: { settledAt: NOW, settledBy: "user" } } });
  await vi.waitFor(() => expect(shelf).toHaveBeenCalledWith({ settled: ["a"], restored: [] }, expect.anything()));
  await h.invoke("patch", { patches: { a: { settledAt: null, settledBy: null } } });
  await vi.waitFor(() => expect(shelf).toHaveBeenCalledWith({ settled: [], restored: ["a"] }, expect.anything()));
});
