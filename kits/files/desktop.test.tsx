// @vitest-environment jsdom
import { language } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StageTab, StageTabHandle, UiEditor, UiFileContent, UiFileWriteResult, WorkbenchActions } from "tau";
import { createKitHarness, createMemoryStorage, setClientStorage } from "../../src/renderer/test-support/kit-harness.js";
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
  vi.useRealTimers();
});

/** Files Kit's host, answering from a map of paths; `mtime` moves on every write. */
function fakeHost(files: Record<string, string>) {
  let mtimeMs = 1_000;
  const writes: Array<{ relPath: string; text: string; expectedMtimeMs?: number | null }> = [];
  const invoke = vi.fn(async (extensionId: string, command: string, input?: unknown): Promise<unknown> => {
    if (extensionId !== FILES_KIT_ID) return undefined;
    const { relPath, text, expectedMtimeMs } = input as { relPath: string; text?: string; expectedMtimeMs?: number | null };
    if (command === "read") {
      const body = files[relPath];
      if (body === undefined) throw new Error("Not a file.");
      return { path: `/repo/${relPath}`, name: relPath.split("/").at(-1) ?? relPath, size: body.length, mtimeMs, kind: "text", text: body, language: relPath.endsWith(".ts") ? "typescript" : undefined } satisfies UiFileContent;
    }
    if (command === "stat") return files[relPath] === undefined ? { exists: false } : { exists: true, size: files[relPath]!.length, mtimeMs };
    if (command === "write") {
      writes.push({ relPath, text: text!, ...(expectedMtimeMs !== undefined ? { expectedMtimeMs } : {}) });
      if (expectedMtimeMs !== undefined && expectedMtimeMs !== mtimeMs) return { status: "conflict", size: 1, mtimeMs } satisfies UiFileWriteResult;
      files[relPath] = text!;
      mtimeMs += 1;
      return { status: "written", size: text!.length, mtimeMs } satisfies UiFileWriteResult;
    }
    return undefined;
  });
  return {
    invoke,
    writes,
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

function setup(files: Record<string, string>, actionsPatch: Partial<WorkbenchActions> = {}) {
  const host = fakeHost(files);
  const { registry, preferences } = createKitHarness(host.invoke);
  const store = workspaceStore();
  registry.activate(filesExtension);
  registry.activate({ id: "test.workspace", name: "Workspace stand-in", activate: (context) => { context.provideService(WORKSPACE_STORE_SERVICE, store); } });
  const kind = registry.getStageTabKind(FILE_EDITOR_TAB)!;
  const actions = { notify: vi.fn(), closeStageTab: vi.fn(), openStageTab: vi.fn(() => "tab"), ...actionsPatch } as unknown as WorkbenchActions;
  return { host, registry, preferences, store, kind, actions };
}

describe("Files Kit", () => {
  it("edits a file, marks the tab dirty and saves on mod+s before the stash binding hears it", async () => {
    const tab = handle();
    const shown: StageTab = { kind: "extension", id: tab.id, preview: false, tabKind: FILE_EDITOR_TAB, params: { path: "notes.md" }, title: "notes.md" };
    const { host, kind, actions, store, registry } = setup({ "notes.md": "# Notes\n" }, { activeStageTab: () => shown });
    render(<>{kind.render({ path: "notes.md" }, tab, actions)}</>);
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
    render(<>{kind.render({ path: "notes.md" }, tab, actions)}</>);
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
    render(<>{kind.render({ path: "notes.md" }, handle(), actions)}</>);
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
    render(<>{kind.render({ path: "src/a.ts" }, handle(), actions)}</>);
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
    render(<>{kind.render({ path: "src/a.ts" }, handle(), actions)}</>);
    const editor = await findEditor("src/a.ts");
    expect(editor.content.classList.contains("cm-lineWrapping")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Enable word wrap" }));
    await waitFor(() => expect(editor.content.classList.contains("cm-lineWrapping")).toBe(true));
    expect(screen.getByRole("button", { name: "Disable word wrap" }).getAttribute("aria-pressed")).toBe("true");
    expect(preferences.optionValue(FILES_KIT_ID, "wordWrap", false)).toBe(true);
  });

  it("opens on the line it was asked for, with the TypeScript mode", async () => {
    const { kind, actions } = setup({ "src/a.ts": "const a = 1;\nconst b = 2;\nfunction c() {\n  return 3;\n}\n" });
    render(<>{kind.render({ path: "src/a.ts", line: 3 }, handle(), actions)}</>);
    const editor = await findEditor("src/a.ts");
    await waitFor(() => expect(editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number).toBe(3));
    await waitFor(() => expect(editor.view.state.facet(language)?.name).toBe("typescript"));
  });

  it("shows Markdown rendered or as source, and remembers the choice", async () => {
    setClientStorage(createMemoryStorage());
    const { kind, actions } = setup({ "README.md": "# Title\n\nSome *text*.\n" });
    render(<>{kind.render({ path: "README.md" }, handle(), actions)}</>);
    await screen.findByLabelText("Contents of README.md");
    fireEvent.click(screen.getByRole("button", { name: "Show rendered markdown" }));
    expect(await screen.findByRole("heading", { name: "Title" })).toBeTruthy();
    expect(screen.queryByLabelText("Contents of README.md")).toBeNull();
    cleanup();
    render(<>{kind.render({ path: "README.md" }, handle(), actions)}</>);
    expect(await screen.findByRole("heading", { name: "Title" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show markdown source" }));
    expect(await screen.findByLabelText("Contents of README.md")).toBeTruthy();
  });

  it("draws a CSV as a table and an HTML page in a frame that runs nothing", async () => {
    const { kind, actions } = setup({ "data.csv": "name,age\nAda,36\n", "page.html": "<h1>Hi</h1>" });
    render(<>{kind.render({ path: "data.csv" }, handle(), actions)}</>);
    expect(await screen.findByRole("table", { name: "data.csv" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "age" })).toBeTruthy();
    cleanup();
    render(<>{kind.render({ path: "page.html" }, handle(), actions)}</>);
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
    render(<>{kind.render({ path: "docs/paper.pdf" }, handle(), actions)}</>);
    const frame = await screen.findByTitle("paper.pdf");
    expect(frame.getAttribute("src")).toBe("tau-ext://files/abc/paper.pdf#toolbar=0&view=FitH");
    expect(shareFile).toHaveBeenCalledWith("/repo/docs/paper.pdf");
    cleanup();
    render(<>{kind.render({ path: "logo.png" }, handle(), actions)}</>);
    expect((await screen.findByRole("img", { name: "logo.png" })).getAttribute("src")).toBe("tau-ext://files/abc/logo.png");
    expect(host.invoke.mock.calls.filter(([, command]) => command === "read")).toEqual([]);
  });

  it("offers every installed editor and reveals in the file manager without making it the default", async () => {
    const { kind, actions, store } = setup({ "src/a.ts": "const a = 1;\n" });
    render(<>{kind.render({ path: "src/a.ts" }, handle(), actions)}</>);
    await screen.findByLabelText("Contents of src/a.ts");
    fireEvent.click(screen.getByRole("button", { name: "Choose editor" }));
    expect(screen.getByText("VS Code", { selector: ".menu *" })).toBeTruthy();
    fireEvent.click(screen.getByText("Reveal in Finder"));
    await waitFor(() => expect(store.opened.at(-1)).toEqual(["src/a.ts", "file-manager", undefined]));
    expect(store.chooseEditor).not.toHaveBeenCalled();
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

  it("keeps the tab's dot on the document it shows after the documents were dropped", async () => {
    const { registry, kind, actions } = setup({ "notes.md": "one\n" });
    const tab = handle();
    render(<>{kind.render({ path: "notes.md" }, tab, actions)}</>);
    await screen.findByLabelText("Contents of notes.md");
    registry.dispatchWorkbenchEvent({ type: "workspace-changed", from: "/repo", to: "/other" });
    cleanup();
    render(<>{kind.render({ path: "notes.md" }, tab, actions)}</>);
    (await findEditor("notes.md")).replace("two\n");
    expect(tab.dirty.at(-1)).toBe(true);
    expect(tab.closers).toHaveLength(1);
  });

  it("drops the buffer when its tab closes and takes the offer back when it goes away", async () => {
    const { registry, kind, actions, store, host } = setup({ "notes.md": "one\n" });
    const tab = handle();
    render(<>{kind.render({ path: "notes.md" }, tab, actions)}</>);
    (await findEditor("notes.md")).replace("unsaved\n");
    cleanup();
    tab.closers.forEach((close) => close());
    render(<>{kind.render({ path: "notes.md" }, handle(), actions)}</>);
    expect((await findEditor("notes.md")).text()).toBe("one\n");
    expect(host.invoke).toHaveBeenCalled();

    registry.deactivate(FILES_KIT_ID);
    store.edit("README.md", actions);
    expect(actions.openStageTab).not.toHaveBeenCalled();
  });
});
