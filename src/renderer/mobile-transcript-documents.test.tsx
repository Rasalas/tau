// @vitest-environment jsdom
// Issue #12 document-navigation regression.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp } from "./test-support/render-app";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { setHostClient } from "./host-client-context";
import { runPaletteCommand } from "./test-support/palette";
import { createMemoryStorage, setClientStorage, type ClientStorage } from "../workbench/client-storage";
import type { DesktopExtension, DocumentOrigin } from "./extension-system";
import { threadStageKey } from "../workbench/storage-keys";

const paths = [".tau-dev/dictation-preview/recording-detail.png", ".tau-dev/dictation-preview/inserted-detail.png"];
const documentPath = ".scratch/mobile-transcript-images/issues/01-render-workspace-screenshots-on-mobile.md";
const body = `![During recording](${paths[0]})\n\n![Text im Entwurf](${paths[1]})\n\n\`${documentPath}\``;
const text = "Issue 12 readable workspace document fixture";

afterEach(() => {
  cleanup(); setHostClient(undefined); setClientStorage(undefined);
  window.history.replaceState({}, "", "/");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 0 });
  Object.defineProperty(window.screen, "width", { configurable: true, value: 0 });
  Object.defineProperty(window.screen, "height", { configurable: true, value: 0 });
});

function fixture(width: number, profile = "compact", options: { storage?: ClientStorage; error?: string; workspace?: string } = {}) {
  const workspace = options.workspace ?? "ws-origin";
  window.history.replaceState({}, "", `/?profile=${profile}`);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window.screen, "width", { configurable: true, value: width });
  Object.defineProperty(window.screen, "height", { configurable: true, value: 900 });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: width });
  const loads: Array<{ path: string; from?: DocumentOrigin }> = [];
  const state = { changes: { isRepo: true, files: [] } };
  const documents: DesktopExtension = { id: "test.issue12", name: "Issue 12 fixture", activate(plugin) {
    plugin.registerDocumentSource({ id: "issue12", profiles: ["desktop", "web", "compact"],
      loadFile: async (path, from) => {
        loads.push({ path, from });
        if (options.error) throw new Error(options.error);
        if (path !== documentPath || from?.workspace !== workspace) throw new Error("Wrong originating workspace/path");
        return { path, name: "01-render-workspace-screenshots-on-mobile.md", kind: "text", text, size: text.length };
      },
      loadDiff: async (path) => ({ path, added: 0, removed: 0, hunks: [] }),
      openInEditor: () => undefined,
      getState: () => state as never,
      subscribe: () => () => undefined,
    });
  } };
  const client = createFakeHostClient({ bootstrap: async () => ({
    version: 1, threadIndex: { projects: [], sessions: [{ id: "issue12-thread", path: "/fixture/session.jsonl", title: "Issue 12 thread", modifiedAt: 1, projectPath: "/isolated/origin", workspaceId: workspace, projectName: "fixture", messageCount: 1 }] },
    detail: { sessionId: "issue12-thread", messages: [{ id: "issue12-answer", role: "assistant", text: body, timestamp: 1 }], isStreaming: false, activeTools: [] },
    catalog: { sessionId: "issue12-thread", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
    project: { cwd: "/isolated/origin", workspaceId: workspace },
  }) });
  return { ...renderApp(client, { extensions: [documents], storage: options.storage }), loads };
}

describe("issue 12 workspace document navigation", () => {
  for (const [error, guidance] of [["ENOENT", /File not found/u], ["forbidden", /Access to this workspace file was denied/u], ["host offline", /host is offline/u], ["unsupported", /does not support reading/u]] as const) {
    it(`shows understandable ${error} guidance in the phone reader`, async () => {
      fixture(390, "compact", { error });
      await runPaletteCommand("Toggle sidebar");
      fireEvent.click(await screen.findByRole("button", { name: `Open ${documentPath}` }));
      expect(await screen.findByText(guidance)).toBeTruthy();
      expect(screen.queryByRole("textbox", { name: /file/iu })).toBeNull();
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });
  }
  it("reopens the persisted phone file in its original workspace", async () => {
    const storage = createMemoryStorage();
    const first = fixture(390, "compact", { storage });
    await runPaletteCommand("Toggle sidebar");
    fireEvent.click(await screen.findByRole("button", { name: `Open ${documentPath}` }));
    await screen.findByText(text);
    await waitFor(() => expect(storage.get(threadStageKey("thread:issue12-thread"))).toContain("resourceOrigin"));
    first.unmount();
    const second = fixture(390, "compact", { storage });
    await screen.findByText(text);
    expect(second.loads).toContainEqual({ path: documentPath, from: { workspace: "ws-origin" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  for (const [device, width] of [["iPhone", 390], ["iPad", 1024], ["desktop", 1440]] as const) {
    it(`${device} tapping the Markdown chip opens readable host document content`, async () => {
      const { loads } = fixture(width, device === "desktop" ? "desktop" : "compact");
      if (width < 720) await runPaletteCommand("Toggle sidebar");
      fireEvent.click(await screen.findByRole("button", { name: `Open ${documentPath}` }));
      await screen.findByText(text);
      await waitFor(() => expect(loads).toContainEqual({ path: documentPath, from: { workspace: "ws-origin" } }));
      if (width < 720) {
        expect(screen.getByRole("dialog", { name: "01-render-workspace-screenshots-on-mobile.md" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      }
    });
  }
});
