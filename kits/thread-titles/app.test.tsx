// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { titleGeneratorExtension } from "./desktop.js";

afterEach(cleanup);

/**
 * The kit inside the real workbench: a first prompt names the thread it just
 * created. Core owns the prompt hook and the rename; this kit owns the moment
 * between them.
 */
describe("Thread Title Generator in the workbench", () => {
  it("generates a title after the first prompt creates a thread", async () => {
    const shell = {
      id: "created",
      path: "/created.jsonl",
      title: "Untitled thread",
      modifiedAt: 2,
      projectPath: "/project",
      projectName: "project",
      messageCount: 2,
    };
    const newSession = vi.fn(async (...args: unknown[]) => {
      const identity = args[3] as { clientTurnId: string; clientMessageId: string };
      return {
        version: 1 as const,
        updates: [
          { version: 1 as const, type: "thread-shell" as const, update: { sessionId: "created", shell } },
          {
            version: 1 as const,
            type: "thread-detail" as const,
            detail: {
              sessionId: "created",
              messages: [
                // The persisted prompt carries the submission's identity, which
                // is what commits the detached delivery.
                { id: "user", clientTurnId: identity.clientTurnId, clientMessageId: identity.clientMessageId, role: "user" as const, text: "Name this thread", timestamp: 1 },
                { id: "assistant", role: "assistant" as const, text: "Done", timestamp: 2 },
              ],
              isStreaming: false,
              activeTools: [],
            },
          },
        ],
        submission: { accepted: true as const },
      };
    });
    const generateTitle = vi.fn(async () => {
      // The host renames after its own round trip; the renamed shell arrives as
      // an ordinary host update, never as the command's return value.
      await new Promise((resolve) => setTimeout(resolve, 0));
      client.emit({
        type: "host-update",
        update: { version: 1, type: "thread-shell", update: { sessionId: "created", shell: { ...shell, title: "Created thread title" } } },
      });
      return { title: "Created thread title" };
    });
    const getWorkspaceInfo = vi.fn(async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }));
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: {
          sessionId: "session",
          models: [{ provider: "provider", id: "model", name: "Model" }],
          model: { provider: "provider", id: "model", name: "Model" },
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
        getWorkspaceInfo,
        getFileTree: async () => [],
      }, { "tau.thread-titles": generateTitle }),
      newSession,
    });

    renderApp(client, { extensions: [titleGeneratorExtension] });
    await screen.findByRole("heading", { name: "What do you want to build?" });
    await waitFor(() => expect(getWorkspaceInfo).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    const dialog = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(dialog).getByRole("option"));
    const composer = screen.getByPlaceholderText(/Direct the agent/u);
    fireEvent.change(composer, { target: { value: "Name this thread" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(generateTitle).toHaveBeenCalledWith("generate", { provider: "provider", modelId: "model", force: false, sessionId: "created", prompt: "Name this thread" }));
    expect(await screen.findByText("Created thread title")).toBeTruthy();
    expect(screen.getAllByText("Name this thread").some((element) => element.closest(".transcript-current-row"))).toBe(true);
  });
});
