// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NewThreadClaimEvent, UiModel, UiSession, WorkbenchActions } from "tau";
import { createKitHarness, setHostClient, ThreadStore, ThreadStoreContext, WorkbenchShellContext } from "../../src/renderer/test-support/kit-harness.js";
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

function setup(options: { isRepo?: boolean; initial?: Partial<RailState>; confirmations?: boolean } = {}) {
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
  let railProjectFilter: string | undefined;
  const workspace: WorkspaceStoreSlice = {
    getSnapshot: () => ({ draftPending: true, workspace: { isRepo: options.isRepo ?? true }, ...(railProjectFilter ? { railProjectFilter } : {}) }),
    setRailProjectFilter: vi.fn((name: string | undefined) => { railProjectFilter = name; }),
    openProjectSettings: vi.fn(),
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
    expect(items.map((item) => item.id)).toEqual(["pin", "settle", "snooze", "rename", "mark-unread", "filter-project", "copy", "project-settings", "move-up", "move-down", "archive", "delete"]);
    const presets = items[2]!.submenu!.flatMap((section) => section.items.map((item) => item.id));
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
      expect(enabled).toEqual(["mark-unread", "filter-project", "copy", "project-settings"]);
      expect(items.find((item) => item.id === "archive")?.description).toMatch(/Read only/u);
      expect(organizer().rowActions?.(thread("a"))).toEqual([]);
      organizer().runMenu(thread("a"), "pin", actions);
      expect(calls("patch")).toEqual([]);
      expect(actions.notify).toHaveBeenCalledWith(expect.stringMatching(/Read only/u));
    } finally {
      setHostClient(undefined);
    }
  });

  it("offers the snooze clock on rows still in the rail, and runs its choice like the menu's", async () => {
    const { organizer, calls, actions, push } = setup();
    await flush();
    push({ threads: { d: { settledAt: 1, settledBy: "user" }, z: { snoozedUntil: Date.now() + 60_000 } }, settings: { onMerged: true, onClosed: false } });
    expect(organizer().rowActions!(thread("d"))).toEqual([]);
    expect(organizer().rowActions!(thread("z"))).toEqual([]);
    const [clock] = organizer().rowActions!(thread("a"));
    expect(clock?.label).toBe("Snooze thread");
    const sections = clock!.menu();
    expect(sections[0]!.items[0]).toMatchObject({ id: "snooze:1h", label: "In 1 hour", hint: expect.any(String) });
    expect(sections[1]!.items).toEqual([{ id: "snooze:custom", label: "Custom…" }]);
    organizer().runMenu(thread("a"), "snooze:1h", actions);
    expect(calls("patch").at(-1)).toMatchObject({ patches: { a: { snoozedUntil: expect.any(Number) } } });
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
    expect(registry.getKeybindings().some((binding) => binding.commandId === "thread.jump-1" && binding.keys === "mod+1" && binding.when === "!modelPickerOpen")).toBe(true);
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
    act(() => view.getByRole("button", { name: "Un-settle" }).click());
    expect(calls("patch").at(-1)).toEqual({ patches: { b: expect.objectContaining({ settledAt: null, settledBy: null }) } });
    expect(view.container.textContent).toBe("");
  });

  it("takes back a settle with the pin it cleared, and offers archive and delete in the title menu", async () => {
    const { registry, organizer, actions, calls, push } = setup();
    await flush();
    push({ threads: { p: { pinned: true, pinOrder: 0 } }, settings: { onMerged: true, onClosed: false } });
    organizer().runMenu(thread("p"), "settle", actions);
    await registry.executeCommand("thread.undo", actions);
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

  it("builds T3 Code's full row menu: a new thread on the branch, names, filter, copy and the project", async () => {
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
      ["New thread on feature/rail", "Pin thread", "Settle thread", "Snooze"],
      ["Rename thread", "Regenerate title", "Mark unread", "Filter by project"],
      ["Copy", "Project settings…"],
      ["Move up", "Move down"],
      ["Archive thread", "Delete"],
    ]);
    expect(sections[2]!.items[0]!.submenu![0]!.items.map((item) => item.label)).toEqual(["Path", "Branch", "Thread ID"]);
    // Without a branch there is nothing to start on or copy.
    const plain = organizer().menu(thread("a"));
    expect(plain[0]!.items[0]!.id).toBe("pin");
    expect(plain[2]!.items[0]!.submenu![0]!.items.map((item) => item.id)).toEqual(["copy-path", "copy-thread-id"]);
  });

  it("runs the row menu's new items against the workbench, Workspace Kit and Thread Titles", async () => {
    const { organizer, actions, workspace, registry } = setup();
    const regenerate = vi.fn(async () => undefined);
    registry.activate({ id: "tau.thread-titles", name: "Titles", activate: (context) => context.provideService("tau.thread-titles/titles", { regenerate }) });
    await flush();
    const branched = { ...thread("a"), projectLabel: "feature/rail", workspaceId: "ws-a" };
    organizer().runMenu(branched, "new-on-branch", actions);
    expect(actions.newSession).toHaveBeenCalledWith({ workspace: "ws-a" });
    organizer().runMenu(branched, "copy-branch", actions);
    organizer().runMenu(branched, "copy-thread-id", actions);
    organizer().runMenu(branched, "copy-path", actions);
    await flush();
    expect(vi.mocked(actions.copyText).mock.calls.map((call) => call[0])).toEqual(["feature/rail", "a", "/project"]);
    expect(actions.notify).toHaveBeenCalledWith("Branch copied.");
    organizer().runMenu(branched, "filter-project", actions);
    expect(workspace.setRailProjectFilter).toHaveBeenLastCalledWith("project");
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
      const page = registry.getSettingsPages().find((entry) => entry.id === "thread-rail.settings")!;
      const { getByRole } = render(<TestProviders preferences={preferences}><page.Component cwd="/project" onNotify={() => undefined} /></TestProviders>);
      expect(getByRole("heading", { level: 2, name: "Ask first" })).toBeTruthy();
      const archive = getByRole("switch", { name: "Before archiving a thread" });
      expect(archive.getAttribute("aria-checked")).toBe("false");
      expect(getByRole("switch", { name: "Before deleting a thread" }).getAttribute("aria-checked")).toBe("true");
      act(() => { fireEvent.click(archive); });
      expect(preferences.optionValue(THREAD_RAIL_EXTENSION_ID, "confirm-archive", false)).toBe(true);
    });
  });
});
