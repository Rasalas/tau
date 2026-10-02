// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopExtension, ThreadLineage, UiSession } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { runPaletteCommand } from "../../src/renderer/test-support/palette.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { workspaceExtension } from "./desktop.js";
import { WORKSPACE_STORE_SERVICE, type WorkspaceStoreApi } from "./protocol.js";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

async function setup() {
  const sessions: UiSession[] = ["parent", "child"].map((id) => ({
    id, path: `/sessions/${id}.jsonl`, title: `Thread ${id}`, modifiedAt: 1,
    projectPath: "/project", projectName: "project", messageCount: 2,
    ...(id === "child" ? { parentThreadId: "parent" } : {}),
  }));
  let setLineage!: (lineage: ThreadLineage) => void;
  const fixture: DesktopExtension = {
    id: "test.agents", name: "Agents fixture",
    activate(context) {
      setLineage = context.setThreadLineage;
      context.setThreadLineage({ parents: { child: "parent" }, workingChildren: {} });
      context.registerCommand({ id: "test.child", label: "Read child thread", group: "Test", run: (actions) => actions.openThread("child") });
      return context.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (store) => store.registerThreadRailOrganizer({
        subscribe: () => () => undefined, getVersion: () => 1,
        sections: (threads) => [{ id: "pinned", label: "Pinned", threads: [...threads] }, { id: "active", threads: [] }],
        menu: () => [], runMenu: () => undefined, toggleSettled: () => undefined,
        dropLabel: () => undefined, drop: () => undefined,
      }));
    },
  };
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions },
      detail: { sessionId: "parent", messages: [], isStreaming: false, activeTools: [] },
      catalog: { sessionId: "parent", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
      project: { cwd: "/project" },
    }),
    invokeHostExtension: workspaceHostStub(),
    loadTranscript: async (sessionId) => ({
      sessionId, hasMore: false,
      messages: [{ id: "prompt", role: "user", text: "Check the tests", timestamp: 1 }],
      turnActivityHistory: [{ id: "turn", anchorMessageId: "prompt", status: "running", tools: [
        { id: "test-run", name: "bash", args: { command: "npm test" }, status: "running", startedAt: 1000 },
      ] }],
    }),
  });
  const view = renderApp(client, { extensions: [workspaceExtension, fixture] });
  await screen.findByText("Thread parent");
  return { ...view, client, setLineage, row: () => document.querySelector('[data-rail-thread="parent"] .thread-row')! };
}

describe("supervising a child thread", () => {
  it("shows the idle parent as Working while its child runs, without a separate running count", async () => {
    const { client, setLineage, row } = await setup();
    act(() => {
      client.emit({ type: "agent-status", sessionId: "child", running: true, startedAt: 1000 });
      setLineage({ parents: { child: "parent" }, workingChildren: { parent: 1 } });
    });
    await waitFor(() => expect(row().classList.contains("activity-working")).toBe(true));
    expect(row().querySelector(".thread-status-age")?.textContent).toMatch(/^Working/);
    expect(row().textContent).not.toContain("1 running");
    act(() => {
      client.emit({ type: "agent-status", sessionId: "child", running: false });
      setLineage({ parents: { child: "parent" }, workingChildren: {} });
    });
    await waitFor(() => expect(row().classList.contains("activity-working")).toBe(false));
  });

  it("shows what the child is doing inside its read-only transcript", async () => {
    const { client } = await setup();
    act(() => client.emit({ type: "agent-status", sessionId: "child", running: true }));
    await runPaletteCommand("Read child thread");
    const tab = await screen.findByRole("region", { name: "Thread Thread child" });
    await within(tab).findByText("Check the tests");
    expect(await within(tab).findByText("Running npm")).toBeTruthy();
    expect(tab.querySelector(".work-live.running .work-live-clock")).toBeTruthy();
  });
});
