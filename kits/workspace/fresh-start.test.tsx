// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { createMemoryStorage, setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { workspaceExtension } from "./desktop.js";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

/** A window on the host's empty start session in `/home/me`, with `messageCount` messages in its only thread. */
function start({ isRepo, messageCount }: { isRepo: boolean; messageCount: number }) {
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: {
        projects: [{ path: "/home/me", name: "me", lastOpenedAt: 1 }],
        sessions: [{ id: "start", path: "/start.jsonl", title: "New thread", modifiedAt: 1, projectPath: "/home/me", projectName: "me", messageCount }],
      },
      detail: { sessionId: "start", messages: [], isStreaming: false, activeTools: [] },
      catalog: { sessionId: "start", models: [{ provider: "anthropic", id: "haiku", name: "Haiku" }], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
      project: { cwd: "/home/me" },
    }),
    invokeHostExtension: workspaceHostStub({
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({ root: "/home/me", isRepo, isDirty: false, worktrees: [], refs: [] }),
      getFileTree: async () => [],
    }),
  });
  renderApp(client, { storage: createMemoryStorage(), extensions: [workspaceExtension] });
}

describe("a fresh install (2a)", () => {
  it("asks for a project in place of the draft, with the chords and the connected providers", async () => {
    start({ isRepo: false, messageCount: 0 });
    expect(await screen.findByRole("heading", { name: "Open a project to start" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open a folder" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clone a repository" })).toBeTruthy();
    expect(document.querySelector(".fresh-start-keys")?.textContent).toContain("new thread");
    expect(document.querySelector(".fresh-start-providers")?.textContent).toContain("Anthropic connected · add more");
    // The rail says the same: nothing yet.
    expect(document.querySelector(".sidebar-empty.first")?.textContent).toBe("No threads yet.They’ll line up here.");
  });

  it("gives way to the draft once the new-thread chord opened one", async () => {
    start({ isRepo: false, messageCount: 0 });
    await screen.findByRole("heading", { name: "Open a project to start" });
    fireEvent.click(await screen.findByRole("button", { name: "New thread" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Open a project to start" })).toBeNull());
  });

  it("stays out of a repository and of a window that already has a thread", async () => {
    start({ isRepo: true, messageCount: 0 });
    expect(await screen.findByRole("heading", { name: /What should .+ do next\?/u })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector(".fresh-start")).toBeNull();
    cleanup();
    start({ isRepo: false, messageCount: 2 });
    expect(await screen.findByRole("heading", { name: /What should .+ do next\?/u })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector(".fresh-start")).toBeNull();
  });
});
