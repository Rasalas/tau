// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientStorage, DesktopExtension, UiSession } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { createMemoryStorage, setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { workspaceExtension } from "./desktop.js";
import { GROUPS_OPEN_KEY } from "./rail-navigation.js";
import { SHELVES_OPEN_KEY } from "./rail-shelves.js";
import { WORKSPACE_STORE_SERVICE, type ThreadRailOrganizer, type WorkspaceStoreApi } from "./protocol.js";
import type { WorkspaceStore } from "./store.js";

// The virtualizer may take any number of commits to mount a requested row.
// Keep its viewport separate from the full model, and release it explicitly in tests.
const viewport = vi.hoisted(() => ({ indices: undefined as number[] | undefined, version: 0, listeners: new Set<() => void>(), scroll: vi.fn(), measure: vi.fn() }));
vi.mock("@tanstack/react-virtual", async () => {
  const { useSyncExternalStore } = await import("react");
  return { useVirtualizer: (options: { count: number; estimateSize(index: number): number; scrollMargin?: number }) => {
    useSyncExternalStore((listener) => { viewport.listeners.add(listener); return () => { viewport.listeners.delete(listener); }; }, () => viewport.version);
    const indices = viewport.indices ?? Array.from({ length: options.count }, (_, index) => index);
    return {
      getVirtualItems: () => indices.filter((index) => index < options.count).map((index) => ({ index, start: (options.scrollMargin ?? 0) + Array.from({ length: index }, (_, i) => options.estimateSize(i)).reduce((a, b) => a + b, 0) })),
      getTotalSize: () => Array.from({ length: options.count }, (_, index) => options.estimateSize(index)).reduce((a, b) => a + b, 0),
      scrollToIndex: viewport.scroll,
      measureElement: viewport.measure,
    };
  } };
});

beforeEach(() => { viewport.indices = undefined; viewport.version = 0; viewport.scroll.mockClear(); viewport.measure.mockClear(); });
afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });
const mount = (indices: number[]) => act(() => { viewport.indices = indices; viewport.version++; for (const listener of viewport.listeners) listener(); });
const thread = (id: string, projectName = "alpha", modifiedAt = 100): UiSession => ({ id, title: `Thread ${id}`, path: `/${id}.jsonl`, projectPath: `/${projectName}`, projectName, modifiedAt, messageCount: 1 });
const sessions = [thread("a"), thread("a2", "alpha", 99), thread("b", "beta", 98), thread("p", "pinned", 97)];
const projects = ["alpha", "beta", "pinned"].map((name) => ({ name, path: `/${name}`, lastOpenedAt: 1 }));

async function start(options: { sessions?: UiSession[]; storage?: ClientStorage; shelf?: boolean; grouped?: boolean } = {}) {
  const listed = options.sessions ?? sessions;
  const organizer: ThreadRailOrganizer = {
    subscribe: () => () => undefined, getVersion: () => 1,
    sections: (threads) => [
      { id: "pinned", label: "Pinned", threads: threads.filter((entry) => entry.id === "p") },
      { id: "active", threads: threads.filter((entry) => entry.id !== "p" && entry.id !== "done") },
      ...(options.shelf ? [{ id: "settled", label: "Settled", shelf: true, collapsed: true, settled: true, threads: [thread("done")] }] : []),
    ],
    menu: () => [], runMenu: vi.fn(), toggleSettled: vi.fn(), dropLabel: () => undefined, drop: () => undefined,
    rowActions: () => [{ id: "snooze", label: "Snooze thread", icon: <span>clock</span>, menu: () => [] }],
  };
  let workspace: WorkspaceStore | undefined;
  const organizing: DesktopExtension = { id: "test.organizer", name: "Organizer", activate: (context) => context.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (store) => {
    workspace = store as WorkspaceStore; return store.registerThreadRailOrganizer(organizer);
  }) };
  const switchSession = vi.fn(async () => ({ version: 1 as const, updates: [] }));
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects, sessions: [...listed, ...(options.shelf ? [thread("done")] : [])] },
      detail: { sessionId: listed[0]!.id, messages: [], isStreaming: false, activeTools: [] },
      catalog: { sessionId: listed[0]!.id, models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
      project: { cwd: "/alpha" },
    }),
    invokeHostExtension: workspaceHostStub(), switchSession,
  });
  const view = renderApp(client, { storage: options.storage, extensions: [workspaceExtension, organizing], seed: ({ preferences }) => {
    preferences.setValue("tau.workspace", "rail-grouping", options.grouped === false ? "none" : "repository");
    preferences.setValue("tau.workspace", "rail-preview", "1");
    preferences.setValue("tau.workspace", "rail-project-sort", "name");
  } });
  await within(await screen.findByRole("navigation", { name: "Threads" })).findByRole("button", { name: /Active/ });
  await waitFor(() => expect(workspace).toBeDefined());
  if (listed.some((entry) => entry.id === "p")) await within(rail()).findByRole("button", { name: /^Pinned/ });
  return { view, client, switchSession, workspace: workspace!, storage: view.storage };
}
const rail = () => screen.getByRole("navigation", { name: "Threads" });
const heading = (id: string) => rail().querySelector<HTMLButtonElement>(`button[data-rail-heading="${id}"], button[data-rail-group="${id}"]`)!;
const main = (id: string) => rail().querySelector<HTMLButtonElement>(`[data-rail-thread="${id}"] .thread-main`)!;
const focus = (element: HTMLElement) => act(() => element.focus());
const key = (pressed: string, extra: Record<string, unknown> = {}) => fireEvent.keyDown(document.activeElement ?? rail(), { key: pressed, ...extra });
const cursorStops = () => [...rail().querySelectorAll<HTMLElement>('[tabindex="0"]')].filter((element) => !element.closest(".thread-row-actions") && !element.matches(".thread-group-new"));

it("walks headings, threads and More as one list, exposes only the cursor's actions, and opens only on Enter/Space", async () => {
  const { switchSession } = await start();
  focus(main("a"));
  expect(cursorStops()).toEqual([main("a")]);
  key("Home"); expect(document.activeElement).toBe(heading("pinned"));
  key("ArrowDown"); expect(document.activeElement).toBe(main("p"));
  key("ArrowDown"); expect(document.activeElement).toBe(heading("active"));
  key("ArrowRight"); expect(document.activeElement).toBe(heading("group:repository:alpha"));
  key("ArrowRight"); expect(document.activeElement).toBe(main("a"));
  key("ArrowDown"); expect(document.activeElement?.textContent).toContain("Show 1 more");
  expect(cursorStops()).toEqual([document.activeElement]);
  key("ArrowDown"); expect(document.activeElement).toBe(heading("group:repository:beta"));
  key("End"); expect(document.activeElement).toBe(main("b"));
  const row = main("b").closest(".rail-row")!;
  expect(within(row as HTMLElement).getByRole("button", { name: "Snooze thread" }).tabIndex).toBe(0);
  expect(within(main("a").closest(".rail-row") as HTMLElement).getByRole("button", { name: "Snooze thread" }).tabIndex).toBe(-1);
  expect(switchSession).not.toHaveBeenCalled();
  expect(main("a").getAttribute("aria-current")).toBe("page");
  key("Enter"); await waitFor(() => expect(switchSession).toHaveBeenCalledWith("/b.jsonl"));
  key(" "); await waitFor(() => expect(switchSession).toHaveBeenCalledTimes(2));
  expect(viewport.measure).toHaveBeenCalledWith(expect.any(HTMLElement));
});

it("folds sections and projects with real buttons, preserves paging and shelf storage, and restores collapse choices after remount", async () => {
  const storage = createMemoryStorage();
  storage.set(SHELVES_OPEN_KEY, JSON.stringify({ settled: false }));
  const first = await start({ storage, shelf: true });
  focus(main("a")); key("ArrowLeft");
  expect(document.activeElement).toBe(heading("group:repository:alpha"));
  key("ArrowLeft"); expect(heading("group:repository:alpha").getAttribute("aria-expanded")).toBe("false");
  expect(main("a")).toBeNull();
  key("ArrowLeft"); expect(document.activeElement).toBe(heading("active"));
  key("ArrowLeft"); expect(heading("active").getAttribute("aria-expanded")).toBe("false");
  expect(heading("group:repository:beta")).toBeNull();
  key("ArrowRight"); expect(heading("active").getAttribute("aria-expanded")).toBe("true");
  key("ArrowRight"); expect(document.activeElement).toBe(heading("group:repository:alpha"));
  key("ArrowRight"); expect(heading("group:repository:alpha").getAttribute("aria-expanded")).toBe("true");
  key("ArrowRight"); expect(document.activeElement).toBe(main("a"));
  key("ArrowDown"); key("Enter");
  expect(main("a2")).toBeTruthy();
  focus(heading("group:repository:alpha")); key("ArrowLeft"); key("ArrowRight");
  expect(main("a2")).toBeTruthy(); // Expanding a group keeps its already expanded preview.
  focus(heading("pinned")); key("ArrowLeft"); expect(main("p")).toBeNull();
  expect(JSON.parse(storage.get(GROUPS_OPEN_KEY)!)["section:pinned"]).toBe(false);
  expect(storage.get(SHELVES_OPEN_KEY)).toBe('{"settled":false}');
  expect(first.switchSession).not.toHaveBeenCalled();
  first.view.unmount();
  await start({ storage, shelf: true });
  expect(heading("pinned").getAttribute("aria-expanded")).toBe("false");
  expect(heading("settled").getAttribute("aria-expanded")).toBe("false");
  expect(main("p")).toBeNull();
});

it("returns to the correct unmounted project heading after several delayed virtual renders, with no thread selection", async () => {
  const { switchSession } = await start();
  focus(main("b"));
  mount([0, 4]); // beta's thread stays mounted, its heading is outside the viewport.
  key("ArrowLeft");
  expect(viewport.scroll).toHaveBeenLastCalledWith(3, { align: "auto" });
  expect(document.activeElement).toBe(rail());
  expect(rail().tabIndex).toBe(0);
  // No RAF deadline and no "nearest mounted heading" fallback.
  await act(async () => { for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame); });
  expect(document.activeElement).toBe(rail());
  expect(heading("group:repository:alpha").tabIndex).toBe(-1);
  mount([0, 3, 4]);
  expect(document.activeElement).toBe(heading("group:repository:beta"));
  expect(rail().tabIndex).toBe(-1);
  expect(cursorStops()).toEqual([heading("group:repository:beta")]);
  expect(switchSession).not.toHaveBeenCalled();
});

it("keeps a pending End tied to model identity and cancels it when the user leaves the list", async () => {
  await start();
  focus(main("a")); mount([0, 1]); key("End");
  expect(viewport.scroll).toHaveBeenLastCalledWith(4, { align: "auto" });
  expect(document.activeElement).toBe(rail());
  const search = screen.getByRole("button", { name: "Search" }); focus(search);
  mount([3, 4]);
  expect(document.activeElement).toBe(search);
  expect(cursorStops()).toEqual([main("b")]);
});

it("reconciles a pending row across filtering, keeps collapse state, and never changes the active thread", async () => {
  const { workspace, switchSession, storage } = await start();
  focus(main("b")); mount([0, 4]); key("ArrowLeft");
  act(() => workspace.setRailProjectFilter("alpha"));
  // The beta cursor vanished; the surviving Active parent owns focus, not an unrelated mounted project.
  expect(document.activeElement).toBe(heading("active"));
  mount([0, 1, 2]);
  expect(document.activeElement).toBe(heading("active"));
  expect(main("b")).toBeNull();
  focus(heading("group:repository:alpha")); key("ArrowLeft");
  act(() => workspace.setRailProjectFilter("beta"));
  act(() => workspace.setRailProjectFilter("alpha"));
  expect(heading("group:repository:alpha").getAttribute("aria-expanded")).toBe("false");
  expect(JSON.parse(storage.get(GROUPS_OPEN_KEY)!)["group:repository:alpha"]).toBe(false);
  expect(switchSession).not.toHaveBeenCalled();
});

describe("flat paging", () => {
  it("visits the existing 25-row More boundary without expanding or opening a thread on focus", async () => {
    const { switchSession } = await start({ grouped: false, sessions: Array.from({ length: 27 }, (_, index) => thread(`t${index}`, "alpha", 100 - index)) });
    const more = within(rail()).getByRole("button", { name: "Show 2 more" });
    focus(main("t0")); key("End"); expect(document.activeElement).toBe(more);
    expect(main("t25")).toBeNull();
    expect(switchSession).not.toHaveBeenCalled();
    key("Enter"); expect(main("t25")).toBeTruthy(); expect(main("t26")).toBeTruthy();
    expect(switchSession).not.toHaveBeenCalled();
  });
});

it("retains focus by identity after reorder, recovers after removal, and survives virtual unmount/remount", async () => {
  const { client, switchSession } = await start({ grouped: false });
  focus(main("b"));
  act(() => client.emit({ type: "thread-index", threadIndex: { projects, sessions: sessions.map((session) => ({ ...session, modifiedAt: session.id === "b" ? 999 : session.modifiedAt })) } }));
  expect(document.activeElement).toBe(main("b"));
  expect(cursorStops()).toEqual([main("b")]);
  mount([1]); // b moved to index zero; manual scrolling removes its focused DOM node.
  expect(document.activeElement).toBe(rail());
  const requests = viewport.scroll.mock.calls.length;
  mount([0, 1]);
  expect(document.activeElement).toBe(main("b"));
  expect(viewport.scroll).toHaveBeenCalledTimes(requests); // Remount never scrolls the viewport back.
  act(() => client.emit({ type: "thread-index", threadIndex: { projects, sessions: sessions.filter((session) => session.id !== "b") } }));
  expect(document.activeElement).toBe(heading("active"));
  expect(cursorStops()).toEqual([heading("active")]);
  expect(switchSession).not.toHaveBeenCalled();
});
