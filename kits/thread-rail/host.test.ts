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
  HostThreadLifecycle,
  HostTurnObserver,
} from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { MACHINE_STATE_TOPIC, MACHINE_META_EVENT, MACHINE_TRASH_EVENT } from "./machine-state.js";
import { DAY_MS } from "./meta.js";
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
  machines?: HostMachineServices;
  stateDir?: string;
  sessions?: HostSessionSummary[];
  modified?: Record<string, number>;
  review?: (workspace: string) => unknown;
  /** Review Kit's answer about the requests threads link. */
  linked?: (threadIds: string[]) => unknown;
  now?: () => number;
}

async function harness(setup: Setup = {}) {
  const stateDir = setup.stateDir ?? await scratch();
  const events: PublishedKitEvent[] = [];
  const observers: HostTurnObserver[] = [];
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
    } as unknown as HostExtensionServices["sessions"],
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
  if (setup.review) {
    const review: HostExtension = {
      id: REVIEW_EXTENSION_ID,
      name: "Review Kit",
      activate(context: HostExtensionContext) {
        context.registerCommand("pr-status", (input) => setup.review!((input as { workspace: string }).workspace), { callers: [THREAD_RAIL_EXTENSION_ID] });
        if (setup.linked) context.registerCommand("thread-requests", (input) => setup.linked!((input as { threadIds: string[] }).threadIds), { callers: [THREAD_RAIL_EXTENSION_ID] });
      },
    };
    await registry.activate(review);
  }
  const invoke = (command: string, input?: unknown) => registry.invoke(THREAD_RAIL_EXTENSION_ID, command, input) as Promise<RailState>;
  return { invoke, events, observers, lifecycles, start, stateDir, removed, restored, registry };
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
    await expect(again.invoke("state")).resolves.toEqual(state);
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
    });
    await invoke("settings", { inactiveDays: 3 });
    observers[0]!.accepted?.("busy", "turn", { deferBefore: false });

    const state = await invoke("sweep");
    expect(review.mock.calls.map((call) => call[0])).toEqual(["/worktrees/merged"]);
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
    expect((await invoke("state")).settings).toEqual({ onMerged: true, onClosed: false });
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
    expect((await invoke("state")).threads).toEqual({});
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
