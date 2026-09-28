// @vitest-environment jsdom
import { language } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StageTab, StageTabHandle, UiEditor, UiFileContent, UiFileWriteResult, WorkbenchActions } from "tau";
import { createKitHarness, createMemoryStorage, setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { useAppKeybindings } from "../../src/renderer/test-support/kit-harness.js";
import filesExtension from "./desktop.js";
import type { WorkspaceStoreLike } from "./kit.js";
import { FILE_EDITOR_TAB, FILES_KIT_ID, WORKSPACE_STORE_SERVICE } from "./protocol.js";

// jsdom lays out no text; CodeMirror measures it anyway.
Range.prototype.getClientRects ??= function getClientRects() { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect ??= function getBoundingClientRect() { return new DOMRect(); };

const mac = /mac/iu.test(navigator.platform);
const mod = { ctrlKey: !mac, metaKey: mac };

/** The CodeMirror view behind an editor tab, found by its accessible name. */
async function findEditor(path: string) {
  const content = await screen.findByLabelText(`Contents of ${path}`);
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error(`no editor for ${path}`);
  return {
    content,
    view,
    text: () => view.state.doc.toString(),
    /** Types the whole text over, as a user edit. */
    replace: (text: string) => act(() => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input" }); }),
  };
}

afterEach(() => {
  cleanup();
  setHostClient(undefined);
  vi.useRealTimers();
});

/** The project the tests' tabs are on, as the stage names it. */
const REPO = { workspace: "/repo" };

/** Files Kit's host, answering from a map of paths per project; `mtime` moves on every write. */
function fakeHost(files: Record<string, string>, others: Record<string, Record<string, string>> = {}) {
  let mtimeMs = 1_000;
  const projects: Record<string, Record<string, string>> = { [REPO.workspace]: files, ...others };
  const writes: Array<{ workspace?: string; relPath: string; text: string; expectedMtimeMs?: number | null }> = [];
  const invoke = vi.fn(async (extensionId: string, command: string, input?: unknown): Promise<unknown> => {
    if (extensionId !== FILES_KIT_ID) return undefined;
    const { workspace, relPath, text, expectedMtimeMs } = input as { workspace: string; relPath: string; text?: string; expectedMtimeMs?: number | null };
    const project = projects[workspace];
    if (!project) throw new Error("Workspace is not a known Tau project.");
    if (command === "read") {
      const body = project[relPath];
      if (body === undefined) throw new Error("Not a file.");
      return { path: `/repo/${relPath}`, name: relPath.split("/").at(-1) ?? relPath, size: body.length, mtimeMs, kind: "text", text: body, language: relPath.endsWith(".ts") ? "typescript" : undefined } satisfies UiFileContent;
    }
    if (command === "stat") return project[relPath] === undefined ? { exists: false } : { exists: true, size: project[relPath]!.length, mtimeMs };
    if (command === "write") {
      writes.push({ ...(workspace === REPO.workspace ? {} : { workspace }), relPath, text: text!, ...(expectedMtimeMs !== undefined ? { expectedMtimeMs } : {}) });
      if (expectedMtimeMs !== undefined && expectedMtimeMs !== mtimeMs) return { status: "conflict", size: 1, mtimeMs } satisfies UiFileWriteResult;
      project[relPath] = text!;
      mtimeMs += 1;
      return { status: "written", size: text!.length, mtimeMs } satisfies UiFileWriteResult;
    }
    return undefined;
  });
  return {
    invoke,
    writes,
    projects,
    /** Somebody else writes the file. */
    touch(relPath: string, body: string) { files[relPath] = body; mtimeMs += 50; },
  };
}

function workspaceStore(editors: UiEditor[] = [{ id: "code", name: "VS Code" }, { id: "file-manager", name: "Finder" }]) {
  const opened: Array<[string | undefined, string | undefined, unknown]> = [];
  let fileEditor: ((relPath: string, actions: WorkbenchActions) => void) | undefined;
  const snapshot = { cwd: "/repo", editors };
  const store: WorkspaceStoreLike & { opened: typeof opened; edit(relPath: string, actions: WorkbenchActions): void } = {
    opened,
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    activeEditor: () => editors[0],
    chooseEditor: vi.fn(),
    openInEditor: async (relPath, editorId, position) => { opened.push([relPath, editorId, position]); },
    refresh: vi.fn(async () => undefined),
    registerFileEditor: (editor) => { fileEditor = editor; return () => { fileEditor = undefined; }; },
    edit: (relPath, actions) => fileEditor?.(relPath, actions),
  };
  return store;
}

function handle(): StageTabHandle & { dirty: boolean[]; closers: Array<() => void> } {
  const dirty: boolean[] = [];
  const closers: Array<() => void> = [];
  return {
    id: "ext:tau.files.editor:notes.md",
    dirty,
    closers,
    setTitle: vi.fn(),
    setDirty: (value) => { dirty.push(value); },
    onClose: (listener) => { closers.push(listener); return () => undefined; },
  };
}

function setup(files: Record<string, string>, actionsPatch: Partial<WorkbenchActions> = {}, others: Record<string, Record<string, string>> = {}) {
  const host = fakeHost(files, others);
  const { registry, preferences } = createKitHarness(host.invoke);
  const store = workspaceStore();
  registry.activate(filesExtension);
  registry.activate({ id: "test.workspace", name: "Workspace stand-in", activate: (context) => { context.provideService(WORKSPACE_STORE_SERVICE, store); } });
  const kind = registry.getStageTabKind(FILE_EDITOR_TAB)!;
  const actions = {
    notify: vi.fn(), closeStageTab: vi.fn(), openStageTab: vi.fn(() => "tab"),
    activeThread: () => ({ cwd: REPO.workspace, draftPending: false }),
    ...actionsPatch,
  } as unknown as WorkbenchActions;
  return { host, registry, preferences, store, kind, actions };
}

describe("Files Kit", () => {
  it("edits a file, marks the tab dirty and saves on mod+s before the stash binding hears it", async () => {
    const tab = handle();
    const shown: StageTab = { kind: "extension", id: tab.id, preview: false, tabKind: FILE_EDITOR_TAB, params: { path: "notes.md" }, title: "notes.md" };
    const { host, kind, actions, store, registry } = setup({ "notes.md": "# Notes\n" }, { activeStageTab: () => shown });
    render(<>{kind.render({ path: "notes.md" }, tab, actions, REPO)}</>);
    const editor = await findEditor("notes.md");
    expect(editor.text()).toBe("# Notes\n");

    editor.replace("# Notes\nmore\n");
    expect(tab.dirty.at(-1)).toBe(true);
    expect(screen.getByText("Unsaved")).toBeTruthy();

    // Prompt Tools' stash on the same chord, as it is bound in the app.
    const stash = vi.fn();
    registry.activate({ id: "test.stash", name: "Stash stand-in", activate: (context) => {
      context.registerCommand({ id: "stash", label: "Stash", group: "Test", run: stash });
      context.registerKeybinding({ keys: "mod+s", commandId: "stash", when: "!terminalFocus" });
    } });
    renderHook(() => useAppKeybindings(registry, actions, vi.fn()));
    editor.content.focus();
    fireEvent.keyDown(editor.content, { key: "s", ...mod });
    expect(stash).not.toHaveBeenCalled();

    await waitFor(() => expect(host.writes).toEqual([{ relPath: "notes.md", text: "# Notes\nmore\n", expectedMtimeMs: 1_000 }]));
    await waitFor(() => expect(tab.dirty.at(-1)).toBe(false));
    expect(store.refresh).toHaveBeenCalled();
  });

  it("says when the file changed on disk under unsaved work and reloads it on request", async () => {
    const { host, kind, actions } = setup({ "notes.md": "one\n" });
    const tab = handle();
    render(<>{kind.render({ path: "notes.md" }, tab, actions, REPO)}</>);
    const editor = await findEditor("notes.md");
    editor.replace("mine\n");
    host.touch("notes.md", "theirs\n");
    await act(async () => { window.dispatchEvent(new Event("focus")); });

    expect(await screen.findByText(/changed on disk while you were editing it/u)).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Save/u }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reload from disk" }));
    await waitFor(() => expect(editor.text()).toBe("theirs\n"));
    expect(screen.queryByText(/changed on disk/u)).toBeNull();
    // The keyboard goes back to the text, so mod+s still saves here.
    await waitFor(() => expect(document.activeElement).toBe(editor.content));
  });

  it("writes over the disk's version only when the user keeps theirs", async () => {
    const { host, kind, actions } = setup({ "notes.md": "one\n" });
    render(<>{kind.render({ path: "notes.md" }, handle(), actions, REPO)}</>);
    (await findEditor("notes.md")).replace("mine\n");
    host.touch("notes.md", "theirs\n");
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    fireEvent.click(await screen.findByRole("button", { name: "Keep my version" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save/u }));
    await waitFor(() => expect(host.writes.at(-1)).toEqual({ relPath: "notes.md", text: "mine\n", expectedMtimeMs: 1_050 }));
  });

  it("keeps the editor's own chords: mod+f searches, mod+d adds a cursor, Escape stops nothing", async () => {
    const { kind, actions, registry } = setup({ "src/a.ts": "one two one\n" });
    const abort = vi.fn();
    const review = vi.fn();
    registry.activate({ id: "test.core", name: "Core stand-in", activate: (context) => {
      context.registerCommand({ id: "abort", label: "Stop", group: "Test", run: abort });
      context.registerKeybinding({ keys: "escape", commandId: "abort" });
      context.registerCommand({ id: "review", label: "Review", group: "Test", run: review });
      context.registerKeybinding({ keys: "mod+d", commandId: "review", when: "!terminalFocus" });
    } });
    renderHook(() => useAppKeybindings(registry, actions, vi.fn()));
    render(<>{kind.render({ path: "src/a.ts" }, handle(), actions, REPO)}</>);
    const editor = await findEditor("src/a.ts");
    editor.content.focus();

    fireEvent.keyDown(editor.content, { key: "f", ...mod });
    const query = await screen.findByRole("textbox", { name: "Find" });
    fireEvent.keyDown(query, { key: "Escape" });
    expect(document.querySelector(".cm-search")).toBeNull();

    act(() => { editor.view.dispatch({ selection: { anchor: 0, head: 3 } }); });
    fireEvent.keyDown(editor.content, { key: "d", ...mod });
    expect(editor.view.state.selection.ranges.map((range) => [range.from, range.to])).toEqual([[0, 3], [8, 11]]);
    expect(review).not.toHaveBeenCalled();

    fireEvent.keyDown(editor.content, { key: "Escape" });
    fireEvent.keyDown(editor.content, { key: "Escape" });
    expect(editor.view.state.selection.ranges).toHaveLength(1);
    expect(abort).not.toHaveBeenCalled();
  });

  it("wraps long lines from the header switch, for every file and in Settings", async () => {
    const { kind, actions, preferences } = setup({ "src/a.ts": "const a = 1;\n" });
    render(<>{kind.render({ path: "src/a.ts" }, handle(), actions, REPO)}</>);
    const editor = await findEditor("src/a.ts");
    expect(editor.content.classList.contains("cm-lineWrapping")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Enable word wrap" }));
    await waitFor(() => expect(editor.content.classList.contains("cm-lineWrapping")).toBe(true));
    expect(screen.getByRole("button", { name: "Disable word wrap" }).getAttribute("aria-pressed")).toBe("true");
    expect(preferences.optionValue(FILES_KIT_ID, "wordWrap", false)).toBe(true);
  });

  it("opens on the line it was asked for, with the TypeScript mode", async () => {
    const { kind, actions } = setup({ "src/a.ts": "const a = 1;\nconst b = 2;\nfunction c() {\n  return 3;\n}\n" });
    render(<>{kind.render({ path: "src/a.ts", line: 3 }, handle(), actions, REPO)}</>);
    const editor = await findEditor("src/a.ts");
    await waitFor(() => expect(editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number).toBe(3));
    await waitFor(() => expect(editor.view.state.facet(language)?.name).toBe("typescript"));
  });

  it("shows Markdown rendered or as source, and remembers the choice", async () => {
    setClientStorage(createMemoryStorage());
    const { kind, actions } = setup({ "README.md": "# Title\n\nSome *text*.\n" });
    render(<>{kind.render({ path: "README.md" }, handle(), actions, REPO)}</>);
    await screen.findByLabelText("Contents of README.md");
    fireEvent.click(screen.getByRole("button", { name: "Show rendered markdown" }));
    expect(await screen.findByRole("heading", { name: "Title" })).toBeTruthy();
    expect(screen.queryByLabelText("Contents of README.md")).toBeNull();
    cleanup();
    render(<>{kind.render({ path: "README.md" }, handle(), actions, REPO)}</>);
    expect(await screen.findByRole("heading", { name: "Title" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show markdown source" }));
    expect(await screen.findByLabelText("Contents of README.md")).toBeTruthy();
  });

  it("draws a CSV as a table and an HTML page in a frame that runs nothing", async () => {
    const { kind, actions } = setup({ "data.csv": "name,age\nAda,36\n", "page.html": "<h1>Hi</h1>" });
    render(<>{kind.render({ path: "data.csv" }, handle(), actions, REPO)}</>);
    expect(await screen.findByRole("table", { name: "data.csv" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "age" })).toBeTruthy();
    cleanup();
    render(<>{kind.render({ path: "page.html" }, handle(), actions, REPO)}</>);
    const frame = await waitFor(() => {
      const found = document.querySelector("iframe");
      if (!found) throw new Error("no frame yet");
      return found;
    });
    expect(frame.getAttribute("title")).toBe("page.html");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toBe("<h1>Hi</h1>");
  });

  it("shows a PDF and an image from the URL the window shares, without reading their bytes", async () => {
    const shareFile = vi.fn(async (path: string) => ({ url: `tau-ext://files/abc/${path.split("/").at(-1)}`, name: "x", size: 1, mimeType: "application/pdf" }));
    const { host, kind, actions } = setup({}, { shareFile });
    render(<>{kind.render({ path: "docs/paper.pdf" }, handle(), actions, REPO)}</>);
    const frame = await screen.findByTitle("paper.pdf");
    expect(frame.getAttribute("src")).toBe("tau-ext://files/abc/paper.pdf#toolbar=0&view=FitH");
    expect(shareFile).toHaveBeenCalledWith("/repo/docs/paper.pdf");
    cleanup();
    render(<>{kind.render({ path: "logo.png" }, handle(), actions, REPO)}</>);
    expect((await screen.findByRole("img", { name: "logo.png" })).getAttribute("src")).toBe("tau-ext://files/abc/logo.png");
    expect(host.invoke.mock.calls.filter(([, command]) => command === "read")).toEqual([]);
  });

  it("offers every installed editor and reveals in the file manager without making it the default", async () => {
    setHostClient(createFakeHostClient({ hasCapability: () => true }));
    const { kind, actions, store } = setup({ "src/a.ts": "const a = 1;\n" });
    render(<>{kind.render({ path: "src/a.ts" }, handle(), actions, REPO)}</>);
    await screen.findByLabelText("Contents of src/a.ts");
    fireEvent.click(screen.getByRole("button", { name: "Choose editor" }));
    expect(screen.getByText("VS Code", { selector: ".menu *" })).toBeTruthy();
    fireEvent.click(screen.getByText("Reveal in Finder"));
    await waitFor(() => expect(store.opened.at(-1)).toEqual(["src/a.ts", "file-manager", undefined]));
    expect(store.chooseEditor).not.toHaveBeenCalled();
  });

  it("offers no editor of the host's machine to a client whose files are elsewhere, a tablet's", async () => {
    setHostClient(createFakeHostClient({ hasCapability: () => false }));
    const { kind, actions } = setup({ "src/a.ts": "const a = 1;\n" });
    render(<>{kind.render({ path: "src/a.ts" }, handle(), actions, REPO)}</>);
    await screen.findByLabelText("Contents of src/a.ts");
    expect(screen.queryByRole("button", { name: "Choose editor" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("opens the editor from a file tab's Edit button and from a double-click in the Files panel", () => {
    const { registry, actions, store } = setup({});
    const fileTab = { id: "file:/repo/src/a.ts", kind: "file", path: "/repo/src/a.ts", view: "source", preview: false, line: 4 } as StageTab;
    const withTab = { ...actions, activeStageTab: () => fileTab, activeThread: () => ({ cwd: "/repo", draftPending: false }) } as unknown as WorkbenchActions;
    const edit = registry.getCommandsFor("file-tab").find((command) => command.id === "files.edit")!;
    void edit.run(withTab);
    expect(withTab.openStageTab).toHaveBeenCalledWith(FILE_EDITOR_TAB, { path: "src/a.ts", line: 4 }, { key: "src/a.ts" });

    store.edit("README.md", withTab);
    expect(withTab.openStageTab).toHaveBeenLastCalledWith(FILE_EDITOR_TAB, { path: "README.md" }, { key: "README.md" });
  });

  it("keeps the tab's dot on the document it shows when another project's stage has the same tab", async () => {
    const { kind, actions } = setup({ "notes.md": "one\n" }, {}, { "/other": { "notes.md": "other\n" } });
    const tab = handle();
    render(<>{kind.render({ path: "notes.md" }, tab, actions, REPO)}</>);
    (await findEditor("notes.md")).replace("unsaved in repo\n");
    cleanup();
    render(<>{kind.render({ path: "notes.md" }, tab, actions, { workspace: "/other" })}</>);
    const other = await findEditor("notes.md");
    await waitFor(() => expect(other.text()).toBe("other\n"));
    expect(tab.dirty.at(-1)).toBe(false);
    other.replace("two\n");
    expect(tab.dirty.at(-1)).toBe(true);
    expect(tab.closers).toHaveLength(1);
    cleanup();
    // Back on the first project: its unsaved work is still there.
    render(<>{kind.render({ path: "notes.md" }, tab, actions, REPO)}</>);
    expect((await findEditor("notes.md")).text()).toBe("unsaved in repo\n");
  });

  it("reads and saves the file of the tab's project when two projects have the same path", async () => {
    const shown: StageTab = { kind: "extension", id: "ext:tau.files.editor:src/same.ts", preview: false, tabKind: FILE_EDITOR_TAB, params: { path: "src/same.ts" }, title: "same.ts", dirty: true };
    const { host, kind, registry, actions } = setup({}, {
      activeStageTab: () => shown,
      stageTabs: () => [shown],
      // The host still has project A open; project B is on screen.
      activeThread: () => ({ cwd: "/b", workspaceId: "ws-b", draftPending: true }),
    }, { "ws-a": { "src/same.ts": "a\n" }, "ws-b": { "src/same.ts": "b\n" } });
    render(<>{kind.render({ path: "src/same.ts" }, handle(), actions, { workspace: "ws-b" })}</>);
    const editor = await findEditor("src/same.ts");
    await waitFor(() => expect(editor.text()).toBe("b\n"));

    editor.replace("b, edited\n");
    // A project switch on the host keeps the buffer: it belongs to B whatever the host opens.
    registry.dispatchWorkbenchEvent({ type: "workspace-changed", from: "/a", to: "/c" });
    await registry.getCommand("files.save")!.run(actions);
    expect(host.writes).toEqual([{ workspace: "ws-b", relPath: "src/same.ts", text: "b, edited\n", expectedMtimeMs: 1_000 }]);
    await registry.getCommand("files.save-all")!.run(actions);
    expect(host.projects["ws-b"]).toEqual({ "src/same.ts": "b, edited\n" });
    expect(host.projects["ws-a"]).toEqual({ "src/same.ts": "a\n" });
  });

  it("neither opens nor saves a file whose project is unknown, and says so", async () => {
    const shown: StageTab = { kind: "extension", id: "ext:tau.files.editor:notes.md", preview: false, tabKind: FILE_EDITOR_TAB, params: { path: "notes.md" }, title: "notes.md", dirty: true };
    const { host, kind, registry, actions } = setup({ "notes.md": "one\n" }, {
      activeStageTab: () => shown,
      stageTabs: () => [shown],
      activeThread: () => ({ draftPending: false }),
    });
    render(<>{kind.render({ path: "notes.md" }, handle(), actions, {})}</>);
    expect(screen.getByRole("alert").textContent).toContain("Tau does not know which project this file belongs to.");
    expect(screen.queryByRole("button", { name: /^Save/u })).toBeNull();

    await registry.getCommand("files.save")!.run(actions);
    await registry.getCommand("files.save-all")!.run(actions);
    expect(actions.notify).toHaveBeenCalledWith("Not saved: Tau does not know which project this file belongs to.");
    expect(host.invoke).not.toHaveBeenCalled();
  });

  it("drops the buffer when its tab closes and takes the offer back when it goes away", async () => {
    const { registry, kind, actions, store, host } = setup({ "notes.md": "one\n" });
    const tab = handle();
    render(<>{kind.render({ path: "notes.md" }, tab, actions, REPO)}</>);
    (await findEditor("notes.md")).replace("unsaved\n");
    cleanup();
    tab.closers.forEach((close) => close());
    render(<>{kind.render({ path: "notes.md" }, handle(), actions, REPO)}</>);
    expect((await findEditor("notes.md")).text()).toBe("one\n");
    expect(host.invoke).toHaveBeenCalled();

    registry.deactivate(FILES_KIT_ID);
    store.edit("README.md", actions);
    expect(actions.openStageTab).not.toHaveBeenCalled();
  });

  it("edits on a tablet as on the desktop: the editor tab is drawn on a compact client", () => {
    const { registry } = createKitHarness(vi.fn(async () => undefined), "compact");
    registry.activate(filesExtension);
    expect(registry.getStageTabKinds().map((kind) => kind.kind)).toContain(FILE_EDITOR_TAB);
  });
});
