// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UiToolRun } from "../shared/contracts";
import type { DesktopExtension, ToolPresentation, WorkbenchActions } from "./extension-system";
import { createMemoryStorage, setClientStorage } from "../workbench/client-storage";
import { openFileTab, EMPTY_STAGE } from "../workbench/stage";
import { threadStageKey } from "../workbench/storage-keys";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { renderApp } from "./test-support/render-app";
import { setHostClient } from "./host-client-context";
import { workspaceHostStub } from "./test-support/workspace-host-stub";
import { runPaletteCommand } from "./test-support/palette";

import { useWorkbench } from "./workbench-context";
import { routeFromState } from "../workbench/phone-history";

const toolModules = import.meta.glob<{ presentRead: (tool: UiToolRun) => ToolPresentation }>("../../kits/*/tool-cards.tsx");
const { presentRead } = await toolModules["../../kits/workspace/tool-cards.tsx"]!();
const kitModules = import.meta.glob<{ default: DesktopExtension }>("../../kits/*/desktop.tsx");
const { default: filesExtension } = await kitModules["../../kits/files/desktop.tsx"]!();

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
function fixture({ phone = false, foreign = false, absoluteTool = false, switchable = false, readerB = false }: { phone?: boolean; foreign?: boolean; absoluteTool?: boolean; switchable?: boolean; readerB?: boolean } = {}) {
  const initial = switchable ? "A" : "B";
  let actions: WorkbenchActions | undefined;
  let openResource: ReturnType<typeof useWorkbench>["openWorkspaceFile"];
  const sessions = ["A", "B"].map((id) => ({ id, path: `/session-${id}`, title: `Active ${id}`, projectPath: `/repo-${id}`, workspaceId: `opaque-${id}`, projectName: id, modifiedAt: 1, messageCount: 2 }));
  const detail = (id: string) => ({ sessionId: id, messages: [{ id: "user", role: "user" as const, text: `Thread ${id} content`, timestamp: 1 }, { id: "answer", role: "assistant" as const, text: `\`${path}\``, timestamp: 3 }], isStreaming: false, activeTools: [], ...(absoluteTool ? { turnActivity: { anchorMessageId: "user", tools: [tool] } } : {}) });
  window.history.replaceState(null, "", `/?profile=${phone ? "compact" : "desktop"}`);
  const width = phone ? 390 : 1440;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(window.screen, "width", { configurable: true, value: width });
  Object.defineProperty(window.screen, "height", { configurable: true, value: 900 });
  const storage = createMemoryStorage();
  if (foreign || readerB) {
    const id = foreign ? "A" : "B";
    const stage = openFileTab(EMPTY_STAGE, path, { localWorkspace: "opaque-B", resourceOrigin: { sessionId: id, workspace: `opaque-${id}`, sourceId: "documents" } });
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
    plugin.registerRegion({ id: "actions", placement: "composer-below", profiles: ["desktop", "compact"], Component: (props) => { actions = props.actions; return null; } });
    plugin.registerRegion({ id: "authority", placement: "transcript-header", profiles: ["desktop", "compact"], Component: () => { openResource = useWorkbench().openWorkspaceFile; return <Authority />; } });
  } };
  const tool: UiToolRun = { id: "read", name: "Read", args: { file_path: "/repo-B/src/same.ts" }, status: "done", startedAt: 1, endedAt: 2 };
  const client = createFakeHostClient({
    bootstrap: async () => ({ version: 1,
      threadIndex: { projects: [], sessions }, detail: detail(initial),
      catalog: { sessionId: initial, models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
      project: { cwd: `/repo-${initial}`, workspaceId: `opaque-${initial}` },
    }),
    switchSession: async (sessionPath) => {
      const session = sessions.find((item) => item.path === sessionPath)!;
      return { version: 1, updates: [
        { version: 1, type: "project", project: { cwd: session.projectPath, workspaceId: session.workspaceId } },
        { version: 1, type: "thread-detail", detail: detail(session.id) },
      ] };
    },
    invokeHostExtension: workspaceHostStub({}, { [filesExtension.id]: async (command, input) => {
      fileCalls.push({ command, input });
      if (command === "read") return { path, name: "same.ts", kind: "text", text: textB, size: textB.length, mtimeMs: 1 };
      if (command === "stat") return { exists: true, size: textB.length, mtimeMs: 1 };
      return { status: "written", size: 1, mtimeMs: 2 };
    } }),
  });
  return { ...renderApp(client, { storage, extensions: [documents, filesExtension] }), fileCalls, loads, client, actions: () => actions!, openResource: (relative: string) => openResource!(relative, { sessionId: initial, workspace: `opaque-${initial}`, sourceId: "documents" }) };
}

describe("issue 12 independent review regressions", () => {
  it("opening Settings dismisses the hosting chat's reader and preserves its draft", async () => {
    const { actions, client } = fixture({ phone: true, switchable: true });
    await screen.findByText("Thread A content");
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
    await runPaletteCommand("Toggle sidebar");
    await waitFor(() => expect(routeFromState(window.history.state)).toEqual({ kind: "chat", thread: "A" }));
    const composer = screen.getByPlaceholderText(/Ask anything/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Keep this unsent draft" } });
    fireEvent.click(screen.getByRole("button", { name: `Open ${path}` }));
    await screen.findByText(textA);
    const pop = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    act(() => actions().openSettings("general"));
    await act(async () => { await pop; });
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("settings"));
    expect((await screen.findAllByRole("heading", { name: "Settings" })).length).toBeGreaterThan(0);
    expect(screen.queryByRole("dialog", { name: "same.ts" })).toBeNull();
    window.history.back();
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
    expect(screen.queryByRole("dialog", { name: "same.ts" })).toBeNull();
    await runPaletteCommand("Toggle sidebar");
    await waitFor(() => expect(routeFromState(window.history.state)).toEqual({ kind: "chat", thread: "A" }));
    expect((screen.getByPlaceholderText(/Ask anything/u) as HTMLTextAreaElement).value).toBe("Keep this unsent draft");
    expect(client.calls.filter((call) => call.method === "switchSession")).toEqual([]);
  });
  it("a newly opened workspace reader may be hosted on Settings", async () => {
    const { actions, client, openResource, loads } = fixture({ phone: true, switchable: true });
    await screen.findByText("Thread A content");
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
    await runPaletteCommand("Toggle sidebar");
    await waitFor(() => expect(routeFromState(window.history.state)).toEqual({ kind: "chat", thread: "A" }));
    fireEvent.click(screen.getByRole("button", { name: `Open ${path}` }));
    await screen.findByText(textA);
    act(() => actions().openSettings("general"));
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("settings"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "same.ts" })).toBeNull());
    act(() => openResource("src/other.ts"));
    await screen.findByRole("dialog", { name: "other.ts" });
    await screen.findByText(textA);
    expect(loads).toContainEqual({ path: "src/other.ts", workspace: "opaque-A" });
    window.history.back();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "other.ts" })).toBeNull());
    expect(routeFromState(window.history.state)?.kind).toBe("settings");
    window.history.back();
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
    expect(client.calls.filter((call) => call.method === "switchSession")).toEqual([]);
  });

  it("Forward into a dismissed reader entry cannot obstruct Settings or reopen a thread", async () => {
    const { actions, client } = fixture({ phone: true, switchable: true });
    await screen.findByText("Thread A content");
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
    await runPaletteCommand("Toggle sidebar");
    await waitFor(() => expect(routeFromState(window.history.state)).toEqual({ kind: "chat", thread: "A" }));
    fireEvent.click(screen.getByRole("button", { name: `Open ${path}` }));
    await screen.findByText(textA);
    window.history.back();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "same.ts" })).toBeNull());
    const pop = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    await act(async () => { window.history.forward(); await pop; });
    expect(routeFromState(window.history.state)).toEqual({ kind: "chat", thread: "A" });
    expect(screen.queryByRole("dialog", { name: "same.ts" })).toBeNull();
    act(() => actions().openSettings("general"));
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("settings"));
    expect(screen.queryByRole("dialog", { name: "same.ts" })).toBeNull();
    window.history.back();
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
    expect(client.calls.filter((call) => call.method === "switchSession")).toEqual([]);
  });

  it("switching A's open reader to B consumes the modal step without reopening A", async () => {
    const { actions, client } = fixture({ phone: true, switchable: true });
    await screen.findByText("Thread A content");
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
    await runPaletteCommand("Toggle sidebar");
    await waitFor(() => expect(routeFromState(window.history.state)).toEqual({ kind: "chat", thread: "A" }));
    fireEvent.click(screen.getByRole("button", { name: `Open ${path}` }));
    await screen.findByText(textA);
    const pop = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    await act(async () => { await actions().switchSession("/session-B"); await pop; });
    await screen.findByText("Thread B content");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(routeFromState(window.history.state)).toEqual({ kind: "chat", thread: "B" });
    expect(client.calls.filter((call) => call.method === "switchSession").map((call) => call.args)).toEqual([["/session-B"]]);
    window.history.back();
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
    expect(client.calls.filter((call) => call.method === "switchSession").map((call) => call.args)).toEqual([["/session-B"]]);
  });
  it("switching to B's persisted reader gives it B's own modal step", async () => {
    const { actions, client, loads } = fixture({ phone: true, switchable: true, readerB: true });
    await screen.findByText("Thread A content");
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
    await runPaletteCommand("Toggle sidebar");
    await waitFor(() => expect(routeFromState(window.history.state)).toEqual({ kind: "chat", thread: "A" }));
    fireEvent.click(screen.getByRole("button", { name: `Open ${path}` }));
    await screen.findByText(textA);
    const length = window.history.length;
    const pop = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    await act(async () => { await actions().switchSession("/session-B"); await pop; });
    await screen.findByText(textB);
    expect(loads).toContainEqual({ path, workspace: "opaque-B" });
    expect(window.history.length).toBe(length);
    expect(routeFromState(window.history.state)).toEqual({ kind: "chat", thread: "B" });
    window.history.back();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(routeFromState(window.history.state)).toEqual({ kind: "chat", thread: "B" });
    window.history.back();
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
    expect(client.calls.filter((call) => call.method === "switchSession").map((call) => call.args)).toEqual([["/session-B"]]);
  });

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
