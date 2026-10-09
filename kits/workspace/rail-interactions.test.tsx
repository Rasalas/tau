// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopExtension, UiSession } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { runPaletteCommand } from "../../src/renderer/test-support/palette.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { installPointerEvents } from "../../src/renderer/test-support/pointer-events.js";
import { workspaceExtension } from "./desktop.js";
import { navigationRowsFor } from "./navigation.js";
import { WORKSPACE_STORE_SERVICE, type ThreadRailOrganizer, type WorkspaceStoreApi } from "./protocol.js";
import type { WorkspaceStore } from "./store.js";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

const shell = (id: string, index: number, patch: Partial<UiSession> = {}): UiSession => ({
  id, path: `/sessions/${id}.jsonl`, title: `Thread ${id}`, modifiedAt: 100 - index, projectPath: "/project", projectName: "project", messageCount: 1, ...patch,
});

/** One labelled section, so jsdom draws every row without the virtual list. */
async function renderRail(sessions: UiSession[], overrides: Partial<ThreadRailOrganizer> = {}) {
  const organizer: ThreadRailOrganizer = {
    subscribe: () => () => undefined,
    getVersion: () => 1,
    sections: (threads) => [{ id: "pinned", label: "Pinned", threads: [...threads] }, { id: "active", threads: [] }],
    menu: (session) => [{ items: [{ id: "pin", label: `Pin ${session.title}` }] }],
    runMenu: vi.fn(),
    toggleSettled: () => undefined,
    dropLabel: () => undefined,
    drop: () => undefined,
    bulkMenu: (selected) => [{ items: [{ id: "settle", label: `Settle (${selected.length})` }] }],
    runBulkMenu: vi.fn(),
    ...overrides,
  };
  let workspace: WorkspaceStore | undefined;
  const organizing: DesktopExtension = {
    id: "test.organizer",
    name: "Organizer",
    activate: (context) => context.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (store) => {
      workspace = store as WorkspaceStore;
      return store.registerThreadRailOrganizer(organizer);
    }),
  };
  // Switching answers with the thread's detail, so the thread is on screen afterwards.
  const switchSession = vi.fn(async (path: string) => {
    const id = sessions.find((session) => session.path === path)?.id ?? sessions[0]!.id;
    return {
      version: 1 as const,
      updates: [
        { version: 1 as const, type: "thread-detail" as const, detail: { sessionId: id, messages: [], isStreaming: false, activeTools: [] } },
        { version: 1 as const, type: "catalog" as const, catalog: { sessionId: id, models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true } },
      ],
    };
  });
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }, { path: "/other", name: "other", lastOpenedAt: 2 }], sessions },
      detail: { sessionId: sessions[0]!.id, messages: [], isStreaming: false, activeTools: [] },
      catalog: { sessionId: sessions[0]!.id, models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
      project: { cwd: "/project" },
    }),
    invokeHostExtension: workspaceHostStub(),
    switchSession,
  });
  const view = renderApp(client, { extensions: [workspaceExtension, organizing] });
  await screen.findByText(`Thread ${sessions.at(-1)!.id}`);
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-rail-thread="${id}"]`)!;
  const main = (id: string) => row(id).querySelector<HTMLButtonElement>(".thread-main")!;
  return { organizer, workspace: workspace!, view, row, main, switchSession };
}

const selectedIds = () => [...document.querySelectorAll<HTMLElement>(".rail-row.selected")].map((element) => element.dataset.railThread);

describe("rail selection", () => {
  const threads = ["a", "b", "c", "d"].map((id, index) => shell(id, index));

  it("offers Settle and Snooze from the row without opening the thread", async () => {
    const { row, organizer, switchSession } = await renderRail(threads, {
      rowActions: () => [{ id: "snooze", label: "Snooze thread", icon: <span>clock</span>, menu: () => [{ items: [{ id: "snooze:1h", label: "In 1 hour" }] }] }],
    });
    fireEvent.click(within(row("b")).getByRole("button", { name: "Settle Thread b" }));
    expect(organizer.runMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }), "settle", expect.anything());
    fireEvent.click(within(row("b")).getByRole("button", { name: "Snooze thread" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "In 1 hour" }));
    await waitFor(() => expect(organizer.runMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }), "snooze:1h", expect.anything()));
    expect(switchSession).not.toHaveBeenCalled();
  });

  it("picks rows with mod-click and runs of rows with shift-click, and a plain click ends it", async () => {
    const { main, switchSession } = await renderRail(threads);
    fireEvent.click(main("b"), { metaKey: true });
    fireEvent.click(main("d"), { ctrlKey: true });
    expect(selectedIds()).toEqual(["b", "d"]);
    // A shift-click spans from the last row picked.
    fireEvent.click(main("c"), { shiftKey: true });
    expect(selectedIds()).toEqual(["c", "d"]);
    expect(document.querySelector(".rail-selection-bar")?.textContent).toContain("2 selected");
    expect(switchSession).not.toHaveBeenCalled();
    fireEvent.click(main("a"));
    expect(selectedIds()).toEqual([]);
    await waitFor(() => expect(switchSession).toHaveBeenCalled());
  });

  it("gives a selection the organizer's bulk menu, and a row outside it its own menu", async () => {
    const { main, organizer, row } = await renderRail(threads);
    fireEvent.click(main("a"), { metaKey: true });
    fireEvent.click(main("c"), { metaKey: true });
    fireEvent.contextMenu(row("c"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Settle (2)" }));
    await waitFor(() => expect(organizer.runBulkMenu).toHaveBeenCalledWith([expect.objectContaining({ id: "a" }), expect.objectContaining({ id: "c" })], "settle", expect.anything()));
    // The run starts before the render that ends the selection.
    await waitFor(() => expect(selectedIds()).toEqual([]));

    fireEvent.click(main("a"), { metaKey: true });
    fireEvent.click(main("b"), { metaKey: true });
    fireEvent.contextMenu(row("d"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin Thread d" }));
    await waitFor(() => expect(organizer.runMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "d" }), "pin", expect.anything()));
    expect(selectedIds()).toEqual([]);
  });

  it("grows the selection with shift and the arrows, and Escape clears it", async () => {
    await renderRail(threads);
    const list = screen.getByRole("navigation", { name: "Threads" });
    list.focus();
    fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    expect(selectedIds()).toEqual(["a", "b", "c"]);
    expect(document.querySelector("[data-cursor]")?.getAttribute("data-rail-thread")).toBe("c");
    fireEvent.keyDown(list, { key: "Escape" });
    expect(selectedIds()).toEqual([]);
  });

  it("starts a keyboard run where plain arrows left the cursor", async () => {
    await renderRail(threads);
    const list = screen.getByRole("navigation", { name: "Threads" });
    list.focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    expect(selectedIds()).toEqual(["c", "d"]);
  });

  it("ends the selection when the project filter changes", async () => {
    const { main, workspace } = await renderRail(threads);
    fireEvent.click(main("a"), { metaKey: true });
    fireEvent.click(main("b"), { metaKey: true });
    act(() => workspace.setRailProjectFilter("project"));
    expect(selectedIds()).toEqual([]);
  });
});

describe("the rest of the rail", () => {
  it("opens the thread files are dropped on and hands them to its composer", async () => {
    const { row, switchSession } = await renderRail([shell("a", 0), shell("b", 1)]);
    const image = new File([new Uint8Array([137, 80, 78, 71])], "dropped.png", { type: "image/png" });
    const dataTransfer = { types: ["Files"], files: [image], dropEffect: "none" };
    fireEvent.dragOver(row("b").querySelector(".thread-title")!, { dataTransfer });
    expect(row("b").classList.contains("file-drop")).toBe(true);
    fireEvent.drop(row("b").querySelector(".thread-title")!, { dataTransfer });
    expect(row("b").classList.contains("file-drop")).toBe(false);
    await waitFor(() => expect(switchSession).toHaveBeenCalledWith("/sessions/b.jsonl"));
    expect(await screen.findByRole("button", { name: "Preview dropped.png" })).toBeTruthy();
  });

  it("shows only the filtered project's threads and says which one it is", async () => {
    const { workspace } = await renderRail([shell("a", 0), shell("b", 1, { projectPath: "/other", projectName: "other" })]);
    act(() => workspace.setRailProjectFilter("other"));
    expect(screen.queryByText("Thread a")).toBeNull();
    expect(screen.getByText("Thread b")).toBeTruthy();
    // The filter heads the rail beside search and "+", and names what the list shows.
    const filter = screen.getByRole("button", { name: "Filter threads by project: other" });
    expect(filter.textContent).toMatch(/other$/u);
    const head = within(filter.closest(".rail-head") as HTMLElement);
    expect(head.getByRole("button", { name: "Search" })).toBeTruthy();
    expect(head.getByRole("button", { name: "New thread" })).toBeTruthy();
    expect(document.querySelector(".project-scope-row")).toBeNull();
    fireEvent.click(filter);
    const list = await screen.findByRole("dialog", { name: "Filter by project" });
    fireEvent.click(within(list).getByText("All projects"));
    expect(screen.getByText("Thread a")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Filter threads by project" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Filter by project" })).getByText("other"));
    expect(workspace.getSnapshot().railProjectFilter).toBe("other");
    expect(screen.queryByText("Thread a")).toBeNull();
  });

  it("hides the sidebar from its head and shows it again from the title bar", async () => {
    await renderRail([shell("a", 0)]);
    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    // A closed rail stays mounted, hidden by the shell's class.
    await waitFor(() => expect(document.querySelector(".app-shell.sidebar-closed")).toBeTruthy());
    // Search and "+" come along, so neither needs the sidebar.
    const controls = within(document.querySelector(".sidebar-closed-controls") as HTMLElement);
    expect(controls.getByRole("button", { name: "Search" })).toBeTruthy();
    expect(controls.getByRole("button", { name: "New thread" })).toBeTruthy();
    fireEvent.click(controls.getByRole("button", { name: "Show sidebar" }));
    await waitFor(() => expect(document.querySelector(".app-shell.sidebar-closed")).toBeNull());
    expect(document.querySelector(".sidebar-closed-controls")).toBeNull();
  });

  it("lists each project with the rail's thread count and its path, and manages projects in Settings", async () => {
    await renderRail([
      shell("a", 0),
      shell("c", 2, { messageCount: 0 }),
      shell("d", 3, { parentThreadId: "a" }),
      shell("b", 1, { projectPath: "/other", projectName: "other" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Filter threads by project" }));
    const list = await screen.findByRole("dialog", { name: "Filter by project" });
    expect(within(list).getByText("Show threads from")).toBeTruthy();
    // A draft and an agent's thread are not in the rail, so they are not counted.
    const detail = (name: string) => within(list).getByRole("option", { name }).querySelector("small")?.textContent;
    expect(detail("All projects")).toBe("2 threads");
    expect(detail("project")).toBe("1 thread ·\u00a0/project");
    await waitFor(() => expect(document.activeElement).toBe(within(list).getByRole("textbox", { name: "Search projects" })));
    expect(within(list).getByRole("button", { name: /Open a project…/ }).querySelector("kbd")).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "Manage projects" }));
    expect(screen.queryByRole("dialog", { name: "Filter by project" })).toBeNull();
    expect((await screen.findAllByRole("heading", { name: "Source control" })).length).toBeGreaterThan(0);
  });

  it("puts the last turn's changes on the row and the details on its hover card", async () => {
    const { workspace, row } = await renderRail([shell("a", 0, { projectLabel: "feature/very-long-branch-name-20260923" })]);
    act(() => workspace.recordTurnStat("a", { added: 12, removed: 3, files: 2, at: 5 }));
    expect(row("a").querySelector(".thread-diff-stat")?.textContent).toBe("+12 −3");
    const main = row("a").querySelector<HTMLElement>(".thread-main")!;
    expect(main.getAttribute("data-tooltip")).toBeNull();
    act(() => { fireEvent.keyDown(document.body, { key: "Tab" }); main.focus(); });
    const card = await screen.findByRole("dialog", { name: "Thread details" });
    expect(card.textContent).toContain("Thread a");
    expect(card.querySelector(".thread-card-rows")!.textContent).toContain("project");
    expect(card.textContent).toContain("Last turn +12 −3 in 2 files");
    // The branch keeps its end: the head ellipsizes, the tail stays.
    const branch = row("a").querySelector(".thread-branch > span")!;
    expect(branch.children).toHaveLength(2);
    expect(branch.lastElementChild!.textContent).toBe("e-20260923");
  });

  it("opens the thread's Project settings from the command palette", async () => {
    await renderRail([shell("a", 0)]);
    await runPaletteCommand("Project settings");
    const dialog = await screen.findByRole("dialog", { name: "Project settings" });
    expect(within(dialog).getByText("/project")).toBeTruthy();
  });

  it("opens Project settings and shows the chosen icon on the row", async () => {
    const { workspace, row, view } = await renderRail([shell("a", 0)]);
    act(() => workspace.openProjectSettings({ projectPath: "/project", projectName: "project" }));
    const dialog = await screen.findByRole("dialog", { name: "Project settings" });
    fireEvent.click(screen.getByRole("button", { name: "Emoji" }));
    fireEvent.click(screen.getByRole("button", { name: "🚀" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(dialog.isConnected).toBe(false);
    const image = row("a").querySelector<HTMLImageElement>(".thread-project-icon img");
    expect(decodeURIComponent(image?.src ?? "")).toContain("🚀");
    expect(view.services.preferences.value("tau.workspace", "project-icon:/project")).toContain("\"kind\":\"emoji\"");
  });
});

describe("dragging a thread onto another kit's target (design 2f)", () => {
  const threads = ["a", "b"].map((id, index) => shell(id, index));

  it("lifts the row, lists the targets at the rail's foot, and hands the thread to the one it is let go on", async () => {
    installPointerEvents();
    const { workspace, main } = await renderRail(threads);
    const drop = vi.fn();
    act(() => { workspace.registerThreadDropTargets({
      heading: "Drop to move the thread",
      targets: (thread) => [
        { id: "here", label: "This Mac", detail: `${thread.title} is here already`, disabled: true },
        { id: "rex", label: "rex", detail: "online · idle" },
      ],
      drop,
    }); });
    let under: Element | null = null;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => under });
    try {
      fireEvent.pointerDown(main("a"), { button: 0, clientX: 20, clientY: 20 });
      fireEvent.pointerMove(window, { clientX: 20, clientY: 60 });
      const panel = await screen.findByRole("group", { name: "Drop to move the thread" });
      expect(within(panel).getByText("Thread a is here already").closest(".rail-drop-target")?.hasAttribute("data-rail-drop")).toBe(false);
      expect(document.querySelector(".rail-drag-card")?.textContent).toContain("Thread a");

      under = within(panel).getByText("rex");
      fireEvent.pointerMove(window, { clientX: 30, clientY: 300 });
      await waitFor(() => expect(within(panel).getByText("rex").closest(".rail-drop-target")?.className).toContain("over"));
      fireEvent.pointerUp(window);

      expect(drop).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "rex", expect.anything());
      await waitFor(() => expect(screen.queryByRole("group", { name: "Drop to move the thread" })).toBeNull());
    } finally {
      Reflect.deleteProperty(document, "elementFromPoint");
    }
  });
});

describe("navigationRowsFor", () => {
  const order = { grouping: "repository" as const, projectSort: "activity" as const, preview: 2 };
  const threads = [shell("a", 0), shell("b", 1, { projectName: "other" }), shell("c", 2), shell("d", 3)];

  it("draws group headings, the preview and a show-more row per group", () => {
    const rows = navigationRowsFor(threads, order, [], new Set());
    expect(rows.map((row) => row.kind === "more" ? `more:${row.remaining}` : row.kind === "group" ? `# ${row.label} ${row.count}` : row.id))
      .toEqual(["# project 3", "a", "c", "more:1", "# other 1", "b"]);
    expect(navigationRowsFor(threads, order, [], new Set(["repository:project"])).filter((row) => row.kind === "thread")).toHaveLength(4);
  });

  it("names each group's project, for its new-thread button", () => {
    const projects = [{ path: "/project", name: "project", lastOpenedAt: 1 }, { path: "/other", name: "other", lastOpenedAt: 1 }];
    const groups = navigationRowsFor([shell("a", 0), shell("b", 1, { projectPath: "/other", projectName: "other" })], order, projects, new Set())
      .flatMap((row) => row.kind === "group" ? [`${row.label}:${row.project?.path}`] : []);
    expect(groups).toEqual(["project:/project", "other:/other"]);
  });

  it("is flat without grouping", () => {
    expect(navigationRowsFor(threads, { ...order, grouping: "none" }, [], new Set()).map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
  });
});
