// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiFileContent, UiFileDiff } from "../shared/workspace-kit-types";
import { EMPTY_STAGE, openFileTab, type WorkspaceResourceOrigin } from "../workbench/stage";
import { decodeStageState } from "../workbench/workbench-layout-state";
import { ExtensionRegistry, type DocumentSourceContribution } from "./extension-system";
import { WorkbenchContext, ThreadStoreContext, type WorkbenchContextValue } from "./workbench-context";
import { WorkspaceResourceProvider, bindWorkspaceFileLoader, transcriptFilePath, resourceRelativePath, useWorkspaceResources, type WorkspaceResources } from "./workspace-resource-context";
import { HostClientProvider } from "./host-client-context";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { ThreadStore } from "../workbench/thread-store";
import { TestProviders } from "./test-support/test-providers";
import { ThreadDocument } from "./components/ThreadDocument";
import { RemoteThreadDocument } from "./components/RemoteThreadDocument";
import { PlatformProvider } from "./platform-context";
import type { Platform } from "../workbench/platform";
import { WorkspaceFileSheet } from "./touch/WorkspaceFileSheet";

afterEach(cleanup);
const path = ".scratch/mobile-transcript-images/issues/01-render-workspace-screenshots-on-mobile.md";
const origin: WorkspaceResourceOrigin = { sessionId: "history", workspace: "ws-history", sourceId: "documents" };
function content(text: string): UiFileContent { return { path, name: "fixture.md", size: text.length, kind: "text", text }; }
function source(loadFile: DocumentSourceContribution["loadFile"]): DocumentSourceContribution {
  const state = { changes: { files: [], added: 0, removed: 0 } };
  return { id: "documents", loadFile, loadDiff: async (relativePath): Promise<UiFileDiff> => ({ path: relativePath, added: 0, removed: 0, hunks: [] }), openInEditor: () => undefined, getState: () => state, subscribe: () => () => undefined };
}
function context(documentSource: DocumentSourceContribution) {
  const registry = new ExtensionRegistry();
  registry.activate({ id: "test.resources", name: "Resources", activate: (plugin) => { plugin.registerDocumentSource(documentSource); } });
  const open = vi.fn();
  const value: WorkbenchContextValue = { registry, openFile: vi.fn(), openWorkspaceFile: open, tools: [], events: [], applySnapshot: vi.fn(), handleHostEvent: vi.fn() };
  return { value, open };
}
let captured: WorkspaceResources | undefined;
function Probe() { captured = useWorkspaceResources(); return <button onClick={() => captured?.openFile(path)}>Open resource</button>; }

describe("transcript-bound workspace resource contract", () => {
  it("normalizes only host paths contained in the transcript's announced root", () => {
    expect(transcriptFilePath("/history/src/same.ts", "/history/")).toBe("src/same.ts");
    expect(transcriptFilePath("C:\\history\\src\\same.ts", "C:\\history")).toBe("src/same.ts");
    for (const [candidate, root] of [["/history-other/src/same.ts", "/history"], ["/active/src/same.ts", "/history"], ["/history/../secret.ts", "/history"], ["/history/src/same.ts", undefined]] as const) {
      expect(() => transcriptFilePath(candidate, root)).toThrow();
    }
    expect(() => resourceRelativePath("/history/src/same.ts")).toThrow();
  });
  it("binds same relative path to two distinct opaque workspaces and captures sources", async () => {
    const loadA = vi.fn(async (_path, from) => content(`file in ${from?.workspace}`));
    const firstSource = source(loadA);
    const a = bindWorkspaceFileLoader(firstSource, { ...origin, workspace: "opaque-a" });
    const b = bindWorkspaceFileLoader(firstSource, { ...origin, workspace: "opaque-b" });
    expect(await a(path)).toMatchObject({ text: "file in opaque-a" });
    expect(await b(path)).toMatchObject({ text: "file in opaque-b" });
    expect(loadA.mock.calls.map((call) => call[1])).toEqual([{ workspace: "opaque-a" }, { workspace: "opaque-b" }]);
    await expect(bindWorkspaceFileLoader(source(vi.fn()), { ...origin, sourceId: "other-source" })(path)).rejects.toThrow("unavailable");
    await expect(bindWorkspaceFileLoader(firstSource, undefined)(path)).rejects.toThrow("unavailable");
    await Promise.all(["../outside.md", "/host/secret.md", "C:/secret.md", "escape\\secret.md"].map((bad) => expect(a(bad)).rejects.toThrow("inside the thread")));
    expect(loadA).toHaveBeenCalledTimes(2);
  });

  it.each(["thread", "host"])("invalidates delayed results and retained open callbacks after %s navigation", async (navigation) => {
    let resolve!: (file: UiFileContent) => void;
    const load = vi.fn(() => new Promise<UiFileContent>((done) => { resolve = done; }));
    const { value, open } = context(source(load));
    const clientA = createFakeHostClient();
    const clientB = createFakeHostClient();
    function Tree({ workspace, client }: { workspace: string; client: typeof clientA }) {
      return <HostClientProvider client={client}><WorkbenchContext.Provider value={value}><WorkspaceResourceProvider sessionId="thread" workspace={workspace}><Probe /></WorkspaceResourceProvider></WorkbenchContext.Provider></HostClientProvider>;
    }
    const view = render(<Tree workspace="opaque-a" client={clientA} />);
    const old = captured!;
    const pending = old.loadFile(path);
    const rejected = expect(pending).rejects.toThrow("unavailable");
    const nextWorkspace = navigation === "thread" ? "opaque-b" : "opaque-a";
    view.rerender(<Tree workspace={nextWorkspace} client={navigation === "host" ? clientB : clientA} />);
    resolve(content("late wrong file"));
    await rejected;
    old.openFile(path);
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open resource" }));
    expect(open).toHaveBeenCalledWith(path, { sessionId: "thread", workspace: nextWorkspace, sourceId: "documents" });
    await expect(old.loadFile(path)).rejects.toThrow("unavailable");
    expect(load).toHaveBeenCalledWith(path, { workspace: "opaque-a" });
  });

  it("preserves separate file-tab origins through persistence, and malformed origins fail closed", () => {
    let stage = openFileTab(EMPTY_STAGE, path, { pin: true, resourceOrigin: origin });
    stage = openFileTab(stage, path, { pin: true, resourceOrigin: { ...origin, workspace: "ws-other" } });
    const restored = decodeStageState(JSON.parse(JSON.stringify(stage)));
    expect(restored.tabs).toHaveLength(2);
    expect(restored.tabs.map((tab) => tab.kind === "file" && tab.resourceOrigin?.workspace)).toEqual(["ws-history", "ws-other"]);
    expect(decodeStageState({ tabs: [{ ...stage.tabs[0], resourceOrigin: { workspace: "ws-history" } }] }).tabs[0]).toMatchObject({ resourceOrigin: null });
    expect(decodeStageState({ tabs: [{ id: "file:legacy", kind: "file", preview: false, path: "legacy.md", view: "source" }] }).tabs).toHaveLength(1);
    const legacy = openFileTab(EMPTY_STAGE, path, { pin: true });
    const opened = openFileTab(legacy, path, { resourceOrigin: origin, localWorkspace: origin.workspace });
    expect(opened.tabs).toHaveLength(1);
    expect(opened.tabs[0]).toMatchObject({ resourceOrigin: origin });
    expect(openFileTab(opened, path).tabs).toHaveLength(1);
    expect(openFileTab(opened, path, { resourceOrigin: null }).tabs).toHaveLength(2);
  });

  it("discards a phone reader's late source result after connection replacement", async () => {
    let resolve!: (file: UiFileContent) => void;
    const first = source(() => new Promise<UiFileContent>((done) => { resolve = done; }));
    const second = source(async () => content("new host readable file"));
    const tab = openFileTab(EMPTY_STAGE, path, { resourceOrigin: origin }).tabs[0];
    if (tab.kind !== "file") throw new Error("fixture");
    const clientA = createFakeHostClient();
    const view = render(<HostClientProvider client={clientA}><WorkspaceFileSheet tab={tab} source={first} onClose={() => undefined} /></HostClientProvider>);
    await screen.findByText("Loading…");
    view.rerender(<HostClientProvider client={createFakeHostClient()}><WorkspaceFileSheet tab={tab} source={second} onClose={() => undefined} /></HostClientProvider>);
    await screen.findByText("new host readable file");
    await act(async () => { resolve(content("late old host file")); });
    await waitFor(() => expect(screen.queryByText("late old host file")).toBeNull());
  });
});

function thread(id: string, workspaceId: string) { return { id, workspaceId, path: `/fixture/${id}`, title: "History", projectPath: "/fixture", projectName: "fixture", modifiedAt: 1, messageCount: 1 }; }
function messages() { return [{ id: "answer", role: "assistant" as const, text: `\`${path}\``, timestamp: 1 }]; }

describe("historical transcript resource origin", () => {
  it.each([true, false])("ThreadDocument never falls back to the active workspace, indexed origin=%s", async (knownOrigin) => {
    const store = new ThreadStore();
    store.applyThreadIndex({ projects: [], sessions: [{ ...thread("history", "ws-history"), workspaceId: knownOrigin ? "ws-history" : undefined }] });
    const { value, open } = context(source(async () => content("history")));
    render(<TestProviders><ThreadStoreContext.Provider value={store}><WorkbenchContext.Provider value={value}>
      <WorkspaceResourceProvider sessionId="active" workspace="ws-active"><ThreadDocument sessionId="history" loadThread={async () => messages()} onTakeOver={() => undefined} /></WorkspaceResourceProvider>
    </WorkbenchContext.Provider></ThreadStoreContext.Provider></TestProviders>);
    fireEvent.click(await screen.findByRole("button", { name: `Open ${path}` }));
    expect(open).toHaveBeenCalledWith(path, knownOrigin ? origin : null);
  });

  it.each([true, false])("RemoteThreadDocument uses the indexed home workspace, available=%s", async (indexed) => {
    const store = new ThreadStore();
    store.applyThreadIndex({ projects: [], sessions: indexed ? [{ ...thread("peer~history", "ws-peer"), backendKind: "machine", machine: { id: "peer", name: "Peer" } }] : [] });
    const { value, open } = context(source(async () => content("peer")));
    const platform = { environments: {
      getSnapshot: () => ({ shown: "local", secureStorage: false, environments: [] }), subscribe: () => () => undefined,
      watchThread: (_machine: string, _session: string, listener: (view: unknown) => void) => {
        queueMicrotask(() => listener({ machine: "peer", sessionId: "history", machineName: "Peer", status: "connected", indexed: true, revision: 1, thread: { title: "Peer history", path: "/peer/history", projectName: "peer", modifiedAt: 1, messageCount: 1, running: false } }));
        return () => undefined;
      }, transcriptPage: async () => ({ sessionId: "history", messages: messages(), hasMore: false }),
    } } as unknown as Platform;
    render(<TestProviders><PlatformProvider platform={platform}><ThreadStoreContext.Provider value={store}><WorkbenchContext.Provider value={value}>
      <WorkspaceResourceProvider sessionId="active" workspace="ws-active"><RemoteThreadDocument machine="peer" sessionId="history" /></WorkspaceResourceProvider>
    </WorkbenchContext.Provider></ThreadStoreContext.Provider></PlatformProvider></TestProviders>);
    fireEvent.click(await screen.findByRole("button", { name: `Open ${path}` }));
    expect(open).toHaveBeenCalledWith(path, indexed ? { sessionId: "peer~history", workspace: "ws-peer", sourceId: "documents" } : null);
  });
});
