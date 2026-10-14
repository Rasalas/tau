// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiEditor, UiFileDiff } from "../../shared/workspace-kit-types";
import { createMemoryStorage } from "../../workbench/client-storage";
import type { Platform } from "../../workbench/platform";
import { ExtensionRegistry, type DocumentSourceContribution, type WorkbenchActions } from "../extension-system";
import { PlatformProvider } from "../platform-context";
import { installPointerEvents } from "../test-support/pointer-events";
import { WorkbenchContext, WorkbenchShellContext, type WorkbenchContextValue } from "../workbench-context";
import { WorkspaceResourceProvider } from "../workspace-resource-context";
import { Menu } from "../deferred-surfaces";
import { fileLinkPaths } from "./file-link-menu";
import { Markdown } from "./Markdown";
import { ContextMenuLayer } from "./ui/ContextMenu";

beforeAll(installPointerEvents);
afterEach(() => {
  // The page's menu is a module-level singleton: close one a test left open.
  screen.queryByRole("button", { name: "Close menu" })?.click();
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete document.body.dataset.profile;
});

const CODE: UiEditor = { id: "code", name: "VS Code" };
const FINDER: UiEditor = { id: "file-manager", name: "Finder" };
const ORIGIN = { sessionId: "thread", workspace: "ws-1", sourceId: "documents" };

function setPlatform(name: string) {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue(name);
}

interface Setup { open: ReturnType<typeof vi.fn>; openInEditor: ReturnType<typeof vi.fn>; writeText: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> }

function mount(markdown: string, state: { editor?: UiEditor; fileManager?: UiEditor } = { editor: CODE, fileManager: FINDER }, options: { local?: boolean; displayPath?: string } = {}): Setup {
  const openInEditor = vi.fn();
  const documents: DocumentSourceContribution = {
    id: "documents",
    loadFile: async (path) => ({ path, name: path, size: 0, kind: "text", text: "" }),
    loadDiff: async (path): Promise<UiFileDiff> => ({ path, added: 0, removed: 0, hunks: [] }),
    openInEditor,
    getState: () => ({ changes: { files: [], added: 0, removed: 0 }, ...state }),
    subscribe: () => () => undefined,
  };
  const registry = new ExtensionRegistry();
  registry.activate({ id: "test.documents", name: "Documents", activate: (plugin) => { plugin.registerDocumentSource(documents); } });
  const open = vi.fn();
  const value: WorkbenchContextValue = { registry, openFile: vi.fn(), openWorkspaceFile: open, tools: [], events: [], applySnapshot: vi.fn(), handleHostEvent: vi.fn() };
  const writeText = vi.fn(async () => undefined);
  const platform: Platform = { clipboard: { writeText }, openExternal: () => undefined, storage: createMemoryStorage(), importModule: async () => ({}) };
  const notify = vi.fn();
  render(<PlatformProvider platform={platform}>
    <WorkbenchShellContext.Provider value={{ registry, actions: { notify } as unknown as WorkbenchActions }}>
      <WorkbenchContext.Provider value={value}>
        <WorkspaceResourceProvider sessionId="thread" workspace="ws-1" displayPath={options.displayPath ?? "/host/project"} local={options.local ?? true}>
          <Markdown>{markdown}</Markdown>
        </WorkspaceResourceProvider>
      </WorkbenchContext.Provider>
    </WorkbenchShellContext.Provider>
    <ContextMenuLayer />
  </PlatformProvider>);
  return { open, openInEditor, writeText, notify };
}

const LINK = "See [the plan](docs/plan.md).";
const CHIP = "See `src/main/pi-host.ts`.";
const target = (kind: "link" | "chip") => kind === "link" ? screen.getByRole("link", { name: "the plan" }) : screen.getByRole("button", { name: "Open src/main/pi-host.ts" });
const sample = (kind: "link" | "chip") => kind === "link" ? { markdown: LINK, path: "docs/plan.md" } : { markdown: CHIP, path: "src/main/pi-host.ts" };

describe.each(["link", "chip"] as const)("a file %s in a reply", (kind) => {
  const { markdown, path } = sample(kind);

  beforeEach(() => setPlatform("MacIntel"));

  it("opens the file in Tau on a plain click", () => {
    const { open, openInEditor } = mount(markdown);
    fireEvent.click(target(kind));
    expect(open).toHaveBeenCalledWith(path, ORIGIN);
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("opens the editor on Cmd-click on macOS, and ignores Ctrl there", () => {
    const { open, openInEditor } = mount(markdown);
    fireEvent.click(target(kind), { ctrlKey: true });
    expect(open).toHaveBeenCalledTimes(1);
    fireEvent.click(target(kind), { metaKey: true });
    expect(openInEditor).toHaveBeenCalledTimes(1);
    expect(openInEditor).toHaveBeenCalledWith(path, { workspace: "ws-1", editorId: "code" });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("opens the editor on Ctrl-click elsewhere, and ignores Cmd there", () => {
    setPlatform("Win32");
    const { open, openInEditor } = mount(markdown);
    fireEvent.click(target(kind), { metaKey: true });
    expect(open).toHaveBeenCalledTimes(1);
    fireEvent.click(target(kind), { ctrlKey: true });
    expect(openInEditor).toHaveBeenCalledWith(path, { workspace: "ws-1", editorId: "code" });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("falls back to the plain click without an editor, and when the file manager is the only one", () => {
    const none = mount(markdown, {});
    fireEvent.click(target(kind), { metaKey: true });
    expect(none.open).toHaveBeenCalledTimes(1);
    expect(none.openInEditor).not.toHaveBeenCalled();
    cleanup();
    const manager = mount(markdown, { editor: FINDER, fileManager: FINDER });
    fireEvent.click(target(kind), { metaKey: true });
    expect(manager.open).toHaveBeenCalledTimes(1);
    expect(manager.openInEditor).not.toHaveBeenCalled();
  });

  it("offers open, editor, file manager and both paths in the context menu", async () => {
    const { open, openInEditor, writeText, notify } = mount(markdown);
    fireEvent.contextMenu(target(kind), { clientX: 10, clientY: 10 });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Open", "Open in VS Code", "Reveal in Finder", "Copy relative path", "Copy full path",
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open in VS Code" }));
    await vi.waitFor(() => expect(openInEditor).toHaveBeenLastCalledWith(path, { workspace: "ws-1", editorId: "code" }));

    fireEvent.contextMenu(target(kind), { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reveal in Finder" }));
    await vi.waitFor(() => expect(openInEditor).toHaveBeenLastCalledWith(path, { workspace: "ws-1", editorId: "file-manager" }));

    fireEvent.contextMenu(target(kind), { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy relative path" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith(path));
    await vi.waitFor(() => expect(notify).toHaveBeenLastCalledWith("Copied relative path"));

    fireEvent.contextMenu(target(kind), { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy full path" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith(`/host/project/${path}`));
    await vi.waitFor(() => expect(notify).toHaveBeenLastCalledWith("Copied full path"));

    fireEvent.contextMenu(target(kind), { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open" }));
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(path, ORIGIN));
  });

  it("reports a path it could not copy", async () => {
    const { writeText, notify } = mount(markdown);
    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.contextMenu(target(kind), { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy full path" }));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("Could not copy the full path: denied", "error"));
  });

  it.each([
    ["has no editor to offer", () => mount(markdown, {})],
    ["belongs to another machine", () => mount(markdown, { editor: CODE, fileManager: FINDER }, { local: false })],
  ])("leaves the editor and the file manager out when the thread %s", async (_reason, setup) => {
    setup();
    fireEvent.contextMenu(target(kind), { clientX: 10, clientY: 10 });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open", "Copy relative path", "Copy full path"]);
  });

  it("opens the menu from the keyboard under the element", async () => {
    mount(markdown);
    fireEvent.keyDown(target(kind), { key: "ContextMenu" });
    expect(await screen.findByRole("menu")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    await vi.waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.keyDown(target(kind), { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu")).toBeTruthy();
  });

  it("names the full path on hover", () => {
    mount(markdown);
    expect(kind === "link" ? target(kind).getAttribute("data-tooltip") : target(kind).querySelector("code")?.getAttribute("data-tooltip")).toBe(`/host/project/${path}`);
  });

  it("opens the menu on a long touch, without also opening the file", async () => {
    document.body.dataset.profile = "compact";
    const { open } = mount(markdown);
    // The touch screen's long press belongs to the menu, not to a tooltip.
    expect(document.querySelector("[data-tooltip]")).toBeNull();
    await Menu.preload();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.pointerDown(target(kind), { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 20 });
    await act(() => vi.advanceTimersByTimeAsync(500));
    await vi.waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    // The lifted finger and the browser's own context menu event add nothing.
    fireEvent.pointerUp(target(kind), { pointerType: "touch", pointerId: 1 });
    fireEvent.click(target(kind));
    fireEvent.contextMenu(target(kind), { clientX: 20, clientY: 20 });
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(open).not.toHaveBeenCalled();
  });

  it("does not open the menu when the finger moves or lifts early", async () => {
    mount(markdown);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.pointerDown(target(kind), { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(target(kind), { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 60 });
    await act(() => vi.advanceTimersByTimeAsync(600));
    fireEvent.pointerDown(target(kind), { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(target(kind), { pointerType: "touch", pointerId: 1 });
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("a path outside the thread's workspace", () => {
  beforeEach(() => setPlatform("MacIntel"));

  it("keeps the host's editor out and copies only the path it was given", async () => {
    const { open, openInEditor, writeText } = mount("See [notes](/elsewhere/notes.md).");
    fireEvent.click(screen.getByRole("link", { name: "notes" }), { metaKey: true });
    expect(openInEditor).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("/elsewhere/notes.md", ORIGIN);
    fireEvent.contextMenu(screen.getByRole("link", { name: "notes" }), { clientX: 10, clientY: 10 });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open", "Copy full path"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy full path" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("/elsewhere/notes.md"));
  });

  it("treats an absolute path inside the workspace like a relative one", () => {
    const { openInEditor } = mount("See [plan](/host/project/docs/plan.md).");
    fireEvent.click(screen.getByRole("link", { name: "plan" }), { metaKey: true });
    expect(openInEditor).toHaveBeenCalledWith("docs/plan.md", { workspace: "ws-1", editorId: "code" });
  });
});

describe("links that are not files", () => {
  it("leave web links and bare names alone", () => {
    mount("[site](https://example.com) and `package.json`");
    const site = screen.getByRole("link", { name: "site" });
    expect(site.getAttribute("target")).toBe("_blank");
    fireEvent.contextMenu(site, { clientX: 1, clientY: 1 });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("button", { name: /package\.json/u })).toBeNull();
  });
});

describe("fileLinkPaths", () => {
  it("names the relative and the full form of a path", () => {
    expect(fileLinkPaths("src/a.ts", "/host/project/")).toEqual({ relative: "src/a.ts", full: "/host/project/src/a.ts" });
    expect(fileLinkPaths("./src/a.ts", "/host/project")).toEqual({ relative: "src/a.ts", full: "/host/project/src/a.ts" });
    expect(fileLinkPaths("/host/project/src/a.ts", "/host/project")).toEqual({ relative: "src/a.ts", full: "/host/project/src/a.ts" });
    expect(fileLinkPaths("src/a.ts", "C:\\work\\app")).toEqual({ relative: "src/a.ts", full: "C:\\work\\app\\src\\a.ts" });
    expect(fileLinkPaths("src/a.ts", undefined)).toEqual({ relative: "src/a.ts" });
    expect(fileLinkPaths("/other/a.ts", "/host/project")).toEqual({ full: "/other/a.ts" });
    expect(fileLinkPaths("../docs/a.md", "/host/project")).toEqual({});
    expect(fileLinkPaths("https://example.com/a", "/host/project")).toEqual({});
  });
});
