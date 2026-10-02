// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UiToolRun } from "../../src/shared/contracts";
import type { DesktopExtension } from "../../src/renderer/extension-system";
import { createMemoryStorage, setClientStorage } from "../../src/workbench/client-storage";
import { openFileTab, EMPTY_STAGE } from "../../src/workbench/stage";
import { threadStageKey } from "../../src/workbench/storage-keys";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client";
import { renderApp } from "../../src/renderer/test-support/render-app";
import { setHostClient } from "../../src/renderer/host-client-context";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub";
import { runPaletteCommand } from "../../src/renderer/test-support/palette";
import filesExtension from "../files/desktop";
import { FILES_KIT_ID } from "../files/protocol";
import { presentRead } from "./tool-cards";
import { useWorkbench } from "../../src/renderer/workbench-context";
import { routeFromState } from "../../src/workbench/phone-history";

Range.prototype.getClientRects ??= function getClientRects() { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect ??= function getBoundingClientRect() { return new DOMRect(); };
afterEach(() => {
  cleanup(); setHostClient(undefined); setClientStorage(undefined);
  window.history.replaceState(null, "", "/");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 0 });
  Object.defineProperty(window.screen, "width", { configurable: true, value: 0 });
  Object.defineProperty(window.screen, "height", { configurable: true, value: 0 });
});
const path = "src/same.ts";
const textA = "export const originA = 1;";
const textB = "export const activeB = 2;";
function Authority() { return <output data-testid="active-document">{useWorkbench().activeDocumentPath ?? "no document authority"}</output>; }
function fixture({ phone = false, foreign = false, absoluteTool = false }: { phone?: boolean; foreign?: boolean; absoluteTool?: boolean } = {}) {
  window.history.replaceState(null, "", `/?profile=${phone ? "compact" : "desktop"}`);
  const width = phone ? 390 : 1440;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(window.screen, "width", { configurable: true, value: width });
  Object.defineProperty(window.screen, "height", { configurable: true, value: 900 });
  const storage = createMemoryStorage();
  if (foreign) {
    const stage = openFileTab(EMPTY_STAGE, path, { resourceOrigin: { sessionId: "A", workspace: "opaque-A", sourceId: "documents" } });
    storage.set(threadStageKey("thread:B"), JSON.stringify({ ...stage, dock: { open: true } }));
  }
  const loads: Array<{ path: string; workspace?: string }> = [];
  const fileCalls: Array<{ command: string; input: unknown }> = [];
  const state = { changes: { files: [], added: 0, removed: 0 } };
  const documents: DesktopExtension = { id: "test.review", name: "Review fixture", activate(plugin) {
    plugin.registerDocumentSource({ id: "documents", profiles: ["desktop", "compact"],
      loadFile: async (relative, from) => { loads.push({ path: relative, workspace: from?.workspace }); const text = from?.workspace === "opaque-A" ? textA : textB; return { path: relative, name: "same.ts", size: text.length, kind: "text", text }; },
      loadDiff: async (relative) => ({ path: relative, added: 0, removed: 0, hunks: [] }), openInEditor: () => undefined,
      getState: () => state, subscribe: () => () => undefined,
    });
    plugin.registerToolRenderer("read", (tool) => tool.name === "Read", presentRead, { profiles: ["desktop", "compact"] });
    plugin.registerRegion({ id: "authority", placement: "transcript-header", profiles: ["desktop", "compact"], Component: Authority });
  } };
  const tool: UiToolRun = { id: "read", name: "Read", args: { file_path: "/repo-B/src/same.ts" }, status: "done", startedAt: 1, endedAt: 2 };
  const client = createFakeHostClient({
    bootstrap: async () => ({ version: 1,
      threadIndex: { projects: [], sessions: [{ id: "B", path: "/session-B", title: "Active B", projectPath: "/repo-B", workspaceId: "opaque-B", projectName: "B", modifiedAt: 1, messageCount: 2 }] },
      detail: { sessionId: "B", messages: [{ id: "user", role: "user", text: "Read a file", timestamp: 1 }, { id: "answer", role: "assistant", text: `\`${path}\``, timestamp: 3 }], isStreaming: false, activeTools: [], ...(absoluteTool ? { turnActivity: { anchorMessageId: "user", tools: [tool] } } : {}) },
      catalog: { sessionId: "B", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
      project: { cwd: "/repo-B", workspaceId: "opaque-B" },
    }),
    invokeHostExtension: workspaceHostStub({}, { [FILES_KIT_ID]: async (command, input) => {
      fileCalls.push({ command, input });
      if (command === "read") return { path, name: "same.ts", kind: "text", text: textB, size: textB.length, mtimeMs: 1 };
      if (command === "stat") return { exists: true, size: textB.length, mtimeMs: 1 };
      return { status: "written", size: 1, mtimeMs: 2 };
    } }),
  });
  return { ...renderApp(client, { storage, extensions: [documents, filesExtension] }), fileCalls, loads };
}

describe("issue 12 independent review regressions", () => {
  it("palette Edit file and Save file cannot give a foreign reader active-project authority", async () => {
    const { fileCalls, loads } = fixture({ foreign: true });
    await screen.findByText(textA);
    await runPaletteCommand("Edit file");
    await runPaletteCommand("Save file");
    await waitFor(() => expect(fileCalls).toEqual([]));
    expect(screen.queryByLabelText(`Contents of ${path}`)).toBeNull();
    expect(screen.getByTestId("active-document").textContent).toBe("no document authority");
    expect(loads).toContainEqual({ path, workspace: "opaque-A" });
    expect(await screen.findByText(textA)).toBeTruthy();
  });

  it("normal local file commands still open this project's editor", async () => {
    const { fileCalls } = fixture();
    fireEvent.click(await screen.findByRole("button", { name: `Open ${path}` }));
    await screen.findByText(textB);
    await runPaletteCommand("Edit file");
    await screen.findByLabelText(`Contents of ${path}`);
    await waitFor(() => expect(fileCalls).toContainEqual({ command: "read", input: { relPath: path, workspace: "opaque-B" } }));
  });

  it("ToolRun opens its authoritative workspace-contained absolute Read path on desktop", async () => {
    const { loads } = fixture({ absoluteTool: true });
    fireEvent.click(await screen.findByRole("button", { name: /Worked for/u }));
    fireEvent.click(await screen.findByRole("button", { name: "Open /repo-B/src/same.ts" }));
    await screen.findByText(textB);
    expect(loads).toContainEqual({ path, workspace: "opaque-B" });
  });

  it("closing the reader consumes its history step without a second Back", async () => {
    fixture({ phone: true });
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
    await runPaletteCommand("Toggle sidebar");
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("chat"));
    fireEvent.click(await screen.findByRole("button", { name: `Open ${path}` }));
    await screen.findByText(textB);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(routeFromState(window.history.state)?.kind).toBe("chat");
    window.history.back();
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
  });

  it("browser Back dismisses before leaving chat; reopening retains one step and dismissal persists", async () => {
    const { storage, loads } = fixture({ phone: true });
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
    await runPaletteCommand("Toggle sidebar");
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("chat"));
    fireEvent.click(await screen.findByRole("button", { name: `Open ${path}` }));
    await screen.findByRole("dialog");
    await screen.findByText(textB);
    window.history.back();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("chat"));
    expect(screen.getByRole("button", { name: "Back to threads" })).toBeTruthy();
    await waitFor(() => expect(storage.get(threadStageKey("thread:B")) ?? "").not.toContain("resourceOrigin"));
    fireEvent.click(screen.getByRole("button", { name: `Open ${path}` }));
    await screen.findByRole("dialog");
    await screen.findByText(textB);
    expect(loads).toEqual([{ path, workspace: "opaque-B" }, { path, workspace: "opaque-B" }]);
    window.history.back();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(routeFromState(window.history.state)?.kind).toBe("chat");
    window.history.back();
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
  });
});
