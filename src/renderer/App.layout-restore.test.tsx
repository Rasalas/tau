// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setHostClient } from "./host-client-context";
import { createMemoryStorage, setClientStorage } from "../workbench/client-storage";
import { dockStateKey, stageStateKey } from "../workbench/storage-keys";
import { createNewThreadDraft, writeNewThreadDraft } from "../workbench/draft-store";
import type { UiFileContent } from "../shared/workspace-kit-types";
import type { DesktopExtension, DocumentOrigin } from "./extension-system";
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
  it("keeps a restored dock panel whose kit offers it after another kit's panel", async () => {
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
    await screen.findByRole("button", { name: "Early" });
    await screen.findByRole("button", { name: "Send" });
    act(() => arrive?.());

    const lateButton = await screen.findByRole("button", { name: "Late" });
    await waitFor(() => expect(lateButton.getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByRole("button", { name: "Early" }).getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(JSON.parse(storage.get(dockStateKey("/project")) ?? "{}")).toMatchObject({ activePanel: "late" }));
  });
});

describe("App stage restore across a restart", () => {
  const projectB = { path: "/project-b", workspaceId: "ws-b", name: "project-b", lastOpenedAt: 1 };

  /** The host came back on project A; the window was left on a draft of project B with one of B's files open. */
  function restartedOnAnotherProject() {
    const storage = createMemoryStorage();
    writeNewThreadDraft(storage, createNewThreadDraft({ projectPath: projectB.path, workspaceId: projectB.workspaceId, projectName: projectB.name }));
    const tab = { id: "file:src/only-in-b.ts", kind: "file", path: "src/only-in-b.ts", view: "source", preview: false };
    storage.set(stageStateKey(projectB.workspaceId), JSON.stringify({ tabs: [tab], activeId: tab.id }));
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [projectB], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
        project: { cwd: "/project-a", workspaceId: "ws-a" },
      }),
    });
    return { storage, client };
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
    const { storage, client } = restartedOnAnotherProject();
    renderApp(client, { storage, extensions: [documents({ "ws-b": {} }, [])] });

    await screen.findByText("File not found");
    expect(screen.queryByText(/ENOENT/u)).toBeNull();
    expect(screen.getAllByText("src/only-in-b.ts").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText("File not found")).toBeNull());
    await waitFor(() => expect(storage.get(stageStateKey(projectB.workspaceId))).toBeNull());
  });
});
