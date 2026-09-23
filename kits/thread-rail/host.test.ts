import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HostExtension,
  HostExtensionContext,
  HostExtensionServices,
  HostSessionSummary,
  HostThreadLifecycle,
  HostTurnObserver,
} from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
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
  return { invoke, events, observers, lifecycles, start, stateDir, removed, restored };
}

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

  it("takes over core's old pins and settled shelf once", async () => {
    const { invoke } = await harness();
    const first = await invoke("import", { pinned: ["p"], settled: ["s"] });
    expect(first.threads).toEqual({ p: { pinned: true, pinOrder: 0 }, s: { settledAt: NOW, settledBy: "user" } });
    await invoke("patch", { patches: { p: null } });
    expect((await invoke("import", { pinned: ["p"] })).threads.p).toBeUndefined();
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
