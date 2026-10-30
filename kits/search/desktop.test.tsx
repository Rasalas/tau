// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaletteSearchContext, UiProject, UiSession, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { createSearchExtension } from "./desktop.js";
import { SearchDialogs, SearchDialogsLayer, type SearchHost } from "./dialogs.js";
import { fileItems, projectItems, threadContentItems, threadRequestItems, threadTitleItems } from "./palette-sources.js";
import { SEARCH_FILES_SERVICE, SEARCH_KIT_ID, WORKSPACE_STORE_SERVICE, type ContentSearchResult, type FileSearchResult, type SearchFilesService, type WorkspaceStoreView } from "./protocol.js";

afterEach(cleanup);

const thread = (id: string, title: string, modifiedAt: number, projectName = "tau"): UiSession =>
  ({ id, path: `/sessions/${id}.jsonl`, title, modifiedAt, projectPath: "/repo", projectName, messageCount: 2 });

const projects: UiProject[] = [
  { path: "/repo", workspaceId: "ws-repo", displayPath: "~/repo", name: "tau", lastOpenedAt: 2 },
  { path: "/other", name: "orbit", lastOpenedAt: 3 },
];

function searchContext(actions = {} as WorkbenchActions): PaletteSearchContext {
  return {
    actions,
    index: { projects, threads: [thread("a", "Fix the stage tabs", 1), thread("b", "Stage restore", 5, "orbit"), thread("c", "Luna test", 3)], activeThreadId: "b" },
    signal: new AbortController().signal,
  };
}

describe("Search Kit: palette sources", () => {
  it("finds threads by title and project, breaking quality ties by recency, with project, state and branch", () => {
    vi.spyOn(Date, "now").mockReturnValue(3 * 86_400_000);
    const context = { ...searchContext(), index: { ...searchContext().index, running: ["b"] } };
    context.index.threads[0]!.projectLabel = "fix/stage";
    expect(threadTitleItems("stage", context).map((item) => [item.label, item.detail])).toEqual([
      ["Stage restore", "orbit · working"],
      ["Fix the stage tabs", "tau · 2d · fix/stage"],
    ]);
    expect(threadTitleItems("stage tau", context).map((item) => item.id)).toEqual(["a"]);
    expect(threadTitleItems(" ", context)).toEqual([]);
    vi.restoreAllMocks();
  });

  it("leaves delegated threads out of All and Threads for empty and typed queries, while keeping forks", () => {
    const base = searchContext();
    // A normal fork has no parentThreadId in Tau's index, unlike a delegated thread.
    const threads = [...base.index.threads, thread("fork", "Agent experiment fork", 7), { ...thread("d", "Agent reply", 9), parentThreadId: "a" }];
    for (const scope of ["all", "threads"] as const) {
      const context = { ...base, index: { ...base.index, threads, waiting: ["d"] }, scope };
      expect(threadTitleItems("", context).map((item) => item.id)).toEqual(["fork", "b", "c", "a"]);
      expect(threadTitleItems("agent", context).map((item) => item.id)).toEqual(["fork"]);
    }
  });

  it("puts exact and word-aware title matches before newer incidental matches, before the row cap", () => {
    const base = searchContext();
    const threads = [
      ...Array.from({ length: 12 }, (_, at) => thread(`mid-${at}`, "Fix oauth redirect", 100 + at)),
      thread("prefix", "Authentication cleanup", 10),
      { ...thread("branch", "Login cleanup", 8), projectLabel: "feature/auth" },
      thread("older-word", "Fix auth tokens", 2),
      thread("newer-word", "Improve auth tokens", 3),
      thread("exact", "Auth", 1),
    ];
    const context = { ...base, index: { ...base.index, threads } };
    expect(threadTitleItems("auth", context).map((item) => item.id)).toEqual([
      "exact", "newer-word", "older-word", "branch", "prefix", "mid-11", "mid-10", "mid-9",
    ]);
    expect(threadTitleItems("auth", { ...context, scope: "threads" })).toHaveLength(17);
    expect(threadTitleItems("auth tau", context)[0]!.id).toBe("newer-word");
  });

  it("puts threads that wait on the user first in an empty palette, however old, and says so", () => {
    const base = searchContext();
    const many = Array.from({ length: 7 }, (_, index) => thread(`n${index}`, `Newer ${index}`, 100 + index));
    const context = { ...base, index: { ...base.index, threads: [...base.index.threads, ...many], waiting: ["a", "c"] }, scope: "all" as const };
    const rows = threadTitleItems("", context);
    expect(rows.slice(0, 2).map((item) => item.id)).toEqual(["c", "a"]);
    expect(rows.map((item) => item.id).slice(2)).toEqual(["n6", "n5", "n4"]);
    expect(rows[0]!.detail).toContain("waiting");
    // Typing is a search: the order is recency again.
    expect(threadTitleItems("newer", context)[0]!.id).toBe("n6");
  });

  it("leaves out a thread nobody wrote in, as the thread list does, unless it is at work", () => {
    const base = searchContext();
    const empty = { ...thread("e", "", 9), messageCount: 0 };
    const context = { ...base, index: { ...base.index, threads: [...base.index.threads, empty] }, scope: "threads" as const };
    expect(threadTitleItems("", context).map((item) => item.id)).toEqual(["b", "c", "a"]);
    expect(threadTitleItems("", { ...context, index: { ...context.index, running: ["e"] } }).map((item) => item.label)[0]).toBe("Untitled thread");
  });

  it("finds a thread by its branch label", () => {
    const base = searchContext();
    base.index.threads[2]!.projectLabel = "feat/thread-directory";
    expect(threadTitleItems("directory", base).map((item) => item.id)).toEqual(["c"]);
  });

  it("lists threads found through their linked requests, newest first, unless the title already showed them", () => {
    const context = searchContext();
    const request = { url: "https://github.com/acme/tau/pull/95", repository: "acme/tau", state: "open" as const, title: null, headBranch: "feat/x" };
    const items = threadRequestItems([
      { sessionId: "a", requests: [{ ...request, number: 95 }, { ...request, number: 96 }] },
      { sessionId: "c", requests: [{ ...request, number: 95 }] },
      { sessionId: "gone", requests: [{ ...request, number: 95 }] },
      { sessionId: "b", requests: [{ ...request, number: 95 }] },
    ], context, new Set(["b"]));
    expect(items.map((item) => [item.id, item.detail])).toEqual([
      ["c", "#95 · acme/tau · open · feat/x"],
      ["a", "#95 · acme/tau · open · feat/x · +1"],
    ]);
    const actions = { switchSession: vi.fn() } as unknown as WorkbenchActions;
    items[0]!.run!(actions);
    expect(actions.switchSession).toHaveBeenCalledWith("/sessions/c.jsonl");
  });

  it("opens a thread in the stage and a file as source, pinned there with the modifier", () => {
    const actions = { openThread: vi.fn(), openFile: vi.fn() } as unknown as WorkbenchActions;
    threadTitleItems("luna", searchContext())[0]!.stage!(actions);
    expect(actions.openThread).toHaveBeenCalledWith("c");
    const [file] = fileItems([{ path: "src/renderer/pairing/Watcher.tsx", positions: [] }], new Map([["src/renderer/pairing/Watcher.tsx", "M"]]));
    expect([file!.label, file!.detail]).toEqual(["Watcher.tsx", "src/renderer/pairing · M"]);
    file!.run!(actions);
    file!.stage!(actions);
    expect(actions.openFile).toHaveBeenNthCalledWith(1, "src/renderer/pairing/Watcher.tsx");
    expect(actions.openFile).toHaveBeenNthCalledWith(2, "src/renderer/pairing/Watcher.tsx", { pin: true });
  });

  it("asks the host for the files of the thread on screen, under a heading that names its branch", async () => {
    const invoke = vi.fn(async (_id: string, command: string) => command === "files" ? { files: [{ path: "README.md", positions: [] }], total: 1 } : undefined);
    const { registry } = createKitHarness(invoke);
    let listener: () => void = () => undefined;
    let state: ReturnType<WorkspaceStoreView["getSnapshot"]> = { cwd: "/repo", changes: { branch: "main", files: [{ path: "README.md", status: "untracked" }] } };
    const store: WorkspaceStoreView = { getSnapshot: () => state, subscribe: (next) => { listener = next; return () => undefined; } };
    registry.activate({ id: "fixture.workspace", name: "Workspace", activate: (context) => { context.provideService(WORKSPACE_STORE_SERVICE, store); } });
    registry.activate(createSearchExtension());
    const files = () => registry.getPaletteSources().find((entry) => entry.id === "search.files")!;
    expect([files().label, files().scope]).toEqual(["Files · in main", "files"]);
    const actions = { activeThread: () => ({ cwd: "/repo", draftPending: false }) } as unknown as WorkbenchActions;
    const context = { ...searchContext(actions), scope: "all" as const };
    expect(await files().search("", context)).toEqual([]);
    const found = await files().search("", { ...context, scope: "files" });
    expect(found.map((item) => item.detail)).toEqual(["A"]);
    expect(invoke).toHaveBeenCalledWith(SEARCH_KIT_ID, "files", { cwd: "/repo", query: "", limit: 60 });
    state = { cwd: "/repo", changes: { branch: "fix/tabs", files: [] } };
    listener();
    expect(files().label).toBe("Files · in fix/tabs");
  });

  it("hands the transcript's find the ids the host names for the whole thread", async () => {
    const invoke = vi.fn(async () => ({ messageIds: ["u1", "a7"], truncated: false }));
    const { registry } = createKitHarness(invoke);
    registry.activate(createSearchExtension());
    expect(await registry.getTranscriptFinder()!.find({ sessionId: "t1", query: "quartz" })).toEqual({ messageIds: ["u1", "a7"], truncated: false });
    expect(invoke).toHaveBeenCalledWith(SEARCH_KIT_ID, "find-in-thread", { sessionId: "t1", query: "quartz" });
    await registry.getTranscriptFinder()!.find({ sessionId: "t1", query: "quartz moon", mode: "all-words" });
    expect(invoke).toHaveBeenLastCalledWith(SEARCH_KIT_ID, "find-in-thread", { sessionId: "t1", query: "quartz moon", mode: "all-words" });
  });

  it("switches to a thread and opens a project by its workspace id", async () => {
    const actions = { switchSession: vi.fn(async () => true), openWorkspace: vi.fn(async () => true) } as unknown as WorkbenchActions;
    const context = searchContext(actions);
    await threadTitleItems("luna", context)[0]!.run!(actions);
    expect(actions.switchSession).toHaveBeenCalledWith("/sessions/c.jsonl");
    const found = projectItems("t", context);
    expect(found.map((item) => item.label)).toEqual(["orbit", "tau"]);
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
    expect(items.map((item) => [item.id, item.detail])).toEqual([["c", "Agent: …the moon is called Luna…"]]);
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
    expect(invoke).toHaveBeenCalledWith(SEARCH_KIT_ID, "threads", { query: "moon", limit: 12, includeStatus: true, sessionIds: ["a", "b", "c"], activeSessionId: "b", channel: expect.any(String), archivedSessionIds: [] });
    const aborted = new AbortController();
    aborted.abort();
    expect(await source.search("moon", { ...searchContext(), signal: aborted.signal })).toEqual([]);
  });

  it("asks the host which threads link the request the query names, once the title did not show them", async () => {
    const invoke = vi.fn(async (_id: string, command: string) => command === "thread-requests"
      ? [{ sessionId: "c", requests: [{ number: 95, repository: "acme/tau", url: "https://github.com/acme/tau/pull/95", state: "open", title: null, headBranch: null }] }]
      : undefined);
    const { registry } = createKitHarness(invoke);
    registry.activate(createSearchExtension({ threadContentDelayMs: 0 }));
    const source = registry.getPaletteSources().find((entry) => entry.id === "search.thread-requests")!;
    expect(source.scope).toBe("threads");
    expect(await source.search("9", searchContext())).toEqual([]);
    const found = await source.search("acme/tau#95", searchContext());
    expect(found.map((item) => [item.label, item.detail])).toEqual([["Luna test", "#95 · acme/tau · open"]]);
    expect(invoke).toHaveBeenCalledWith(SEARCH_KIT_ID, "thread-requests", { query: "acme/tau#95", limit: 12, sessionIds: ["a", "b", "c"] });
  });

  it("filters children and already shown titles before host limits, keeping good titles ahead of text matches", async () => {
    const base = searchContext();
    const context = { ...base, index: { ...base.index, threads: [
      thread("exact", "Moon", 1), thread("word", "Visit the moon", 2), thread("text", "Other work", 100),
      { ...thread("child", "Moon child", 200), parentThreadId: "exact" },
    ] } };
    const invoke = vi.fn(async (_id: string, command: string) => command === "threads"
      ? [{ sessionId: "text", path: "", role: "user", snippet: "The moon came up once" },
        { sessionId: "child", path: "", role: "user", snippet: "moon" }]
      : []);
    const { registry } = createKitHarness(invoke);
    registry.activate(createSearchExtension({ threadContentDelayMs: 0 }));
    const sources = registry.getPaletteSources();
    const titles = sources.find((entry) => entry.id === "search.threads")!;
    const content = sources.find((entry) => entry.id === "search.thread-content")!;
    const requests = sources.find((entry) => entry.id === "search.thread-requests")!;
    expect(titles.order).toBeLessThan(content.order!);
    expect([...(await titles.search("moon", context)), ...(await content.search("moon", context))].map((item) => item.id)).toEqual(["exact", "word", "text"]);
    expect(invoke).toHaveBeenCalledWith(SEARCH_KIT_ID, "threads", { query: "moon", limit: 12, includeStatus: true, sessionIds: ["text"], activeSessionId: "b", channel: expect.any(String), archivedSessionIds: [] });
    await requests.search("moon", context);
    expect(invoke).toHaveBeenCalledWith(SEARCH_KIT_ID, "thread-requests", { query: "moon", limit: 12, sessionIds: ["text"] });
    const onlyChild = { ...context, index: { ...context.index, threads: [context.index.threads[3]!] } };
    invoke.mockClear();
    expect(await content.search("moon", onlyChild)).toEqual([]);
    expect(await requests.search("moon", onlyChild)).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("joins content and request matches by thread identity, leaving children and foreign paths out", () => {
    const base = searchContext();
    const remote = { ...thread("machine~c", "Remote work", 10), path: "/sessions/c.jsonl", workspaceId: "ws-remote", machine: { id: "machine", name: "Remote" } };
    const child = { ...thread("child", "Child work", 20), parentThreadId: "a" };
    const context = { ...base, index: { ...base.index, threads: [remote, ...base.index.threads, child] } };
    const items = threadContentItems([
      { sessionId: "c", path: "/sessions/c.jsonl", role: "user", snippet: "local text" },
      { sessionId: "unknown", path: "/sessions/c.jsonl", role: "user", snippet: "foreign text" },
      { sessionId: "machine~c", path: "/sessions/c.jsonl", role: "user", snippet: "remote text" },
      { sessionId: "child", path: "/sessions/child.jsonl", role: "user", snippet: "child text" },
    ], context, new Set());
    expect(items.map((item) => [item.id, item.detail])).toEqual([["c", "You: local text"], ["machine~c", "You: remote text"]]);
    const request = { number: 95, repository: "acme/tau", url: "https://github.com/acme/tau/pull/95", state: "open" as const, title: null, headBranch: null };
    expect(threadRequestItems([{ sessionId: "child", requests: [request] }, { sessionId: "c", requests: [request] }], context, new Set()).map((item) => item.id)).toEqual(["c"]);
  });

  it("binds ⇧⌘F and ⌘P and forgets the file list when Git reports a change", () => {
    const invoke = vi.fn(async () => undefined);
    const { registry } = createKitHarness(invoke);
    let listener: () => void = () => undefined;
    let state: ReturnType<WorkspaceStoreView["getSnapshot"]> = { cwd: "/repo", changes: {} };
    const store: WorkspaceStoreView = { getSnapshot: () => state, subscribe: (next) => { listener = next; return () => undefined; } };
    registry.activate({ id: "fixture.workspace", name: "Workspace", activate: (context) => { context.provideService(WORKSPACE_STORE_SERVICE, store); } });
    registry.activate(createSearchExtension());
    invoke.mockClear();
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

  it("hands a pick to the kit that asked, and closes from its own button on a touch screen", async () => {
    const answer: FileSearchResult = { total: 1, files: [{ path: "README.md", positions: [0] }] };
    const host = vi.fn(async () => answer) as unknown as SearchHost;
    document.body.dataset.profile = "compact";
    try {
      const { dialogs, actions } = dialogHarness(host);
      const onPick = vi.fn();
      act(() => dialogs.pickFile(onPick));
      await waitFor(() => expect(document.querySelectorAll(".search-pick-row")).toHaveLength(1));
      fireEvent.click(document.querySelector(".search-pick-row")!);
      expect(onPick).toHaveBeenCalledWith("README.md");
      expect(actions.openFile).not.toHaveBeenCalled();
      expect(dialogs.getSnapshot()).toBeUndefined();

      // ⌘P afterwards is the stage's again.
      act(() => dialogs.toggle("files"));
      fireEvent.click(screen.getByRole("button", { name: "Close Go to file" }));
      expect(dialogs.getSnapshot()).toBeUndefined();
    } finally {
      delete document.body.dataset.profile;
    }
  });

  it("offers Go to file to other kits and draws its dialogs on a phone or tablet too", () => {
    const { registry } = createKitHarness(vi.fn(async () => undefined));
    let service: SearchFilesService | undefined;
    registry.activate({ id: "fixture.files", name: "Files", activate: (context) => { context.useService<SearchFilesService>(SEARCH_FILES_SERVICE, (found) => { service = found; return () => undefined; }); } });
    registry.activate(createSearchExtension());
    expect(service?.pickFile).toBeTypeOf("function");
    expect(registry.getRegions("title-bar").find((region) => region.id === "search.dialogs")?.profiles).toContain("compact");
  });
});

describe("message search index UI", () => {
  it("waits for successful asynchronous navigation before submitting a thread-bound global Find", async () => {
    let finish!: (opened: boolean) => void;
    const actions = { switchSession: vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; })), findInThread: vi.fn() } as unknown as WorkbenchActions;
    const item = threadContentItems([{ sessionId: "c", path: "", role: "user", snippet: "luna beside the moon" }], searchContext(actions), new Set(), "luna moon")[0]!;
    const opening = item.run!(actions);
    expect(actions.findInThread).not.toHaveBeenCalled();
    finish(true);
    await opening;
    expect(actions.findInThread).toHaveBeenCalledExactlyOnceWith("luna moon", { sessionId: "c", mode: "all-words" });
    vi.mocked(actions.findInThread!).mockClear();
    const failed = item.run!(actions);
    finish(false);
    await failed;
    expect(actions.findInThread).not.toHaveBeenCalled();
  });

  it("excludes archived delegated children and deleted ids and opens a marked message hit with the query", async () => {
    const actions = { switchSession: vi.fn(async () => true), findInThread: vi.fn(), openThread: vi.fn() } as unknown as WorkbenchActions;
    const base = searchContext(actions);
    const context: PaletteSearchContext = { ...base, index: { ...base.index, archivedThreadIds: ["c", "child"], threads: [...base.index.threads, { ...thread("child", "Child", 10), parentThreadId: "a" }] } };
    const items = threadContentItems([
      { sessionId: "child", path: "", role: "user", snippet: "luna" },
      { sessionId: "gone", path: "", role: "user", snippet: "luna" },
      { sessionId: "c", path: "", role: "user", snippet: "the luna answer" },
    ], context, new Set(), "luna");
    expect(items.map(item => item.id)).toEqual(["c"]);
    expect(items[0]!.detail).toBe("You: the luna answer · Archived");
    expect(items[0]!.ariaLabel).toBe("Luna test, You said: the luna answer, Archived");
    const view = render(<>{items[0]!.detailContent}</>);
    expect(view.container.querySelector("mark")?.textContent).toBe("luna");
    await items[0]!.run!(actions);
    expect(actions.switchSession).toHaveBeenCalledWith("/sessions/c.jsonl");
    expect(actions.findInThread).toHaveBeenCalledWith("luna", { sessionId: "c", mode: "all-words" });
    items[0]!.stage!(actions);
    expect(actions.openThread).toHaveBeenCalledWith("c");
  });
  it("registers Search on Threads for every profile and limits status to All/Threads after three characters", async () => {
    const { registry } = createKitHarness(async (_id, command) => command === "index-status"
      ? { enabled: false, state: "disabled", done: 0, total: 0, bytes: 0, threads: 0, revision: 1 }
      : undefined);
    registry.activate(createSearchExtension({ threadContentDelayMs: 0 }));
    const settings = registry.getSettingsSections("threads").find(section => section.id === "search.settings")!;
    expect(settings.card).toBe("search");
    expect(settings.profiles).toEqual(["desktop", "web", "compact"]);
    const source = registry.getPaletteSources().find(item => item.id === "search.thread-content")!;
    await waitFor(() => expect(source.status?.("moon", { ...searchContext(), scope: "threads" })).toContain("Turn on the message index"));
    expect(source.status?.("mo", searchContext())).toBeUndefined();
    expect(source.status?.("moon", { ...searchContext(), scope: "files" })).toBeUndefined();
    registry.deactivate(SEARCH_KIT_ID);
  });
});

it.each(["threads", "thread-search"])("preserves transcript truncation and displays an empty partial result from %s", async (searchCommand) => {
  const status = { enabled: true, state: "ready", done: 1, total: 1, bytes: 0, threads: 1, revision: 1 };
  const invoke = vi.fn(async (_id: string, command: string) => {
    if (command === "find-in-thread") return { messageIds: ["a"], truncated: true };
    if (command === "index-status") return status;
    if (command === searchCommand) return { matches: [], truncated: true, ...(command === "thread-search" ? { complete: true, status } : {}) };
    return undefined;
  });
  const { registry } = createKitHarness(invoke);
  registry.activate(createSearchExtension({ threadContentDelayMs: 0 }));
  expect(await registry.getTranscriptFinder()!.find({ sessionId: "t", query: "x" })).toEqual({ messageIds: ["a"], truncated: true });
  const source = registry.getPaletteSources().find(entry => entry.id === "search.thread-content")!;
  expect(await source.search("missing", searchContext())).toEqual([expect.objectContaining({ label: "Partial thread search" })]);
  registry.deactivate(SEARCH_KIT_ID);
});

it("cancels an in-flight legacy palette query when its signal aborts", async () => {
  let finish!: (value: unknown) => void;
  const invoke = vi.fn((_id: string, command: string, input: unknown) => command === "threads" && (input as { query: string }).query
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(undefined));
  const { registry } = createKitHarness(invoke);
  registry.activate(createSearchExtension({ threadContentDelayMs: 0 }));
  const source = registry.getPaletteSources().find(entry => entry.id === "search.thread-content")!;
  const controller = new AbortController();
  const pending = source.search("needle", { ...searchContext(), signal: controller.signal });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  controller.abort();
  expect(invoke).toHaveBeenLastCalledWith(SEARCH_KIT_ID, "threads", { query: "", channel: expect.any(String) });
  finish({ matches: [], truncated: false });
  expect(await pending).toEqual([]);
  registry.deactivate(SEARCH_KIT_ID);
});
