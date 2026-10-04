// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import terminal from "./desktop.js";
import { terminalStore } from "./store.js";
import { TERMINAL_HOST_EXTENSION_ID } from "./protocol.js";
import { EMPTY_LAYOUT } from "./layout.js";
import { setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import type { DesktopExtension } from "tau";

// Keep the actual Terminal Kit commands, bindings and workbench panel routing;
// its PTY renderer is unrelated to whether the shortcut opens the closed stage.
vi.mock("./panel.js", () => ({ TerminalPanel: () => <div>Terminal panel content</div> }));

const workspace: DesktopExtension = { id: "test.terminal-workspace", name: "Workspace", activate(plugin) {
  plugin.registerRegion({ id: "context", placement: "workspace-summary", Component: () => <div>Project context</div> });
} };

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  terminalStore.setSessions([]);
  terminalStore.updateLayout(() => EMPTY_LAYOUT);
});
afterEach(() => {
  cleanup();
  setHostClient(undefined);
  setClientStorage(undefined);
  vi.restoreAllMocks();
});

function client() {
  return createFakeHostClient({
    platform: "darwin",
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [{ path: "/project", name: "Project", lastOpenedAt: 1 }], sessions: [] },
      detail: { sessionId: "s1", messages: [{ id: "u1", role: "user", text: "Hello", timestamp: 1 }, { id: "a1", role: "assistant", text: "Assistant reply", timestamp: 2 }], isStreaming: false, activeTools: [] },
      catalog: { sessionId: "s1", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: false },
      project: { cwd: "/project" },
    }),
    invokeHostExtension: async (extension, command) => {
      if (extension !== TERMINAL_HOST_EXTENSION_ID) return undefined;
      if (command === "list") return [{ id: "t1", sessionId: "s1", label: "Shell", cwd: "/project", shell: "zsh", cols: 80, rows: 24 }];
      if (command === "font") return { families: [], files: [], problems: [] };
      return undefined;
    },
  });
}

describe("Cmd+J from chat with no stage tab", () => {
  it.each(["composer", "transcript", "assistant paragraph"])("opens Terminal from the %s while workspace context is shown", async (focus) => {
    const view = renderApp(client(), { extensions: [workspace, terminal] });
    await screen.findByText("Hello");
    await screen.findByText("Project context");
    await waitFor(() => expect(terminalStore.getSnapshot().sessions).toHaveLength(1));
    expect(view.container.querySelector(".stage")).toBeNull();
    const target = focus === "composer"
      ? screen.getByRole("textbox")
      : focus === "transcript" ? screen.getByRole("log", { name: "Thread transcript" })
        : (await screen.findByText("Assistant reply")).closest("p")!;
    if (focus === "assistant paragraph") target.tabIndex = -1;
    const messages = screen.getByRole("region", { name: "Transcript content" });
    const focusedIndex = messages.getAttribute("data-focused-index");
    target.focus();
    fireEvent.keyDown(target, { key: "j", code: "KeyJ", metaKey: true, bubbles: true, cancelable: true });
    // The transcript must not reinterpret Cmd+J as its plain-j scroll key.
    if (focus === "transcript") expect(target.scrollTop).toBe(0);
    expect(messages.getAttribute("data-focused-index")).toBe(focusedIndex);
    expect(await screen.findByText("Terminal panel content")).toBeTruthy();
    expect(await screen.findByRole("tab", { name: /Terminal/u })).toBeTruthy();
  });
});
