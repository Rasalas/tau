// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaletteSearchContext, UiProject, UiSession, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { createSearchExtension } from "./desktop.js";
import { SearchDialogs, SearchDialogsLayer, type SearchHost } from "./dialogs.js";
import { projectItems, threadContentItems, threadTitleItems } from "./palette-sources.js";
import { SEARCH_KIT_ID, WORKSPACE_STORE_SERVICE, type ContentSearchResult, type FileSearchResult, type WorkspaceStoreView } from "./protocol.js";

afterEach(cleanup);

const thread = (id: string, title: string, modifiedAt: number, projectName = "tau"): UiSession =>
  ({ id, path: `/sessions/${id}.jsonl`, title, modifiedAt, projectPath: "/repo", projectName, messageCount: 2 });

const projects: UiProject[] = [
  { path: "/repo", workspaceId: "ws-repo", displayPath: "~/repo", name: "tau", lastOpenedAt: 2 },
  { path: "/other", name: "t3code", lastOpenedAt: 3 },
];

function searchContext(actions = {} as WorkbenchActions): PaletteSearchContext {
  return {
    actions,
    index: { projects, threads: [thread("a", "Fix the stage tabs", 1), thread("b", "Stage restore", 5, "t3code"), thread("c", "Luna test", 3)], activeThreadId: "b" },
    signal: new AbortController().signal,
  };
}

describe("Search Kit: palette sources", () => {
  it("finds threads by title and project, newest first, and says which one is on screen", () => {
    const context = searchContext();
    expect(threadTitleItems("stage", context).map((item) => [item.label, item.detail])).toEqual([
      ["Stage restore", "t3code · on screen"],
      ["Fix the stage tabs", "tau"],
    ]);
    expect(threadTitleItems("stage tau", context).map((item) => item.id)).toEqual(["a"]);
    expect(threadTitleItems(" ", context)).toEqual([]);
  });

  it("switches to a thread and opens a project by its workspace id", async () => {
    const actions = { switchSession: vi.fn(async () => true), openWorkspace: vi.fn(async () => true) } as unknown as WorkbenchActions;
    const context = searchContext(actions);
    await threadTitleItems("luna", context)[0]!.run!(actions);
    expect(actions.switchSession).toHaveBeenCalledWith("/sessions/c.jsonl");
    const found = projectItems("t", context);
    expect(found.map((item) => item.label)).toEqual(["t3code", "tau"]);
    await found[1]!.run!(actions);
    expect(actions.openWorkspace).toHaveBeenCalledWith("ws-repo");
  });

  it("lists a thread the host found by its text once, and not when its title already matched", () => {
    const context = searchContext();
    const items = threadContentItems([
      { sessionId: "c", path: "/sessions/c.jsonl", role: "assistant", snippet: "…the moon is called Luna…" },
      { sessionId: "x", path: "/sessions/c.jsonl", role: "user", snippet: "again" },
      { sessionId: "a", path: "", role: "user", snippet: "tabs" },
      { sessionId: "gone", path: "/sessions/gone.jsonl", role: "user", snippet: "not in the index" },
    ], context, new Set(["a"]));
    expect(items.map((item) => [item.id, item.detail])).toEqual([["c", "…the moon is called Luna…"]]);
  });

  it("asks the host for thread text with the thread on screen, from the kit's own source", async () => {
    const invoke = vi.fn(async (_id: string, command: string) => command === "threads"
      ? [{ sessionId: "c", path: "/sessions/c.jsonl", role: "assistant", snippet: "moon" }]
      : undefined);
    const { registry } = createKitHarness(invoke);
    registry.activate(createSearchExtension({ threadContentDelayMs: 0 }));
    const source = registry.getPaletteSources().find((entry) => entry.id === "search.thread-content")!;
    expect(await source.search("mo", searchContext())).toEqual([]);
    const found = await source.search("moon", searchContext());
    expect(found.map((item) => item.label)).toEqual(["Luna test"]);
    expect(invoke).toHaveBeenCalledWith(SEARCH_KIT_ID, "threads", { query: "moon", limit: 12, activeSessionId: "b" });
    const aborted = new AbortController();
    aborted.abort();
    expect(await source.search("moon", { ...searchContext(), signal: aborted.signal })).toEqual([]);
  });

  it("binds ⇧⌘F and ⌘P and forgets the file list when Git reports a change", () => {
    const invoke = vi.fn(async () => undefined);
    const { registry } = createKitHarness(invoke);
    let listener: () => void = () => undefined;
    let state = { cwd: "/repo", changes: {} as unknown };
    const store: WorkspaceStoreView = { getSnapshot: () => state, subscribe: (next) => { listener = next; return () => undefined; } };
    registry.activate({ id: "fixture.workspace", name: "Workspace", activate: (context) => { context.provideService(WORKSPACE_STORE_SERVICE, store); } });
    registry.activate(createSearchExtension());
    expect(registry.getKeybindings().filter((binding) => binding.extensionId === SEARCH_KIT_ID).map((binding) => [binding.keys, binding.commandId])).toEqual([
      ["mod+shift+f", "search.content"],
      ["mod+p", "search.files"],
    ]);
    listener();
    expect(invoke).not.toHaveBeenCalled();
    state = { cwd: "/repo", changes: {} };
    listener();
    expect(invoke).toHaveBeenCalledWith(SEARCH_KIT_ID, "invalidate", { cwd: "/repo" });
  });
});

function dialogHarness(host: SearchHost) {
  const dialogs = new SearchDialogs();
  const actions = { activeThread: () => ({ cwd: "/repo", draftPending: false }), openFile: vi.fn() } as unknown as WorkbenchActions;
  render(<SearchDialogsLayer dialogs={dialogs} host={host} channel="w" actions={actions} />);
  return { dialogs, actions };
}

describe("Search Kit: dialogs", () => {
  it("searches the project and opens a hit at its line", async () => {
    const result: ContentSearchResult = {
      engine: "ripgrep",
      truncated: false,
      matches: [
        { path: "src/a.ts", line: 3, text: "const needle = 1;", ranges: [[6, 12]] },
        { path: "src/a.ts", line: 9, text: "needle()", ranges: [[0, 6]] },
        { path: "src/b.ts", line: 1, text: "// needle", ranges: [[3, 9]] },
      ],
    };
    const host = vi.fn(async (command: string, input: unknown) => {
      if (command === "content" && (input as { query: string }).query) return result;
      return { matches: [], truncated: false, engine: "ripgrep" };
    }) as unknown as SearchHost;
    const { dialogs, actions } = dialogHarness(host);
    act(() => dialogs.toggle("content"));
    const input = screen.getByRole("textbox", { name: "Search in project" });
    fireEvent.click(screen.getByRole("button", { name: "Match case" }));
    fireEvent.change(input, { target: { value: "needle" } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("3 results in 2 files"));
    expect(host).toHaveBeenCalledWith("content", { cwd: "/repo", query: "needle", regex: false, caseSensitive: true, wholeWord: false, channel: "w" });
    // The list widens its window in an effect after the status line renders.
    await waitFor(() => expect([...document.querySelectorAll(".search-file-row strong")].map((row) => row.textContent)).toEqual(["a.ts", "b.ts"]));
    expect(document.querySelector(".search-match-row mark")?.textContent).toBe("needle");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(actions.openFile).toHaveBeenCalledWith("src/a.ts", { line: 9 });
    expect(dialogs.getSnapshot()).toBeUndefined();
  });

  it("says why a regular expression was refused, and stops the search on close", async () => {
    const host = vi.fn(async (_command: string, input: unknown) => (input as { query: string }).query
      ? { matches: [], truncated: false, engine: "ripgrep", error: "Not a valid regular expression: unclosed group" }
      : { matches: [], truncated: false, engine: "ripgrep" }) as unknown as SearchHost;
    const { dialogs } = dialogHarness(host);
    act(() => dialogs.toggle("content"));
    fireEvent.change(screen.getByRole("textbox", { name: "Search in project" }), { target: { value: "(" } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Not a valid regular expression: unclosed group"));
    const calls = (host as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    act(() => dialogs.toggle("content"));
    expect((host as unknown as { mock: { calls: unknown[][] } }).mock.calls.slice(calls)).toContainEqual(["content", { query: "", channel: "w" }]);
  });

  it("picks a file by fuzzy match and opens it", async () => {
    const answer: FileSearchResult = { total: 2, files: [{ path: "src/sb.ts", positions: [4, 5] }, { path: "src/b.ts", positions: [0, 4] }] };
    const host = vi.fn(async () => answer) as unknown as SearchHost;
    const { dialogs, actions } = dialogHarness(host);
    act(() => dialogs.toggle("files"));
    const input = screen.getByRole("textbox", { name: "Go to file" });
    fireEvent.change(input, { target: { value: "sb" } });
    await waitFor(() => expect(host).toHaveBeenCalledWith("files", { cwd: "/repo", query: "sb", limit: 60 }));
    await waitFor(() => expect(document.querySelectorAll(".search-pick-row")).toHaveLength(2));
    expect(document.querySelector(".search-pick-row strong mark")?.textContent).toBe("sb");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(actions.openFile).toHaveBeenCalledWith("src/sb.ts");
  });
});
