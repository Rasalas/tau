// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import type { UiFileContent, UiFileWriteResult } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import {
  createMemoryStorage, createNewThreadDraft, setClientStorage, setHostClient, stageOwner, threadStageKey, writeNewThreadDraft,
} from "../../src/renderer/test-support/kit-harness.js";
import filesExtension from "./desktop.js";
import { FILE_EDITOR_TAB, FILES_KIT_ID } from "./protocol.js";

// jsdom lays out no text; CodeMirror measures it anyway.
Range.prototype.getClientRects ??= function getClientRects() { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect ??= function getBoundingClientRect() { return new DOMRect(); };

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

const PATH = "src/same.ts";
const projectB = { path: "/project-b", workspaceId: "ws-b", name: "project-b", lastOpenedAt: 1 };

/**
 * The host came back on project A; the window was left on a draft of project
 * B with B's copy of a path both projects have open in the editor.
 */
function restartedOnAnotherProject() {
  const storage = createMemoryStorage();
  const draft = createNewThreadDraft({ projectPath: projectB.path, workspaceId: projectB.workspaceId, projectName: projectB.name });
  writeNewThreadDraft(storage, draft);
  const tab = { id: `ext:${FILE_EDITOR_TAB}:${PATH}`, kind: "extension", tabKind: FILE_EDITOR_TAB, params: { path: PATH }, title: "same.ts", preview: false };
  storage.set(threadStageKey(stageOwner(undefined, draft)!), JSON.stringify({ tabs: [tab], activeId: tab.id }));

  const disk: Record<string, Record<string, string>> = { "ws-a": { [PATH]: "export const a = 1;\n" }, "ws-b": { [PATH]: "export const b = 1;\n" } };
  const calls: Array<{ command: string; workspace?: string }> = [];
  const mtimeMs = 1_000;
  // Files Kit's host: the project named, and no other; the host's own is `ws-a`.
  const files = async (command: string, input?: unknown): Promise<unknown> => {
    const { workspace, relPath, text } = input as { workspace?: string; relPath: string; text?: string };
    calls.push({ command, ...(workspace ? { workspace } : {}) });
    const project = disk[workspace ?? "ws-a"]!;
    if (command === "read") {
      const body = project[relPath]!;
      return { path: relPath, name: "same.ts", size: body.length, mtimeMs, kind: "text", text: body } satisfies UiFileContent;
    }
    if (command === "stat") return { exists: true, size: project[relPath]!.length, mtimeMs };
    project[relPath] = text!;
    return { status: "written", size: text!.length, mtimeMs } satisfies UiFileWriteResult;
  };
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [projectB], sessions: [] },
      detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
      catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
      project: { cwd: "/project-a", workspaceId: "ws-a" },
    }),
    invokeHostExtension: workspaceHostStub({}, { [FILES_KIT_ID]: files }),
  });
  return { storage, client, disk, calls };
}

describe("Files Kit after a restart", () => {
  it("reads and saves a restored editor tab in the draft's project, leaving the host's untouched", async () => {
    const { storage, client, disk, calls } = restartedOnAnotherProject();
    renderApp(client, { storage, extensions: [filesExtension] });

    const content = await screen.findByLabelText(`Contents of ${PATH}`);
    const view = EditorView.findFromDOM(content)!;
    await waitFor(() => expect(view.state.doc.toString()).toBe("export const b = 1;\n"));
    act(() => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "export const b = 2;\n" }, userEvent: "input" }); });
    fireEvent.click(await screen.findByRole("button", { name: /^Save/u }));

    await waitFor(() => expect(disk["ws-b"]![PATH]).toBe("export const b = 2;\n"));
    expect(disk["ws-a"]![PATH]).toBe("export const a = 1;\n");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((call) => call.workspace !== "ws-b")).toEqual([]);
  });
});
