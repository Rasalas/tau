// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NewThreadClaimEvent, UiModel, UiSession, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import threadRailExtension from "./desktop.js";
import {
  META_EVENT,
  SIBLINGS_SERVICE,
  THREAD_RAIL_EXTENSION_ID,
  WORKSPACE_STORE_SERVICE,
  type RailOrganizer,
  type RailState,
  type ThreadSiblingsService,
  type WorkspaceStoreSlice,
} from "./protocol.js";

afterEach(cleanup);

const thread = (id: string, modifiedAt = 1): UiSession => ({
  id, path: `/sessions/${id}.jsonl`, title: id, modifiedAt, projectPath: "/project", projectName: "project", messageCount: 1,
});
const model = (id: string): UiModel => ({ provider: "openai", id, name: id } as UiModel);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: { isRepo?: boolean; initial?: Partial<RailState> } = {}) {
  let state: RailState = { threads: {}, settings: { onMerged: true, onClosed: false }, ...options.initial };
  const invoke = vi.fn(async (_extensionId: string, command: string, input?: unknown) => {
    if (command === "state" || command === "import") return state;
    if (command === "patch") {
      const patches = (input as { patches: Record<string, Record<string, unknown> | null> }).patches;
      const threads = { ...state.threads } as Record<string, Record<string, unknown>>;
      for (const [id, patch] of Object.entries(patches)) {
        if (patch === null) { delete threads[id]; continue; }
        const next = { ...threads[id] };
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete next[key]; else next[key] = value;
        }
        threads[id] = next;
      }
      state = { ...state, threads };
      return state;
    }
    if (command === "start") return { sessionId: `started-${invoke.mock.calls.filter((call) => call[1] === "start").length}`, cwd: (input as { cwd: string }).cwd };
    return undefined;
  });
  const { registry, preferences } = createKitHarness(invoke);
  let organizer: RailOrganizer | undefined;
  const worktrees: Array<{ force?: boolean; branchSuffix?: string }> = [];
  const workspace: WorkspaceStoreSlice = {
    getSnapshot: () => ({ draftPending: true, workspace: { isRepo: options.isRepo ?? true } }),
    subscribe: () => () => undefined,
    registerThreadRailOrganizer: (value) => { organizer = value; return () => { organizer = undefined; }; },
    registerThreadRowAccessory: () => () => undefined,
    prepareThreadWorktree: async (request) => {
      worktrees.push({ ...(request.force ? { force: true } : {}), ...(request.branchSuffix ? { branchSuffix: request.branchSuffix } : {}) });
      return request.force ? { workspace: { workspaceId: `ws-${worktrees.length}`, displayPath: `/worktrees/${worktrees.length}` } } : {};
    },
  };
  registry.activate({ id: "tau.workspace", name: "Workspace Kit", activate: (context) => context.provideService(WORKSPACE_STORE_SERVICE, workspace) });
  registry.activate(threadRailExtension);
  const actions = { notify: vi.fn(), switchSession: vi.fn(async () => true), activeThread: vi.fn(() => ({ sessionId: "b", draftPending: false })) } as unknown as WorkbenchActions;
  const push = (payload: RailState) => registry.dispatchExtensionEvent({ type: "extension-event", extensionId: THREAD_RAIL_EXTENSION_ID, name: META_EVENT, payload });
  const calls = (command: string) => invoke.mock.calls.filter((call) => call[1] === command).map((call) => call[2]);
  return { registry, preferences, invoke, actions, push, calls, worktrees, organizer: () => organizer!, current: () => state };
}

const claim = (overrides: Partial<NewThreadClaimEvent> = {}): NewThreadClaimEvent => ({
  prompt: "fix the queue", projectPath: "/project", preparing: () => undefined, alternate: false, runtime: "pi", attachments: 0, ...overrides,
});

describe("Thread Rail on the desktop", () => {
  it("organizes Workspace Kit's rail into pinned, active, snoozed and settled threads", async () => {
    const { organizer, push } = setup();
    await flush();
    push({ threads: { p: { pinned: true, pinOrder: 0 }, z: { snoozedUntil: Date.now() + 60_000 }, d: { settledAt: 1, settledBy: "user" } }, settings: { onMerged: true, onClosed: false } });
    const sections = organizer().sections([thread("a"), thread("p"), thread("z"), thread("d")]);
    expect(sections.map((section) => [section.id, section.threads.map((entry) => entry.id)])).toEqual([
      ["pinned", ["p"]], ["active", ["a"]], ["snoozed", ["z"]], ["settled", ["d"]],
    ]);
    expect(organizer().dropLabel("a", { sectionId: "pinned" })).toBe("Pin");
    expect(organizer().dropLabel("a", { sectionId: "snoozed" })).toBeUndefined();
  });

  it("pins from the row menu at once and tells the host", async () => {
    const { organizer, calls, actions } = setup();
    await flush();
    organizer().sections([thread("a")]);
    const items = organizer().menu(thread("a")).flatMap((section) => section.items.map((item) => item.id));
    expect(items).toEqual(["pin", "snooze:1h", "snooze:tomorrow", "snooze:next-week", "snooze:custom", "settle", "move-up", "move-down"]);
    organizer().runMenu(thread("a"), "pin", actions);
    expect(organizer().sections([thread("a")])[0]?.threads.map((entry) => entry.id)).toEqual(["a"]);
    expect(calls("patch")).toEqual([{ patches: { a: { pinned: true, pinOrder: 0 } } }]);
  });

  it("hands core's old pins and settled threads to the host once, then mirrors the host into the preferences", async () => {
    const harness = setup();
    await flush();
    harness.preferences.togglePinned("old-pin");
    harness.registry.deactivate(THREAD_RAIL_EXTENSION_ID);
    harness.registry.activate(threadRailExtension);
    await flush();
    expect(harness.calls("import")).toEqual([{ pinned: ["old-pin"], settled: [] }]);

    harness.push({ threads: { host: { settledAt: 5, settledBy: "inactive" } }, settings: { onMerged: true, onClosed: false } });
    expect(harness.preferences.getSnapshot().settledThreadIds).toEqual(["host"]);
    expect(harness.preferences.getSnapshot().pinnedThreadIds).toEqual([]);

    // Core's own "Settle thread" still writes the preferences; the host hears of it.
    harness.preferences.toggleSettled("mine");
    expect(harness.calls("patch").at(-1)).toMatchObject({ patches: { mine: { settledBy: "user" } } });
  });

  it("starts a new thread in the background on mod+Enter and leaves a plain send alone", async () => {
    const { registry, actions, calls } = setup();
    await expect(registry.claimNewThread(claim(), actions)).resolves.toBe(false);
    await expect(registry.claimNewThread(claim({ alternate: true, model: { provider: "openai", id: "gpt-5.6-luna" } }), actions)).resolves.toBe(true);
    expect(calls("start")).toEqual([{ cwd: "/project", prompt: "fix the queue", model: { provider: "openai", id: "gpt-5.6-luna" } }]);
    expect(actions.notify).toHaveBeenCalledWith("Started in the background: fix the queue");
    await expect(registry.claimNewThread(claim({ alternate: true, runtime: "claude-code" }), actions)).resolves.toBe(false);
    await expect(registry.claimNewThread(claim({ alternate: true, attachments: 1 }), actions)).resolves.toBe(false);
  });

  it("sends one prompt to every model of the set, each in its own worktree, and groups them as siblings", async () => {
    const { registry, actions, calls, worktrees, push } = setup();
    const selection = registry.getModelSelection()!;
    selection.toggle(model("luna"), model("luna"));
    expect(selection.selected()).toEqual(["openai/luna", "openai/luna"]);
    selection.toggle(model("luna"), model("luna"));
    expect(selection.selected()).toEqual([]);
    selection.toggle(model("sol"), model("luna"));
    expect(selection.selected()).toEqual(["openai/luna", "openai/sol"]);

    await expect(registry.claimNewThread(claim(), actions)).resolves.toBe(true);
    expect(worktrees).toEqual([{ force: true, branchSuffix: "1" }, { force: true, branchSuffix: "2" }]);
    const starts = calls("start") as Array<{ cwd: string; model: unknown; siblingGroupId: string }>;
    expect(starts.map((entry) => [entry.cwd, entry.model])).toEqual([
      ["/worktrees/1", { provider: "openai", id: "luna" }],
      ["/worktrees/2", { provider: "openai", id: "sol" }],
    ]);
    expect(starts[0]!.siblingGroupId).toBe(starts[1]!.siblingGroupId);
    expect(selection.selected()).toEqual([]);

    let siblings: ThreadSiblingsService | undefined;
    registry.activate({ id: "tau.agents", name: "Agents", activate: (context) => context.useService<ThreadSiblingsService>(SIBLINGS_SERVICE, (value) => { siblings = value; }) });
    push({ threads: { one: { siblingGroupId: "g" }, two: { siblingGroupId: "g" } }, settings: { onMerged: true, onClosed: false } });
    expect(siblings?.siblingsOf("one")).toEqual(["one", "two"]);
  });

  it("keeps a model set for a Git project only", async () => {
    const { registry, actions, calls } = setup({ isRepo: false });
    const selection = registry.getModelSelection()!;
    selection.toggle(model("sol"), model("luna"));
    await expect(registry.claimNewThread(claim(), actions)).resolves.toBe(false);
    expect(calls("start")).toEqual([]);
    expect(actions.notify).toHaveBeenCalledWith(expect.stringContaining("needs a Git project"));
  });

  it("walks the threads the rail drew with next, previous and the number jumps", async () => {
    const { registry, organizer, actions } = setup();
    await flush();
    organizer().sections([thread("a", 3), thread("b", 2), thread("c", 1)]);
    await registry.executeCommand("thread.next", actions);
    expect(actions.switchSession).toHaveBeenLastCalledWith("/sessions/c.jsonl");
    await registry.executeCommand("thread.prev", actions);
    expect(actions.switchSession).toHaveBeenLastCalledWith("/sessions/a.jsonl");
    await registry.executeCommand("thread.jump-3", actions);
    expect(actions.switchSession).toHaveBeenLastCalledWith("/sessions/c.jsonl");
    expect(registry.getKeybindings().some((binding) => binding.commandId === "thread.jump-1" && binding.keys === "ctrl+1")).toBe(true);
  });
});
