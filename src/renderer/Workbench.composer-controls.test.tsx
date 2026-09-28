// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setHostClient } from "./host-client-context";
import { setClientStorage } from "../workbench/client-storage";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { renderApp } from "./test-support/render-app";
import { workspaceHostStub } from "./test-support/workspace-host-stub";
import type { DesktopExtension } from "./extension-system";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

const kit: DesktopExtension = {
  id: "test.controls",
  name: "Controls",
  activate: (context) => {
    context.registerRegion({ id: "pill", placement: "composer-controls", Component: () => <button type="button">3 files</button> });
    context.registerRegion({ id: "banner", placement: "composer-above", Component: () => <p>banner</p> });
    context.registerRegion({ id: "footer", placement: "transcript-footer", Component: () => <p>setup</p> });
  },
};

describe("the controls row over the composer", () => {
  it("sits on the transcript's bottom edge, outside the transcript and before its footer", async () => {
    const client = createFakeHostClient({
      platform: "darwin",
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }],
          sessions: [{ id: "session", path: "/session.jsonl", title: "Thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 1 }],
        },
        detail: { sessionId: "session", messages: [{ id: "user-1", role: "user", text: "hello", timestamp: 1 }], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
    });
    const view = renderApp(client, { extensions: [kit] });
    await screen.findByText("hello");

    const pill = await screen.findByRole("button", { name: "3 files" });
    const row = pill.closest(".region-composer-controls")!;
    expect(row).toBeTruthy();
    expect(row.closest(".transcript-viewport")).toBeNull();
    // A floating arrow anchored here covers the transcript's edge, never the footer's controls.
    expect(row.parentElement?.classList.contains("conversation-thread")).toBe(true);
    expect(row.previousElementSibling?.classList.contains("transcript-viewport")).toBe(true);
    expect(row.nextElementSibling?.classList.contains("region-transcript-footer")).toBe(true);
    // The dock lies over the transcript and paints over it by tree order (K51), so the thread comes first.
    const host = view.container.querySelector(".conversation-composer-host")!;
    expect(row.parentElement!.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.parentElement!.querySelector(":scope > .composer-reserve-probe")).toBeTruthy();
    // At the tail there is nothing to jump to.
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
    expect(view.container.querySelector(".transcript-viewport .jump-to-latest")).toBeNull();
  });
});
