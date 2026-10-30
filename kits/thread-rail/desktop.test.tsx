// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { NewThreadClaimEvent, UiModel, UiSession, WorkbenchActions } from "tau";
import { readWhenPick } from "tau";
import { ClientStorageProvider, createKitHarness, createMemoryStorage, setClientStorage, setHostClient, ToastStore, ThreadStore, ThreadStoreContext, WorkbenchShellContext } from "../../src/renderer/test-support/kit-harness.js";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
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

function setup(options: { isRepo?: boolean; initial?: Partial<RailState>; confirmations?: boolean; declineWorktree?: boolean; patchReply?: (state: RailState) => Promise<RailState> } = {}) {
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
      state = { ...state, threads, ...(state.publication ? { publication: { ...state.publication, revision: state.publication.revision + 1 } } : {}) };
      return options.patchReply ? options.patchReply(state) : state;
    }
    if (command === "archive") {
      const id = (input as { threadId: string }).threadId;
      state = { ...state, threads: { ...state.threads, [id]: { ...state.threads[id], archivedAt: 5 } } };
      return state;
    }
    if (command === "remove" || command === "restore") return undefined;
    if (command === "trash") return [];
    if (command === "start") return { sessionId: `started-${invoke.mock.calls.filter((call) => call[1] === "start").length}`, cwd: (input as { cwd: string }).cwd };
    return undefined;
  });
  const { registry, preferences } = createKitHarness(invoke);
  let organizer: RailOrganizer | undefined;
  const worktrees: Array<{ force?: boolean; branchSuffix?: string }> = [];
  let railProjectFilter: string | readonly string[] | undefined;
  const workspace: WorkspaceStoreSlice = {
    getSnapshot: () => ({ draftPending: true, workspace: { isRepo: options.isRepo ?? true }, ...(railProjectFilter ? { railProjectFilter } : {}) }),
    setRailProjectFilter: vi.fn((name: string | readonly string[] | undefined) => { railProjectFilter = name; }),
    openProjectSettings: vi.fn(),
    subscribe: () => () => undefined,
    registerThreadRailOrganizer: (value) => { organizer = value; return () => { organizer = undefined; }; },
    registerThreadRowAccessory: () => () => undefined,
    prepareThreadWorktree: async (request) => {
      if (options.declineWorktree) throw new Error("Not sent: the worktree could not be created.");
      worktrees.push({ ...(request.force ? { force: true } : {}), ...(request.branchSuffix ? { branchSuffix: request.branchSuffix } : {}) });
      return request.force ? { workspace: { workspaceId: `ws-${worktrees.length}`, displayPath: `/worktrees/${worktrees.length}` }, baseCommit: "first-base" } : {};
    },
  };
  registry.activate({ id: "tau.workspace", name: "Workspace Kit", activate: (context) => context.provideService(WORKSPACE_STORE_SERVICE, workspace) });
  registry.activate(threadRailExtension);
  // Deleting asks first by default; the tests about the question turn it back on.
  if (!options.confirmations) preferences.setOption(THREAD_RAIL_EXTENSION_ID, "confirm-delete", false);
  const actions = {
    notify: vi.fn(),
    switchSession: vi.fn(async () => true),
    newSession: vi.fn(),
    openSettings: vi.fn(),
    activeThread: vi.fn(() => ({ sessionId: "b", draftPending: false })),
    copyText: vi.fn(async () => undefined),
    renameThread: vi.fn(async () => true),
    executeCommand: vi.fn(async () => undefined),
  } as unknown as WorkbenchActions;
  const push = (payload: RailState) => registry.dispatchExtensionEvent({ type: "extension-event", extensionId: THREAD_RAIL_EXTENSION_ID, name: META_EVENT, payload });
  const calls = (command: string) => invoke.mock.calls.filter((call) => call[1] === command).map((call) => call[2]);
  return { registry, preferences, invoke, actions, push, calls, worktrees, workspace, organizer: () => organizer!, current: () => state };
}

const claim = (overrides: Partial<NewThreadClaimEvent> = {}): NewThreadClaimEvent => ({
  prompt: "fix the queue", projectPath: "/project", preparing: () => undefined, alternate: false, runtime: "pi", attachments: 0, ...overrides,
});

it("keeps a settled thread off the active list while an older metadata push overtakes its patch reply", async () => {
  let acknowledge!: () => void;
  const harness = setup({ patchReply: (state) => new Promise((resolve) => { acknowledge = () => resolve(state); }) });
  await flush();
  const stale = harness.current();
  const active = () => harness.organizer().sections([thread("a")]).find((section) => section.id === "active")!.threads;
  expect(active().map((entry) => entry.id)).toEqual(["a"]);
  harness.organizer().toggleSettled(thread("a"));
  await flush();
  expect(active()).toEqual([]);
  harness.push(stale);
  expect(active()).toEqual([]);
  acknowledge();
  await flush();
  expect(active()).toEqual([]);
});

it("ignores pre-settlement snapshots after the write has been acknowledged", async () => {
  const harness = setup({ initial: { publication: { epoch: "host", revision: 0 } } });
  await flush();
  const stale = harness.current();
  harness.organizer().toggleSettled(thread("a"));
  await flush();
  harness.push(stale);
  expect(harness.organizer().sections([thread("a")]).find((section) => section.id === "active")!.threads).toEqual([]);
});

it("keeps the latest un-settle intent visible while two write replies are delayed", async () => {
  const acknowledgments: Array<() => void> = [];
  const harness = setup({ patchReply: (state) => new Promise((resolve) => { acknowledgments.push(() => resolve(state)); }) });
  await flush();
  harness.organizer().toggleSettled(thread("a"));
  await flush();
  harness.organizer().toggleSettled(thread("a"));
  await flush();
  const active = () => harness.organizer().sections([thread("a")]).find((section) => section.id === "active")!.threads.map((entry) => entry.id);
  expect(active()).toEqual(["a"]);
  expect(harness.calls("patch")).toHaveLength(1);
  acknowledgments.shift()!();
  await flush();
  expect(active()).toEqual(["a"]);
  expect(harness.calls("patch")).toHaveLength(2);
  acknowledgments.shift()!();
  await flush();
  expect(active()).toEqual(["a"]);
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
    const items = organizer().menu(thread("a")).flatMap((section) => section.items);
    expect(items.map((item) => item.id)).toEqual(["fork", "pin", "move", "settle", "snooze", "rename", "mark-unread", "filter-project", "copy", "instructions", "project-settings", "archive", "delete"]);
    expect(items[2]!.submenu![0]!.items.map((item) => item.id)).toEqual(["move-up", "move-down"]);
    const presets = items[4]!.submenu!.flatMap((section) => section.items.map((item) => item.id));
    expect(presets.slice(0, 2)).toEqual(["snooze:1h", "snooze:3h"]);
    expect(presets).toContain("snooze:tomorrow");
    expect(presets.at(-1)).toBe("snooze:custom");
    organizer().runMenu(thread("a"), "pin", actions);
    expect(organizer().sections([thread("a")])[0]?.threads.map((entry) => entry.id)).toEqual(["a"]);
    expect(calls("patch")).toEqual([{ patches: { a: { pinned: true, pinOrder: 0 } } }]);
  });

  it("disables what a Read-only device may not change, says why, and sends nothing", async () => {
    const { organizer, calls, actions } = setup();
    await flush();
    organizer().sections([thread("a")]);
    setHostClient(createFakeHostClient({ isReadOnly: () => true }));
    try {
      const items = organizer().menu(thread("a")).flatMap((section) => section.items);
      const enabled = items.filter((item) => !item.disabled).map((item) => item.id);
      expect(enabled).toEqual(["fork", "mark-unread", "filter-project", "copy", "instructions", "project-settings"]);
      expect(items[0]!.submenu![0]!.items.map((item) => [item.id, Boolean(item.disabled)])).toEqual([["tree", false], ["duplicate", true]]);
      expect(items.find((item) => item.id === "archive")?.description).toMatch(/Read only/u);
      organizer().runMenu(thread("a"), "pin", actions);
      expect(calls("patch")).toEqual([]);
      expect(actions.notify).toHaveBeenCalledWith(expect.stringMatching(/Read only/u));
    } finally {
      setHostClient(undefined);
    }
  });

  it("offers a Snooze hover clock with presets and a custom time", async () => {
    const { organizer, calls, actions, push } = setup();
    await flush();
    push({ threads: { d: { settledAt: 1, settledBy: "user" } }, settings: { onMerged: true, onClosed: false } });
    expect(organizer().rowActions?.(thread("a"))).toMatchObject([{ id: "snooze", label: "Snooze thread" }]);
    expect(organizer().rowActions?.(thread("d"))).toEqual([]);
    const snooze = organizer().menu(thread("a")).flatMap((section) => section.items).find((item) => item.id === "snooze");
    expect(snooze?.submenu?.[0]?.items[0]).toMatchObject({ id: "snooze:1h", label: "In 1 hour" });
    expect(organizer().menu(thread("d")).flatMap((section) => section.items).some((item) => item.id === "snooze")).toBe(false);
    const storage = createMemoryStorage();
    setClientStorage(storage);
    const marks = (items: ReturnType<RailOrganizer["menu"]>) =>
      items.flatMap((section) => section.items).find((item) => item.id === "snooze")!.submenu![0]!.items.map((item) => item.selected);
    try {
      // Nothing used yet: plain items, no choice marked.
      expect(new Set(marks(organizer().menu(thread("a"))))).toEqual(new Set([undefined]));
      organizer().runMenu(thread("a"), "snooze:1h", actions);
      expect(calls("patch").at(-1)).toMatchObject({ patches: { a: { snoozedUntil: expect.any(Number) } } });
      // The Snooze dialog opens on the preset last picked here.
      expect(readWhenPick(storage, "thread-rail.snooze")).toBe("1h");
      organizer().runBulkMenu!([thread("a"), thread("b")], "snooze:tomorrow", actions);
      expect(readWhenPick(storage, "thread-rail.snooze")).toBe("tomorrow");
      const presets = organizer().menu(thread("c")).flatMap((section) => section.items).find((item) => item.id === "snooze")!.submenu![0]!.items;
      expect(presets.filter((item) => item.selected).map((item) => item.id)).toEqual(["snooze:tomorrow"]);
      expect(organizer().bulkMenu!([thread("c")])[0]!.items.find((item) => item.id === "snooze")!.submenu![0]!.items.find((item) => item.selected)?.id).toBe("snooze:tomorrow");
      expect(organizer().rowActions!(thread("c"))[0]!.menu()[0]!.items.find((item) => item.selected)?.id).toBe("snooze:tomorrow");
    } finally {
      setClientStorage(undefined);
    }
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
    expect(calls("start")).toEqual([expect.objectContaining({ cwd: "/project", prompt: "fix the queue", model: { provider: "openai", id: "gpt-5.6-luna" } })]);
    expect(actions.notify).toHaveBeenCalledWith("Started in the background: fix the queue");
    await expect(registry.claimNewThread(claim({ alternate: true, runtime: "claude-code" }), actions)).resolves.toBe(true);
    await expect(registry.claimNewThread(claim({ alternate: true, attachments: 1 }), actions)).rejects.toThrow("attached files were not available");
  });

  it("starts nothing in the background when the user would not run the prompt in the checkout", async () => {
    const { registry, actions, calls } = setup({ declineWorktree: true });
    await expect(registry.claimNewThread(claim({ alternate: true }), actions)).rejects.toThrow("Not sent: the worktree could not be created.");
    expect(calls("start")).toEqual([]);
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
    expect(worktrees).toEqual([{ force: true, branchSuffix: expect.stringMatching(/-1$/u) }, { force: true, branchSuffix: expect.stringMatching(/-2$/u) }]);
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

  it("fans out mixed runtimes with identical images, file and skill context", async () => {
    const { registry, actions, calls } = setup();
    const selection = registry.getModelSelection()!;
    selection.toggle(model("claude"), model("pi"), "claude-code", "pi");
    selection.toggle(model("codex"), undefined, "codex");
    const promptAttachments = [
      { kind: "image" as const, name: "shot.png", mimeType: "image/png", data: "aGVsbG8=", size: 5 },
      { kind: "file" as const, name: "spec.md", mimeType: "text/markdown", path: "/shared/spec.md", size: 10 },
    ];
    const skillDraft = { source: "skill" as const, name: "tdd", visibleText: "/tdd", command: "/skill:tdd" };
    await expect(registry.claimNewThread(claim({ promptAttachments, attachments: 2, skillDraft }), actions)).resolves.toBe(true);
    const starts = calls("start") as Array<Record<string, unknown>>;
    expect(starts.map((entry) => entry.backend)).toEqual(["pi", "claude-code", "codex"]);
    for (const entry of starts) expect(entry).toMatchObject({ attachments: promptAttachments, skillDraft });
    expect(new Set(starts.map((entry) => entry.cwd)).size).toBe(3);
  });

  it("keeps failed targets for retry and removes their unused worktrees", async () => {
    const { registry, actions, invoke, workspace, calls } = setup();
    const selection = registry.getModelSelection()!;
    selection.toggle(model("claude"), model("pi"), "claude-code", "pi");
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (id, command, input) => {
      if (command === "start" && (input as { backend: string }).backend === "claude-code") throw new Error("Login required");
      return original(id, command, input);
    });
    workspace.removeWorktree = vi.fn(async () => true);
    await expect(registry.claimNewThread(claim(), actions)).rejects.toThrow("Started 1 of 2");
    expect(selection.selected()).toEqual(["claude-code::openai/claude"]);
    expect(workspace.removeWorktree).toHaveBeenCalledWith("/worktrees/2");
    invoke.mockImplementation(original);
    await expect(registry.claimNewThread(claim(), actions)).resolves.toBe(true);
    expect(calls("start")).toHaveLength(3);
    const starts = calls("start") as Array<{ siblingGroupId: string }>;
    expect(starts[2]!.siblingGroupId).toBe(starts[0]!.siblingGroupId);
    expect(selection.selected()).toEqual([]);
  });

  it("keeps a model set for a Git project only", async () => {
    const { registry, actions, calls } = setup({ isRepo: false });
    const selection = registry.getModelSelection()!;
    selection.toggle(model("sol"), model("luna"));
    await expect(registry.claimNewThread(claim(), actions)).rejects.toThrow("needs a Git project");
    expect(calls("start")).toEqual([]);
    expect(selection.selected()).toEqual(["openai/luna", "openai/sol"]);
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
    expect(registry.getKeybindings().some((binding) => binding.commandId === "thread.jump-1" && binding.keys === "mod+1" && binding.when === "!modelPickerOpen && isDesktop")).toBe(true);
    expect(registry.getKeybindings().filter((binding) => binding.commandId === "thread.next").map((binding) => binding.keys)).toEqual(["mod+shift+]", "mod+alt+arrowdown"]);
  });

  it("archives from the row menu, leaves the rail without it, and mod+z brings it back", async () => {
    const { registry, organizer, actions, calls } = setup();
    await flush();
    organizer().sections([thread("a", 2), thread("b", 1)]);
    organizer().runMenu(thread("a"), "archive", actions);
    await flush();
    expect(calls("archive")).toEqual([{ threadId: "a" }]);
    expect(organizer().sections([thread("a", 2), thread("b", 1)]).flatMap((section) => section.threads.map((entry) => entry.id))).toEqual(["b"]);
    expect(actions.newSession).not.toHaveBeenCalled();

    await registry.executeCommand("thread.undo", actions);
    expect(calls("patch").at(-1)).toEqual({ patches: { a: { archivedAt: null } } });
    expect(registry.getKeybindings().find((binding) => binding.commandId === "thread.undo")).toMatchObject({ keys: "mod+z", when: "!terminalFocus && !editableFocus" });
  });

  it("offers the undo as a toast on core's stack and takes it away when the window closes", async () => {
    const { registry, organizer, actions } = setup();
    const dismiss = vi.fn();
    const shown: Array<{ title?: string; description?: string; actions?: Array<{ label: string; run(): void }> }> = [];
    actions.toast = vi.fn((options) => { shown.push(options); return { id: "t", update: vi.fn(), dismiss }; });
    await flush();
    const Layer = organizer().Layer!;
    render(<WorkbenchShellContext.Provider value={{ registry } as never}>
      <ThreadStoreContext.Provider value={new ThreadStore()}><Layer actions={actions} /></ThreadStoreContext.Provider>
    </WorkbenchShellContext.Provider>);
    organizer().sections([thread("a", 2), thread("b", 1)]);
    await act(async () => { organizer().runMenu(thread("a"), "archive", actions); await flush(); });
    expect(shown.at(-1)).toMatchObject({ title: "Archived 1 thread", description: expect.stringMatching(/Z to undo$/u), actions: [{ label: "Undo" }] });
    expect(document.querySelector(".thread-rail-undo")).toBeNull();

    act(() => { shown.at(-1)!.actions![0]!.run(); });
    expect(dismiss).toHaveBeenCalled();
    expect(organizer().sections([thread("a", 2), thread("b", 1)]).flatMap((section) => section.threads.map((entry) => entry.id))).toEqual(["a", "b"]);
  });

  it("hides the settle toast after two seconds but keeps keyboard undo for five", async () => {
    const { registry, organizer, actions, current } = setup();
    await flush();
    vi.useFakeTimers();
    const toasts = new ToastStore();
    actions.toast = toasts.show;
    const Layer = organizer().Layer!;
    const view = render(<WorkbenchShellContext.Provider value={{ registry } as never}>
      <ThreadStoreContext.Provider value={new ThreadStore()}><Layer actions={actions} /></ThreadStoreContext.Provider>
    </WorkbenchShellContext.Provider>);
    try {
      organizer().sections([thread("a")]);
      await act(async () => { organizer().runMenu(thread("a"), "settle", actions); });
      expect(toasts.getToasts()).toMatchObject([{ title: "Settled 1 thread" }]);
      await act(async () => { vi.advanceTimersByTime(1_999); });
      expect(toasts.getToasts()).toHaveLength(1);
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(toasts.getToasts()).toEqual([]);
      expect(current().threads.a?.settledAt).toBeDefined();

      await act(async () => { vi.advanceTimersByTime(2_999); });
      await act(async () => { await registry.executeCommand("thread.undo", actions); });
      expect(current().threads.a?.settledAt).toBeUndefined();
      expect(toasts.getToasts()).toEqual([]);
    } finally {
      view.unmount();
      registry.deactivate(THREAD_RAIL_EXTENSION_ID);
      toasts.dispose();
      vi.useRealTimers();
    }
  });

  it("opens a new thread in the project when the thread on screen is archived, and undo returns to it", async () => {
    const { registry, organizer, actions } = setup();
    await flush();
    organizer().sections([thread("a"), thread("b")]);
    organizer().runMenu(thread("b"), "archive", actions);
    await flush();
    expect(actions.newSession).toHaveBeenCalledWith({ workspace: "/project" });
    await registry.executeCommand("thread.undo", actions);
    await flush();
    expect(actions.switchSession).toHaveBeenLastCalledWith("/sessions/b.jsonl");
  });

  it("deletes the thread on screen after moving to the next one, and undo restores it", async () => {
    const { registry, organizer, actions, calls } = setup();
    await flush();
    organizer().sections([thread("a", 1), thread("b", 2)]);
    organizer().runMenu(thread("b"), "delete", actions);
    await flush();
    expect(actions.switchSession).toHaveBeenCalledWith("/sessions/a.jsonl");
    expect(calls("remove")).toEqual([{ threadId: "b" }]);

    await registry.executeCommand("thread.undo", actions);
    await flush();
    expect(calls("restore")).toEqual([{ threadId: "b" }]);
    expect(actions.switchSession).toHaveBeenLastCalledWith("/sessions/b.jsonl");
  });

  it("refuses to archive or delete a running thread", async () => {
    const { registry, organizer, actions, calls } = setup();
    await flush();
    registry.dispatchWorkbenchEvent({ type: "agent-status", sessionId: "a", running: true });
    const lifecycle = organizer().menu(thread("a")).at(-1)!.items;
    expect(lifecycle.map((item) => [item.id, item.disabled, item.destructive ?? false])).toEqual([["archive", true, false], ["delete", true, true]]);
    organizer().runMenu(thread("a"), "delete", actions);
    await flush();
    expect(calls("remove")).toEqual([]);
    expect(actions.notify).toHaveBeenCalledWith("Stop the thread before deleting it.");
  });

  it("says above the composer that the thread on screen is settled, and un-settles it from there", async () => {
    const { registry, actions, calls, push } = setup();
    await flush();
    const region = registry.getRegions("composer-above").find((entry) => entry.id === "thread-rail.settled-note")!;
    const snapshot = { sessionId: "b" } as never;
    const view = render(<region.Component snapshot={snapshot} actions={actions} />);
    expect(view.container.textContent).toBe("");
    act(() => push({ threads: { b: { settledAt: 3, settledBy: "user" } }, settings: { onMerged: true, onClosed: false } }));
    expect(view.getByRole("status").textContent).toContain("This thread is settled");
    act(() => view.getByRole("button", { name: "Reopen" }).click());
    expect(calls("patch").at(-1)).toEqual({ patches: { b: expect.objectContaining({ settledAt: null, settledBy: null }) } });
    expect(view.container.textContent).toBe("");
  });

  it("takes back a settle with the pin it cleared, and offers archive and delete in the title menu", async () => {
    const { registry, organizer, actions, calls, push } = setup();
    await flush();
    push({ threads: { p: { pinned: true, pinOrder: 0 } }, settings: { onMerged: true, onClosed: false } });
    organizer().runMenu(thread("p"), "settle", actions);
    await registry.executeCommand("thread.undo", actions);
    await flush();
    expect(calls("patch").at(-1)).toEqual({ patches: { p: { settledAt: null, settledBy: null, pinned: true, pinOrder: 0, order: null, snoozedUntil: null, keptAt: null } } });

    const title = registry.getCommandsFor("thread-title").map((command) => [command.id, command.destructive ?? false]);
    expect(title).toEqual(expect.arrayContaining([["thread.archive", false], ["thread.delete", true]]));
  });

  it("acts on the thread a compact list row names, not the one on screen", async () => {
    const { registry, organizer, actions, calls } = setup();
    await flush();
    organizer().sections([thread("a", 2), thread("b", 1)]);
    const row = registry.getCommandsFor("thread-row");
    expect(row.map((command) => [command.id, Boolean(command.Icon), command.destructive ?? false])).toEqual([
      ["thread.snooze", true, false], ["thread.archive", true, false], ["thread.delete", true, true],
    ]);
    await row.find((command) => command.id === "thread.archive")!.run(actions, { threadId: "a" });
    await flush();
    expect(calls("archive")).toEqual([{ threadId: "a" }]);
    // Without a named thread (the palette, the title menu) it is the open one.
    await registry.executeCommand("thread.archive", actions);
    await flush();
    expect(calls("archive")).toEqual([{ threadId: "a" }, { threadId: "b" }]);
  });

  it("builds the full row menu: a new thread on the branch, names, filter, copy and the project", async () => {
    const { organizer, registry } = setup();
    await flush();
    const branched = { ...thread("a"), projectLabel: "feature/rail" };
    registry.activate({ id: "tau.thread-titles", name: "Titles", activate: (context) => context.provideService("tau.thread-titles/titles", { regenerate: async () => undefined }) });
    const Layer = organizer().Layer!;
    render(<WorkbenchShellContext.Provider value={{ registry } as never}>
      <ThreadStoreContext.Provider value={new ThreadStore()}><Layer actions={{ toast: vi.fn(() => ({ id: "t", update: vi.fn(), dismiss: vi.fn() })) } as never} /></ThreadStoreContext.Provider>
    </WorkbenchShellContext.Provider>);
    organizer().sections([branched]);
    const sections = organizer().menu(branched);
    expect(sections.map((section) => section.items.map((item) => item.label))).toEqual([
      ["New thread on feature/rail", "Fork", "Pin thread", "Move", "Settle thread", "Snooze"],
      ["Rename thread", "Regenerate title", "Mark unread", "Filter by project"],
      ["Copy", "Instructions & prompt…", "Project settings…"],
      ["Archive thread", "Delete"],
    ]);
    expect(sections[2]!.items[0]!.submenu![0]!.items.map((item) => item.label)).toEqual(["Path", "Branch", "Thread ID", "Chat as Markdown"]);
    // Without a branch there is nothing to start on or copy.
    const plain = organizer().menu(thread("a"));
    expect(plain[0]!.items[0]!.id).toBe("fork");
    expect(plain[2]!.items[0]!.submenu![0]!.items.map((item) => item.id)).toEqual(["copy-path", "copy-thread-id", "copy-chat"]);
  });

  it("runs the row menu's new items against the workbench, Workspace Kit and Thread Titles", async () => {
    const { organizer, actions, workspace, registry } = setup();
    const regenerate = vi.fn(async () => undefined);
    registry.activate({ id: "tau.thread-titles", name: "Titles", activate: (context) => context.provideService("tau.thread-titles/titles", { regenerate }) });
    await flush();
    const branched = { ...thread("a"), projectLabel: "feature/rail", workspaceId: "ws-a" };
    organizer().runMenu(branched, "new-on-branch", actions);
    // The picker still asks, with the thread's project first (K98).
    expect(actions.newSession).toHaveBeenCalledWith({ workspace: "ws-a", pick: true });
    organizer().runMenu(branched, "copy-branch", actions);
    organizer().runMenu(branched, "copy-thread-id", actions);
    organizer().runMenu(branched, "copy-path", actions);
    await flush();
    expect(vi.mocked(actions.copyText).mock.calls.map((call) => call[0])).toEqual(["feature/rail", "a", "/project"]);
    expect(actions.notify).toHaveBeenCalledWith("Branch copied.");
    organizer().runMenu(branched, "filter-project", actions);
    expect(workspace.setRailProjectFilter).toHaveBeenLastCalledWith(["ws-a"]);
    expect(organizer().menu(branched)[1]!.items.find((item) => item.id === "filter-project")?.label).toBe("Show all projects");
    organizer().runMenu(branched, "filter-project", actions);
    expect(workspace.setRailProjectFilter).toHaveBeenLastCalledWith(undefined);
    organizer().runMenu(branched, "project-settings", actions);
    expect(workspace.openProjectSettings).toHaveBeenCalledWith(branched);
    // Titles are made for the thread on screen, so another one is opened first.
    organizer().runMenu(branched, "regenerate-title", actions);
    await flush();
    expect(actions.switchSession).toHaveBeenCalledWith("/sessions/a.jsonl");
    expect(regenerate).toHaveBeenCalledWith(actions);
  });

  it("hands the title the row's menu, with other kits' thread commands in their places and chords as hints", async () => {
    const { organizer, actions, registry } = setup();
    registry.activate({ id: "kits", name: "Kits", activate: (context) => {
      const command = (id: string, label: string, extra = {}) => context.registerCommand({ id, label, group: "Thread", surfaces: ["thread-title"], access: "write", run: vi.fn(), ...extra });
      command("handoff.continue-in", "Continue in…");
      command("handoff.bring-back", "Bring back to parent");
      command("workspace.open-in-editor", "Open in external editor");
      command("probe.look", "Look", { access: "read" });
      command("probe.wipe", "Wipe", { destructive: true, unavailable: () => "Not now." });
      context.registerKeybinding({ keys: "mod+o", commandId: "workspace.open-in-editor" });
    } });
    await flush();
    organizer().sections([thread("a")]);
    const menu = registry.getThreadMenu()!;
    const sections = menu.menu(thread("a"), registry)!;
    expect(sections).toEqual(organizer().menu(thread("a"), registry));
    const ids = sections.map((section) => section.items.map((item) => item.id));
    expect(ids.slice(2)).toEqual([
      ["copy", "command:workspace.open-in-editor", "instructions", "project-settings"],
      ["command:probe.look"],
      ["archive", "command:probe.wipe", "delete"],
    ]);
    expect(sections[0]!.items[0]!.submenu![0]!.items.map((item) => item.id)).toEqual(["tree", "duplicate", "command:handoff.continue-in", "command:handoff.bring-back"]);
    expect(sections[0]!.items.find((item) => item.id === "pin")?.hint).toBeTruthy();
    expect(sections[2]!.items[1]).toMatchObject({ label: "Open in external editor", hint: registry.keybindingLabel("workspace.open-in-editor") });
    expect(sections[4]!.items[1]).toMatchObject({ destructive: true, disabled: true, description: "Not now." });
    // Every item carries an icon but another package's unknown command.
    expect(sections.flatMap((section) => section.items).filter((item) => !item.icon).map((item) => item.id)).toEqual(["command:probe.look", "command:probe.wipe"]);

    // The thread on screen is "b": an action of the open thread opens "a" first.
    const executeCommand = vi.mocked(actions.executeCommand!);
    const openThreadTree = vi.fn();
    Object.assign(actions, { openThreadTree });
    menu.run(thread("a"), "command:handoff.continue-in", actions);
    await flush();
    expect(actions.switchSession).toHaveBeenCalledWith("/sessions/a.jsonl");
    expect(executeCommand).toHaveBeenCalledWith("handoff.continue-in");
    vi.mocked(actions.activeThread).mockReturnValue({ sessionId: "a", draftPending: false });
    vi.mocked(actions.switchSession).mockClear();
    menu.run(thread("a"), "tree", actions);
    await flush();
    expect(actions.switchSession).not.toHaveBeenCalled();
    expect(openThreadTree).toHaveBeenCalledWith("navigate");
  });

  it("puts the menu's other actions in the palette, for the open thread", async () => {
    const { registry, actions, calls, organizer } = setup();
    await flush();
    organizer().sections([thread("a", 2), thread("b", 1)]);
    const threads = new ThreadStore();
    threads.applyThreadIndex({ projects: [], sessions: [thread("a", 2), thread("b", 1)] } as never);
    render(<WorkbenchShellContext.Provider value={{ registry } as never}>
      <ThreadStoreContext.Provider value={threads}>{(() => { const Layer = organizer().Layer!; return <Layer actions={{ ...actions, toast: vi.fn(() => ({ id: "t", update: vi.fn(), dismiss: vi.fn() })) } as never} />; })()}</ThreadStoreContext.Provider>
    </WorkbenchShellContext.Provider>);
    await registry.executeCommand("thread.move-up", actions);
    expect(calls("patch").at(-1)).toMatchObject({ patches: { b: expect.any(Object) } });
    await registry.executeCommand("thread.copy-thread-id", actions);
    await flush();
    expect(actions.copyText).toHaveBeenLastCalledWith("b");
    for (const id of ["thread.move-down", "thread.mark-unread", "thread.copy-path", "thread.filter-project"]) expect(registry.getCommand(id)).toBeDefined();
  });

  it("renames a thread from the row menu, opening it first", async () => {
    const { organizer, registry, actions } = setup();
    await flush();
    const Layer = organizer().Layer!;
    const threads = new ThreadStore();
    const view = render(<WorkbenchShellContext.Provider value={{ registry } as never}>
      <ThreadStoreContext.Provider value={threads}><Layer actions={actions} /></ThreadStoreContext.Provider>
    </WorkbenchShellContext.Provider>);
    act(() => organizer().runMenu(thread("a"), "rename", actions));
    const input = view.getByRole("textbox", { name: "Thread title" }) as HTMLInputElement;
    expect(input.value).toBe("a");
    fireEvent.change(input, { target: { value: "Better name" } });
    await act(async () => { fireEvent.submit(input.closest("form")!); await flush(); });
    expect(actions.switchSession).toHaveBeenCalledWith("/sessions/a.jsonl");
    expect(actions.renameThread).toHaveBeenCalledWith("Better name");
    expect(view.queryByRole("textbox", { name: "Thread title" })).toBeNull();
  });

  it("marks a thread unread through the client's index", async () => {
    const { organizer, registry, actions } = setup();
    await flush();
    const threads = new ThreadStore();
    const markUnread = vi.spyOn(threads, "markUnread");
    const Layer = organizer().Layer!;
    render(<WorkbenchShellContext.Provider value={{ registry } as never}>
      <ThreadStoreContext.Provider value={threads}><Layer actions={actions} /></ThreadStoreContext.Provider>
    </WorkbenchShellContext.Provider>);
    organizer().runMenu(thread("a"), "mark-unread", actions);
    expect(markUnread).toHaveBeenCalledWith("a");
  });

  it("gives a selection one menu, counts what each item touches and writes the host once", async () => {
    const { organizer, actions, push, calls, registry } = setup();
    await flush();
    push({ threads: { p: { pinned: true, pinOrder: 0 } }, settings: { onMerged: true, onClosed: false } });
    const selected = [thread("p"), thread("a"), thread("c")];
    organizer().sections(selected);
    const labels = organizer().bulkMenu!(selected).map((section) => section.items.map((item) => item.label));
    expect(labels).toEqual([["Unpin (1)", "Settle (3)", "Snooze (3)", "Mark unread (3)"], ["Archive (3)", "Delete (3)"]]);
    const before = calls("patch").length;
    organizer().runBulkMenu!(selected, "settle", actions);
    expect(calls("patch").length).toBe(before + 1);
    expect(Object.keys((calls("patch").at(-1) as { patches: object }).patches).sort()).toEqual(["a", "c", "p"]);
    expect(organizer().sections(selected).find((section) => section.id === "settled")?.threads.map((entry) => entry.id).sort()).toEqual(["a", "c", "p"]);
    // Undo takes the whole batch back.
    await registry.executeCommand("thread.undo", actions);
    await flush();
    expect(organizer().sections(selected).find((section) => section.id === "settled")?.threads).toEqual([]);
  });

  it("snoozes a selection with a preset, and leaves snooze out when a thread cannot take it", async () => {
    const { organizer, actions, push, calls } = setup();
    await flush();
    const selected = [thread("a"), thread("b")];
    organizer().sections(selected);
    organizer().runBulkMenu!(selected, "snooze:1h", actions);
    const patches = (calls("patch").at(-1) as { patches: Record<string, { snoozedUntil: number }> }).patches;
    expect(patches.a!.snoozedUntil).toBe(patches.b!.snoozedUntil);
    push({ threads: { d: { settledAt: 1, settledBy: "user" } }, settings: { onMerged: true, onClosed: false } });
    expect(organizer().bulkMenu!([thread("a"), thread("d")])[0]!.items.map((item) => item.id)).not.toContain("snooze");
  });

  it("regenerates a selection's titles two at a time without opening them, and says which failed", async () => {
    const { organizer, actions, registry } = setup();
    const pending: Array<{ id: string; settle(error?: Error): void }> = [];
    const regenerateThread = vi.fn((id: string) => new Promise<void>((resolve, reject) => { pending.push({ id, settle: (error) => { if (error) reject(error); else resolve(); } }); }));
    registry.activate({ id: "tau.thread-titles", name: "Titles", activate: (context) => context.provideService("tau.thread-titles/titles", { regenerate: async () => undefined, regenerateThread }) });
    registry.dispatchWorkbenchEvent({ type: "agent-status", sessionId: "d", running: true });
    await flush();
    const selected = [thread("a"), thread("b"), thread("c"), thread("d")];
    organizer().sections(selected);
    const item = organizer().bulkMenu!(selected)[0]!.items.find((entry) => entry.id === "regenerate-titles");
    expect(item).toMatchObject({ label: "Regenerate titles (3)", description: "Running threads stay." });
    const update = vi.fn();
    const toast = vi.fn(() => ({ id: "t", update, dismiss: vi.fn() }));
    organizer().runBulkMenu!(selected, "regenerate-titles", { ...actions, toast } as unknown as WorkbenchActions);
    await flush();
    // Two model calls at once; the running thread waits for its run.
    expect(pending.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: "loading", title: "Regenerating 3 titles", description: "0 of 3" }));
    pending[0]!.settle();
    await flush();
    expect(pending.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ description: "1 of 3" }));
    pending[1]!.settle(new Error("The thread has no conversation to title yet."));
    pending[2]!.settle();
    await flush();
    await flush();
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "warning", title: "Regenerated 2 of 3 titles", description: "b: The thread has no conversation to title yet.", copyText: "b: The thread has no conversation to title yet.",
    }));
    // Nothing was opened, and as with one title there is nothing to undo.
    expect(actions.switchSession).not.toHaveBeenCalled();
    expect(regenerateThread).toHaveBeenCalledTimes(3);
  });

  it("offers no title regeneration for a selection without Thread Titles, and reports success with a notice where there are no toasts", async () => {
    const { organizer, actions, registry } = setup();
    await flush();
    const selected = [thread("a"), thread("b")];
    organizer().sections(selected);
    expect(organizer().bulkMenu!(selected).flatMap((section) => section.items.map((entry) => entry.id))).not.toContain("regenerate-titles");
    const regenerateThread = vi.fn(async (_sessionId: string) => undefined);
    registry.activate({ id: "tau.thread-titles", name: "Titles", activate: (context) => context.provideService("tau.thread-titles/titles", { regenerate: async () => undefined, regenerateThread }) });
    await flush();
    organizer().runBulkMenu!(selected, "regenerate-titles", actions);
    await waitFor(() => expect(actions.notify).toHaveBeenCalledWith("Regenerated 2 titles."));
    expect(regenerateThread.mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
  });

  it("never moves the reader to a thread deleted in the same batch", async () => {
    const { organizer, actions } = setup();
    await flush();
    // "b" is on screen; "a" and "b" go together, so the reader lands on "c".
    const threads = [thread("b", 3), thread("a", 2), thread("c", 1)];
    organizer().sections(threads);
    organizer().runBulkMenu!([thread("a", 2), thread("b", 3)], "delete", actions);
    await flush();
    await flush();
    expect(vi.mocked(actions.switchSession).mock.calls.map((call) => call[0])).toEqual(["/sessions/c.jsonl"]);
  });

  describe("asking first", () => {
    function renderLayer(registry: ReturnType<typeof setup>["registry"], organizer: () => RailOrganizer, actions: WorkbenchActions) {
      const Layer = organizer().Layer!;
      render(<WorkbenchShellContext.Provider value={{ registry } as never}>
        <ThreadStoreContext.Provider value={new ThreadStore()}><Layer actions={actions} /></ThreadStoreContext.Provider>
      </WorkbenchShellContext.Provider>);
    }
    const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".confirm-dialog button")].find((entry) => entry.textContent === name)!;

    it("asks before deleting by default, and deletes only once the user agrees", async () => {
      const { registry, organizer, actions, calls } = setup({ confirmations: true });
      await flush();
      renderLayer(registry, organizer, actions);
      organizer().sections([thread("a", 1), thread("b", 2)]);
      await act(async () => { organizer().runMenu(thread("a"), "delete", actions); await flush(); });
      expect(document.querySelector(".confirm-dialog h2")?.textContent).toBe("Delete “a”?");
      await act(async () => { fireEvent.click(button("Cancel")); await flush(); });
      expect(calls("remove")).toEqual([]);
      expect(document.querySelector(".confirm-dialog")).toBeNull();
      await act(async () => { organizer().runMenu(thread("a"), "delete", actions); await flush(); });
      await act(async () => { fireEvent.click(button("Delete")); await flush(); });
      expect(calls("remove")).toEqual([{ threadId: "a" }]);
    });

    it("asks once for a whole selection when archiving is set to ask", async () => {
      const { registry, organizer, actions, calls, preferences } = setup({ confirmations: true });
      await flush();
      preferences.setOption(THREAD_RAIL_EXTENSION_ID, "confirm-archive", true);
      renderLayer(registry, organizer, actions);
      const selected = [thread("a", 2), thread("c", 1)];
      organizer().sections(selected);
      await act(async () => { organizer().runBulkMenu!(selected, "archive", actions); await flush(); });
      expect(document.querySelectorAll(".confirm-dialog")).toHaveLength(1);
      expect(document.querySelector(".confirm-dialog h2")?.textContent).toBe("Archive 2 threads?");
      await act(async () => { fireEvent.click(button("Archive")); await flush(); await flush(); });
      expect(calls("archive")).toEqual([{ threadId: "a" }, { threadId: "c" }]);
    });

    it("unpins without a question by default, and stops asking after Don't ask again", async () => {
      const { registry, organizer, actions, calls, preferences } = setup({ confirmations: true, initial: { threads: { a: { pinned: true, pinOrder: 0 }, c: { pinned: true, pinOrder: 1 } } } });
      await flush();
      renderLayer(registry, organizer, actions);
      organizer().sections([thread("a"), thread("c")]);
      await act(async () => { organizer().runMenu(thread("a"), "unpin", actions); await flush(); });
      expect(document.querySelector(".confirm-dialog")).toBeNull();
      expect(calls("patch").at(-1)).toMatchObject({ patches: { a: { pinned: null } } });

      preferences.setOption(THREAD_RAIL_EXTENSION_ID, "confirm-unpin", true);
      await act(async () => { organizer().runMenu(thread("c"), "unpin", actions); await flush(); });
      expect(document.querySelector(".confirm-dialog h2")?.textContent).toBe("Unpin “c”?");
      const before = calls("patch").length;
      await act(async () => {
        fireEvent.click(document.querySelector<HTMLInputElement>(".confirm-dialog-skip input")!);
        fireEvent.click(button("Unpin"));
        await flush();
      });
      expect(calls("patch").length).toBe(before + 1);
      expect(preferences.optionValue(THREAD_RAIL_EXTENSION_ID, "confirm-unpin", true)).toBe(false);
    });

    it("lets the settings page switch each question", async () => {
      const { registry, preferences } = setup({ confirmations: true });
      await flush();
      const section = registry.getSettingsSections("threads").find((entry) => entry.id === "thread-rail.ask-first")!;
      expect(section.card).toBe("ask-first");
      const { getByRole } = render(<TestProviders preferences={preferences}><section.Component cwd="/project" onNotify={() => undefined} onChanged={() => undefined} /></TestProviders>);
      const archive = getByRole("switch", { name: "Before archiving a thread" });
      expect(archive.getAttribute("aria-checked")).toBe("false");
      expect(getByRole("switch", { name: "Before deleting a thread" }).getAttribute("aria-checked")).toBe("true");
      act(() => { fireEvent.click(archive); });
      expect(preferences.optionValue(THREAD_RAIL_EXTENSION_ID, "confirm-archive", false)).toBe(true);
      for (const row of section.rows ?? []) expect(document.getElementById(row.id), row.id).toBeTruthy();
    });

    it("settles after a quiet spell chosen from a menu", async () => {
      const { registry, preferences, calls } = setup({ confirmations: true });
      await flush();
      const section = registry.getSettingsSections("threads").find((entry) => entry.id === "thread-rail.rail")!;
      expect(registry.settingsPageReplacedBy("thread-rail.settings")).toBe("threads");
      const { getByRole } = render(<TestProviders preferences={preferences}><section.Component cwd="/project" onNotify={() => undefined} onChanged={() => undefined} /></TestProviders>);
      const menu = getByRole("combobox", { name: "Settle after a quiet spell" }) as HTMLSelectElement;
      expect([...menu.options].map((option) => option.textContent)).toEqual(["Off", "1 day", "3 days", "7 days", "30 days"]);
      await act(async () => { fireEvent.change(menu, { target: { value: "7" } }); await flush(); });
      expect(calls("settings").at(-1)).toEqual({ inactiveDays: 7 });
      await act(async () => { fireEvent.change(menu, { target: { value: "off" } }); await flush(); });
      expect(calls("settings").at(-1)).toEqual({ inactiveDays: null });
    });
  });
});

describe("parking the thread on screen", () => {
  const settled = (sections: ReturnType<RailOrganizer["sections"]>) => sections.find((section) => section.id === "settled")!.threads.map((entry) => entry.id);
  const opened = (actions: WorkbenchActions) => vi.mocked(actions.switchSession).mock.calls.map((call) => call[0]);
  const onScreen = (actions: WorkbenchActions, sessionId: string, extra: object = {}) =>
    vi.mocked(actions.activeThread).mockImplementation(() => ({ sessionId, draftPending: false, ...extra }));
  function renderLayer(registry: ReturnType<typeof setup>["registry"], organizer: () => RailOrganizer, actions: WorkbenchActions) {
    const Layer = organizer().Layer!;
    render(<ClientStorageProvider storage={createMemoryStorage()}><WorkbenchShellContext.Provider value={{ registry } as never}>
      <ThreadStoreContext.Provider value={new ThreadStore()}><Layer actions={actions} /></ThreadStoreContext.Provider>
    </WorkbenchShellContext.Provider></ClientStorageProvider>);
  }

  it("opens the next active thread once the host has the settle, from the row menu and the shortcut", async () => {
    const { organizer, actions, registry } = setup();
    await flush();
    const threads = [thread("a", 4), thread("b", 3), thread("c", 2), thread("d", 1)];
    organizer().sections(threads);
    organizer().runMenu(thread("b"), "settle", actions);
    expect(actions.switchSession).not.toHaveBeenCalled();
    await flush();
    expect(opened(actions)).toEqual(["/sessions/c.jsonl"]);

    onScreen(actions, "c");
    organizer().sections(threads);
    await registry.executeCommand("thread.settle", actions);
    await flush();
    expect(opened(actions)).toEqual(["/sessions/c.jsonl", "/sessions/d.jsonl"]);
    expect(settled(organizer().sections(threads)).sort()).toEqual(["b", "c"]);
  });

  it("wraps round to the top of the rail, pinned threads first, past threads already parked", async () => {
    const { organizer, actions, push } = setup();
    await flush();
    push({ threads: { p: { pinned: true, pinOrder: 0 }, z: { snoozedUntil: Date.now() + 60_000 } }, settings: { onMerged: true, onClosed: false } });
    onScreen(actions, "c");
    organizer().sections([thread("p", 9), thread("a", 3), thread("z", 2), thread("c", 1)]);
    organizer().runMenu(thread("c"), "snooze:1h", actions);
    await flush();
    expect(opened(actions)).toEqual(["/sessions/p.jsonl"]);
  });

  it("opens a new draft in the thread's project when no active thread is left", async () => {
    const { organizer, actions, registry } = setup();
    await flush();
    renderLayer(registry, organizer, actions);
    organizer().sections([thread("b")]);
    // The row's settle button, which hands over no actions of its own.
    organizer().toggleSettled(thread("b"));
    await act(flush);
    expect(actions.switchSession).not.toHaveBeenCalled();
    expect(actions.newSession).toHaveBeenCalledWith({ workspace: "/project" });
  });

  it("skips every thread settled with it, and moves nobody for a thread elsewhere", async () => {
    const { organizer, actions } = setup();
    await flush();
    const threads = [thread("a", 4), thread("b", 3), thread("c", 2), thread("d", 1)];
    organizer().sections(threads);
    organizer().runMenu(thread("a"), "settle", actions);
    await flush();
    expect(actions.switchSession).not.toHaveBeenCalled();
    organizer().sections(threads);
    organizer().runBulkMenu!([thread("b", 3), thread("c", 2)], "settle", actions);
    await flush();
    expect(opened(actions)).toEqual(["/sessions/d.jsonl"]);
  });

  it("moves on after a drop on the settled shelf and after the snooze dialog", async () => {
    const { organizer, actions, registry } = setup();
    await flush();
    renderLayer(registry, organizer, actions);
    organizer().sections([thread("a", 3), thread("b", 2), thread("c", 1)]);
    await act(async () => { organizer().drop(thread("b").id, { sectionId: "settled" }); await flush(); });
    expect(opened(actions)).toEqual(["/sessions/c.jsonl"]);

    onScreen(actions, "c");
    organizer().sections([thread("a", 3), thread("b", 2), thread("c", 1)]);
    await act(async () => { await registry.executeCommand("thread.snooze", actions); });
    const snooze = await waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>(".thread-rail-snooze footer button")].find((entry) => entry.textContent === "Snooze");
      expect(button?.disabled).toBe(false);
      return button!;
    });
    await act(async () => { fireEvent.click(snooze); await flush(); });
    expect(opened(actions)).toEqual(["/sessions/c.jsonl", "/sessions/a.jsonl"]);
  });

  it("moves on for core's own Settle, which reaches the rail through the preferences", async () => {
    const { organizer, actions, registry, preferences } = setup();
    await flush();
    renderLayer(registry, organizer, actions);
    organizer().sections([thread("a", 2), thread("b", 1)]);
    act(() => preferences.toggleSettled("b"));
    await act(flush);
    expect(opened(actions)).toEqual(["/sessions/a.jsonl"]);
  });

  it("follows the list core draws on a compact client", async () => {
    const { organizer, actions } = setup();
    await flush();
    organizer().sections([thread("a", 3), thread("b", 2), thread("c", 1)]);
    actions.threadListOrder = () => ["c", "b", "a"];
    organizer().runMenu(thread("b"), "settle", actions);
    await flush();
    expect(opened(actions)).toEqual(["/sessions/a.jsonl"]);
  });

  it("goes back to a phone's thread list instead of opening another thread", async () => {
    const { organizer, actions } = setup();
    await flush();
    organizer().sections([thread("a", 3), thread("b", 2), thread("c", 1)]);
    actions.threadListOrder = () => ["a", "b", "c"];
    const showThreadList = vi.fn(() => true);
    actions.showThreadList = showThreadList;
    organizer().runMenu(thread("b"), "settle", actions);
    await flush();
    expect(showThreadList).toHaveBeenCalledTimes(1);
    expect(opened(actions)).toEqual([]);
    expect(actions.newSession).not.toHaveBeenCalled();
  });

  it("skips threads in the Working section, which do not need the reader", async () => {
    const { organizer, actions } = setup({ initial: { threads: {}, settings: { onMerged: true, onClosed: false, workingSection: true } } });
    await flush();
    organizer().sections([thread("a", 3), thread("b", 2), thread("c", 1)], { runningThreadIds: ["c"], waitingThreadIds: [], failedThreadIds: [] });
    organizer().runMenu(thread("b"), "settle", actions);
    await flush();
    expect(opened(actions)).toEqual(["/sessions/a.jsonl"]);
  });

  it("goes to the top of a compact list that leaves the Working thread on screen out", async () => {
    const { organizer, actions } = setup();
    await flush();
    organizer().sections([thread("a", 3), thread("b", 2), thread("c", 1)]);
    actions.threadListOrder = () => ["c", "a"];
    organizer().runMenu(thread("b"), "settle", actions);
    await flush();
    expect(opened(actions)).toEqual(["/sessions/c.jsonl"]);
  });

  it("stays when something covers the thread, when the reader moved first, or when the host refused", async () => {
    const { organizer, actions, invoke, push } = setup();
    await flush();
    const threads = [thread("a", 3), thread("b", 2), thread("c", 1)];
    onScreen(actions, "b", { covered: true });
    organizer().sections(threads);
    organizer().runMenu(thread("b"), "settle", actions);
    await flush();

    onScreen(actions, "c");
    organizer().sections(threads);
    organizer().runMenu(thread("c"), "snooze:1h", actions);
    onScreen(actions, "a");
    await flush();

    onScreen(actions, "a");
    organizer().sections(threads);
    invoke.mockRejectedValueOnce(new Error("offline"));
    organizer().runMenu(thread("a"), "settle", actions);
    await flush();
    await flush();
    expect(actions.switchSession).not.toHaveBeenCalled();
    expect(actions.newSession).not.toHaveBeenCalled();

    // The host's own settles (a quiet spell, a merged pull request) never move anyone.
    onScreen(actions, "b");
    push({ threads: { b: { settledAt: 9, settledBy: "inactive" } }, settings: { onMerged: true, onClosed: false } });
    await flush();
    expect(actions.switchSession).not.toHaveBeenCalled();
  });

  it("stays on the thread when it is un-settled or woken", async () => {
    const { organizer, actions, push } = setup();
    await flush();
    push({ threads: { b: { settledAt: 1, settledBy: "user" }, z: { snoozedUntil: Date.now() + 60_000 } }, settings: { onMerged: true, onClosed: false } });
    organizer().sections([thread("a"), thread("b"), thread("z")]);
    organizer().runMenu(thread("b"), "unsettle", actions);
    onScreen(actions, "z");
    organizer().runMenu(thread("z"), "wake", actions);
    await flush();
    expect(actions.switchSession).not.toHaveBeenCalled();
    expect(actions.newSession).not.toHaveBeenCalled();
  });
});


describe("Working transitions", () => {
  it("folds running and monitoring threads and brings a returning one to the top without changing saved placement", async () => {
    let clock = Date.now();
    const time = vi.spyOn(Date, "now").mockImplementation(() => clock += 1_000);
    onTestFinished(() => time.mockRestore());
    const { organizer, current } = setup({ initial: { threads: { a: { order: 1 }, b: { order: 2 } }, settings: { onMerged: true, onClosed: false, workingSection: true } } });
    await flush();
    const threads = [thread("a", 1), thread("b", 2)];
    const sections = (running: string[], waiting: string[] = [], failed: string[] = [], background: string[] = []) =>
      organizer().sections(threads, { runningThreadIds: running, waitingThreadIds: waiting, failedThreadIds: failed, backgroundThreadIds: background });
    const ids = (list: ReturnType<typeof sections>, section: string) => list.find((entry) => entry.id === section)?.threads.map((entry) => entry.id);
    // Ordered by when each thread came back, not by the saved ranks.
    expect(ids(sections([]), "active")).toEqual(["b", "a"]);
    expect(ids(sections(["a"]), "working")).toEqual(["a"]);
    // A question takes it out of Working, onto the top.
    expect(ids(sections(["a"], ["a"]), "active")).toEqual(["a", "b"]);
    expect(ids(sections(["a"]), "working")).toEqual(["a"]);
    expect(ids(sections(["a"], [], ["a"]), "active")).toEqual(["a", "b"]);
    expect(ids(sections(["b"]), "working")).toEqual(["b"]);
    expect(ids(sections([]), "active")).toEqual(["b", "a"]);
    // Background work that wakes the thread keeps it in Working.
    expect(ids(sections([], [], [], ["a"]), "working")).toEqual(["a"]);
    expect(organizer().dropLabel("b", { sectionId: "active" })).toBeUndefined();
    expect(organizer().dropLabel("b", { sectionId: "pinned" })).toBe("Pin");
    expect(organizer().menu(thread("b")).flatMap((section) => section.items).some((item) => item.id === "move")).toBe(false);
    expect(current().threads).toEqual({ a: { order: 1 }, b: { order: 2 } });
  });
});
