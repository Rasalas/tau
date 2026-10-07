// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setHostClient } from "./host-client-context";
import { createMemoryStorage, setClientStorage } from "../workbench/client-storage";
import { dockStateKey, threadStageKey } from "../workbench/storage-keys";
import { stageOwner } from "../workbench/thread-stages";
import { createNewThreadDraft, writeNewThreadDraft } from "../workbench/draft-store";
import type { UiFileContent } from "../shared/workspace-kit-types";
import type { DesktopExtension, DocumentOrigin, WorkbenchActions } from "./extension-system";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { renderApp } from "./test-support/render-app";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

function projectClient() {
  return createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [], sessions: [] },
      detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
      catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
      project: { cwd: "/project" },
    }),
  });
}

describe("App layout restore", () => {
  it("keeps the tool last picked in a project while its kit has not activated yet", async () => {
    const storage = createMemoryStorage();
    storage.set(dockStateKey("/project"), JSON.stringify({ open: true, activePanel: "late", openedPanels: ["early", "late"] }));
    let arrive: (() => void) | undefined;
    const early: DesktopExtension = {
      id: "test.early", name: "Early",
      activate: (plugin) => { plugin.registerPanel({ id: "early", label: "Early", order: 1, Component: () => <div>early panel</div> }); },
    };
    // Kits activate one after another; this one's panel arrives when the test says so.
    const late: DesktopExtension = {
      id: "test.late", name: "Late",
      activate: (plugin) => { arrive = () => { plugin.registerPanel({ id: "late", label: "Late", order: 2, Component: () => <div>late panel</div> }); }; },
    };

    renderApp(projectClient(), { storage, extensions: [early, late] });
    await screen.findByRole("button", { name: "Send" });
    // The stand-in shown meanwhile is never written back: the tool last picked stays the late kit's.
    await waitFor(() => expect(JSON.parse(storage.get(dockStateKey("/project")) ?? "{}")).toMatchObject({ activePanel: "late" }));
    act(() => arrive?.());
    await waitFor(() => expect(JSON.parse(storage.get(dockStateKey("/project")) ?? "{}")).toMatchObject({ activePanel: "late" }));
  });
});

describe("App stage restore across a restart", () => {
  const projectB = { path: "/project-b", workspaceId: "ws-b", name: "project-b", lastOpenedAt: 1 };

  /** The host came back on project A; the window was left on a draft of project B with one of B's files open. */
  function restartedOnAnotherProject() {
    const storage = createMemoryStorage();
    const draft = createNewThreadDraft({ projectPath: projectB.path, workspaceId: projectB.workspaceId, projectName: projectB.name });
    writeNewThreadDraft(storage, draft);
    const tab = { id: "file:src/only-in-b.ts", kind: "file", path: "src/only-in-b.ts", view: "source", preview: false };
    const key = threadStageKey(stageOwner(undefined, draft)!);
    storage.set(key, JSON.stringify({ tabs: [tab], activeId: tab.id }));
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [projectB], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
        project: { cwd: "/project-a", workspaceId: "ws-a" },
      }),
    });
    return { storage, client, key };
  }

  /** A source that reads like Workspace Kit's host: the named project, or the host's own when none is named. */
  function documents(files: Record<string, Record<string, string>>, loads: Array<{ path: string; from?: DocumentOrigin }>): DesktopExtension {
    const state = { changes: { isRepo: true, files: [] } };
    return {
      id: "test.documents", name: "Documents",
      activate: (plugin) => {
        plugin.registerDocumentSource({
          id: "test.documents",
          loadFile: async (path, from) => {
            loads.push({ path, ...(from ? { from } : {}) });
            const workspace = from?.workspace ?? "ws-a";
            const text = files[workspace]?.[path];
            if (text === undefined) throw new Error(`ENOENT: no such file or directory, stat '/${workspace}/${path}'`);
            return { path, name: path.split("/").at(-1) ?? path, size: text.length, kind: "text", text } satisfies UiFileContent;
          },
          loadDiff: async (path) => ({ path, added: 0, removed: 0, hunks: [] }),
          openInEditor: () => undefined,
          getState: () => state as never,
          subscribe: () => () => undefined,
        });
      },
    };
  }

  it("reads a restored file tab from the draft's project, not the one the host opened", async () => {
    const { storage, client } = restartedOnAnotherProject();
    const loads: Array<{ path: string; from?: DocumentOrigin }> = [];
    renderApp(client, { storage, extensions: [documents({ "ws-b": { "src/only-in-b.ts": "export const b = 1;\n" } }, loads)] });

    await screen.findByText("export const b = 1;");
    expect(loads.at(-1)).toEqual({ path: "src/only-in-b.ts", from: { workspace: "ws-b" } });
    expect(screen.queryByText(/ENOENT/u)).toBeNull();
  });

  it("says a restored file is not found, with its path and a way to close it", async () => {
    const { storage, client, key } = restartedOnAnotherProject();
    renderApp(client, { storage, extensions: [documents({ "ws-b": {} }, [])] });

    await screen.findByText("File not found");
    expect(screen.queryByText(/ENOENT/u)).toBeNull();
    expect(screen.getAllByText("src/only-in-b.ts").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText("File not found")).toBeNull());
    await waitFor(() => expect(JSON.parse(storage.get(key) ?? "{}")).toMatchObject({ tabs: [], closed: [{ tab: { kind: "file", path: "src/only-in-b.ts" } }] }));
  });
});

describe("App stage per thread", () => {
  const projectA = { path: "/project-a", workspaceId: "ws-a", name: "project-a", lastOpenedAt: 2 };
  const projectB = { path: "/project-b", workspaceId: "ws-b", name: "project-b", lastOpenedAt: 1 };
  const threadOf = (id: string, project: typeof projectA, modifiedAt: number) => ({
    id, path: `/sessions/${id}.jsonl`, title: id, modifiedAt, projectPath: project.path, workspaceId: project.workspaceId, projectName: project.name, messageCount: 1,
  });
  const sessions = [threadOf("a1", projectA, 3), threadOf("a2", projectA, 2), threadOf("b1", projectB, 1)];
  const projectOf = (id: string) => (id === "b1" ? projectB : projectA);

  /** A host with two threads in project A and one in B; switching answers with the thread and its project. */
  function twoProjects(storage = createMemoryStorage()) {
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [projectA, projectB], sessions },
        detail: { sessionId: "a1", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "a1", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
        project: { cwd: projectA.path, workspaceId: projectA.workspaceId },
      }),
      switchSession: async (path: string) => {
        const id = sessions.find((session) => session.path === path)!.id;
        const project = projectOf(id);
        return { version: 1 as const, updates: [
          { version: 1 as const, type: "project" as const, project: { cwd: project.path, workspaceId: project.workspaceId } },
          { version: 1 as const, type: "thread-detail" as const, detail: { sessionId: id, messages: [], isStreaming: false, activeTools: [] } },
        ] };
      },
    });
    return { storage, client };
  }

  /** Files of both projects, a note kind, and a panel that hands the test the workbench's actions. */
  function kit(loads: Array<{ path: string; from?: DocumentOrigin }>, got: { actions?: WorkbenchActions }): DesktopExtension {
    const files: Record<string, Record<string, string>> = { "ws-a": { "src/x.ts": "from A\n" }, "ws-b": { "src/x.ts": "from B\n" } };
    const state = { changes: { isRepo: true, files: [] } };
    return {
      id: "test.kit", name: "Kit",
      activate: (plugin) => {
        plugin.registerDocumentSource({
          id: "test.documents",
          loadFile: async (path, from) => {
            loads.push({ path, ...(from ? { from } : {}) });
            const text = files[from?.workspace ?? "ws-a"]![path]!;
            return { path, name: "x.ts", size: text.length, kind: "text", text } satisfies UiFileContent;
          },
          loadDiff: async (path) => ({ path, added: 0, removed: 0, hunks: [] }),
          openInEditor: () => undefined,
          getState: () => state as never,
          subscribe: () => () => undefined,
        });
        plugin.registerStageTab<{ name: string }>({
          kind: "test.note", title: (params) => `Note ${params.name}`,
          render: (params, _handle, _actions, from) => <p>note {params.name} in {from?.workspace}</p>,
        });
        plugin.registerRegion({ id: "test.grab", placement: "composer-below", Component: ({ actions }) => { got.actions = actions; return null; } });
      },
    };
  }

  async function start(storage?: ReturnType<typeof createMemoryStorage>) {
    const { client, storage: kept } = twoProjects(storage);
    const loads: Array<{ path: string; from?: DocumentOrigin }> = [];
    const got: { actions?: WorkbenchActions } = {};
    renderApp(client, { storage: kept, extensions: [kit(loads, got)] });
    await screen.findByRole("button", { name: "Send" });
    await waitFor(() => expect(got.actions?.activeThread()?.sessionId).toBe("a1"));
    const actions = () => got.actions!;
    const show = async (id: string) => {
      await act(async () => { await actions().switchSession(`/sessions/${id}.jsonl`); });
      await waitFor(() => expect(actions().activeThread()?.sessionId).toBe(id));
    };
    return { storage: kept, loads, actions, show };
  }

  it("brings the chat back beside a maximized stage when a thread's row is clicked, its own or another's", async () => {
    const { actions, show } = await start();
    act(() => { actions().openStageTab("test.note", { name: "alpha" }); });
    await screen.findByText("note alpha in ws-a");
    const center = () => document.querySelector(".workbench-center")?.className ?? "";
    const maximize = () => fireEvent.click(within(screen.getByRole("region", { name: "Stage" })).getByRole("button", { name: "Maximize stage" }));

    maximize();
    expect(center()).toContain("conversation-folded");
    // No strip of its own for the folded chat: the stage has the centre.
    expect(screen.queryByRole("navigation", { name: "Conversation" })).toBeNull();
    await show("a1");
    await waitFor(() => expect(center()).not.toContain("conversation-folded"));
    expect(center()).toContain("stage-open");
    expect(screen.getByText("note alpha in ws-a")).toBeTruthy();

    maximize();
    await show("a2");
    await show("a1");
    await screen.findByText("note alpha in ws-a");
    expect(center()).toContain("stage-open");
    expect(center()).not.toContain("conversation-folded");
  });

  it("shows each thread's own tabs again after A → B → A, and a new draft starts empty", async () => {
    const { actions, show } = await start();
    act(() => { actions().openStageTab("test.note", { name: "alpha" }); });
    await screen.findByText("note alpha in ws-a");

    await show("a2");
    await waitFor(() => expect(screen.queryByText("note alpha in ws-a")).toBeNull());
    act(() => { actions().openStageTab("test.note", { name: "beta" }); });
    await screen.findByText("note beta in ws-a");

    await show("a1");
    await screen.findByText("note alpha in ws-a");
    expect(screen.queryByText(/note beta/u)).toBeNull();

    // Named, so no picker asks first (K98).
    act(() => { actions().newSession({ workspace: "ws-a" }); });
    await waitFor(() => expect(screen.queryByText(/note alpha/u)).toBeNull());
    await show("a1");
    await screen.findByText("note alpha in ws-a");
  });

  it("reads each thread's file tab in that thread's project, across a restart", async () => {
    const first = await start();
    act(() => { first.actions().openFile("src/x.ts", { pin: true }); });
    await screen.findByText("from A");
    await first.show("b1");
    await waitFor(() => expect(screen.queryByText("from A")).toBeNull());
    act(() => { first.actions().openFile("src/x.ts", { pin: true }); });
    await screen.findByText("from B");
    expect(first.loads.at(-1)).toEqual({ path: "src/x.ts", from: { workspace: "ws-b" } });
    await first.show("a1");
    await screen.findByText("from A");
    expect(first.loads.at(-1)).toEqual({ path: "src/x.ts", from: { workspace: "ws-a" } });
    cleanup();

    // The host comes back on a1; b1 still has B's file.
    const again = await start(first.storage);
    await screen.findByText("from A");
    await again.show("b1");
    await screen.findByText("from B");
    expect(again.loads.at(-1)).toEqual({ path: "src/x.ts", from: { workspace: "ws-b" } });
  });
});
