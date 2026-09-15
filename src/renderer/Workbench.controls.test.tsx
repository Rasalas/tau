// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setHostClient } from "./host-client-context";
import { setClientStorage } from "../workbench/client-storage";
import type { DesktopExtension } from "./extension-system";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { renderApp } from "./test-support/render-app";
import { workspaceHostStub } from "./test-support/workspace-host-stub";

afterEach(() => {
  cleanup();
  setHostClient(undefined);
  setClientStorage(undefined);
});

const controlFixture: DesktopExtension = {
  id: "test.workbench-controls",
  name: "Workbench controls fixture",
  activate(context) {
    context.registerCommand({
      id: "test.open-controls-stage",
      label: "Open controls fixture stage",
      group: "Test",
      run: (actions) => actions.openFile("/project/controls.txt"),
    });
  },
};

function createControlClient() {
  const model = { provider: "test-provider", id: "test-model", name: "Test model" };
  return createFakeHostClient({
    platform: "darwin",
    bootstrap: async () => ({
      version: 1,
      threadIndex: {
        projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }],
        sessions: [{ id: "session", path: "/session.jsonl", title: "Thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 1 }],
      },
      detail: {
        sessionId: "session",
        messages: [{ id: "user-1", role: "user", text: "hello", timestamp: 1 }],
        isStreaming: false,
        activeTools: [],
      },
      catalog: {
        sessionId: "session",
        models: [model],
        model,
        thinkingLevel: "off",
        thinkingLevels: ["off"],
        allTools: [],
        extensionCount: 0,
        supportsImageInput: true,
      },
      project: { cwd: "/project" },
    }),
    invokeHostExtension: workspaceHostStub({
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
      getFileTree: async () => [],
    }),
  });
}

function pressMod(key: string, options: KeyboardEventInit = {}): void {
  const mac = /mac|iphone|ipad/iu.test(navigator.platform);
  fireEvent.keyDown(window, { key, metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true, ...options });
}

async function runPaletteCommand(label: string): Promise<void> {
  pressMod("k");
  const palette = await screen.findByRole("dialog", { name: "Command palette" });
  const input = within(palette).getByRole("textbox", { name: "Command" });
  fireEvent.change(input, { target: { value: label } });
  fireEvent.keyDown(input, { key: "Enter", bubbles: true, cancelable: true });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
}

describe("Workbench imperative controls", () => {
  it("routes registered commands to the stage, instructions modal, and model picker", async () => {
    const client = createControlClient();
    renderApp(client, { extensions: [controlFixture] });
    await screen.findByRole("button", { name: "Send" });

    await runPaletteCommand("Open controls fixture stage");
    const stage = await screen.findByRole("region", { name: "Stage" });

    pressMod("3");
    expect(document.activeElement).toBe(stage);

    await runPaletteCommand("Inspect active system prompt");
    const instructions = await screen.findByRole("dialog", { name: "Active Instructions and System Prompt" });
    expect(instructions).toBeTruthy();
    fireEvent.click(within(instructions).getByText("Close", { exact: true }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Active Instructions and System Prompt" })).toBeNull());

    pressMod("m", { shiftKey: true });
    expect(await screen.findByRole("dialog", { name: "Select model" })).toBeTruthy();
  });
});
