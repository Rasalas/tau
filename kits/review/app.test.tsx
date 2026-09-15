// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiFileDiff, UiWorkspaceChanges } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { workspaceExtension } from "../workspace/desktop.js";
import { reviewExtension } from "./desktop.js";
import { REVIEW_HOST_EXTENSION_ID } from "./protocol.js";

afterEach(cleanup);

const CHANGES: UiWorkspaceChanges = {
  branch: "feat/review",
  files: [{ path: "src/a.ts", name: "a.ts", directory: "src", status: "modified", added: 1, removed: 0 }],
  fileCount: 1,
  added: 1,
  removed: 0,
  proposedMessage: "Update a",
};

const DIFF: UiFileDiff = {
  path: "src/a.ts",
  added: 1,
  removed: 0,
  hunks: [{ header: "@@ -0,0 +1 @@", lines: [{ kind: "added", newLine: 1, text: "const reviewed = true;" }] }],
};

const WORKSPACE = { root: "/project", isRepo: true, isDirty: true, upstream: "origin/main", branch: "feat/review", worktrees: [], refs: [] };

function workbench(overrides: Parameters<typeof workspaceHostStub>[0] = {}, review: (command: string, input?: unknown) => Promise<unknown> = async () => undefined) {
  const workspace = workspaceHostStub({
    getChanges: async () => CHANGES,
    getFileDiff: async () => DIFF,
    getWorkspaceInfo: async () => WORKSPACE,
    getFileTree: async () => [],
    listEditors: async () => [],
    ...overrides,
  });
  return createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
      detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
      catalog: {
        sessionId: "session",
        models: [{ provider: "openai", id: "gpt-luna", name: "Luna" }],
        model: { provider: "openai", id: "gpt-luna", name: "Luna" },
        thinkingLevel: "off",
        thinkingLevels: ["off"],
        allTools: [],
        extensionCount: 0,
        supportsImageInput: true,
      },
      project: { cwd: "/project" },
    }),
    invokeHostExtension: (extensionId, command, input) => {
      if (extensionId === REVIEW_HOST_EXTENSION_ID) {
        return command === "changes" || command === "file-diff"
          ? workspace("tau.workspace", command, input)
          : review(command, input);
      }
      return workspace(extensionId, command, input);
    },
  });
}

/**
 * The kit in the real workbench, over the Workspace Kit it reads. Core lends
 * an overlay slot; the diff and the commit message the kit's own host entry
 * writes belong to Review Kit, the Changes panel to Workspace Kit.
 */
describe("Review Kit in the workbench", () => {
  it("commits the worktree from the changes panel", async () => {
    const commit = vi.fn(async () => ({ changes: { files: [], added: 0, removed: 0 }, pushed: true, detail: "Committed and pushed." }));
    renderApp(workbench({ commit }), { extensions: [workspaceExtension, reviewExtension] });

    fireEvent.click(await screen.findByRole("button", { name: "Changes" }));
    expect(await screen.findByTitle("src/a.ts")).toBeTruthy();

    const message = await screen.findByPlaceholderText("Commit message");
    expect(message).toHaveProperty("value", "Update a");
    fireEvent.change(message, { target: { value: "feat(review): commit from the panel" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit all & push" }));

    await waitFor(() => expect(commit).toHaveBeenCalledWith("feat(review): commit from the panel", true));
  });

  it("opens the full review over a changed file and proposes a commit message", async () => {
    const suggest = vi.fn(async () => ({ message: "feat(review): describe the change" }));
    renderApp(workbench({}, suggest), { extensions: [workspaceExtension, reviewExtension] });

    fireEvent.click(await screen.findByRole("button", { name: "Changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open full review" }));

    await waitFor(() => expect(document.querySelector(".diff-code")?.textContent).toContain("const reviewed = true;"));
    await waitFor(() => expect(suggest).toHaveBeenCalledWith("suggest-commit-message", expect.objectContaining({
      provider: "openai",
      modelId: "gpt-luna",
      style: "conventional",
      branch: "feat/review",
      files: [{ path: "src/a.ts", added: 1, removed: 0 }],
    })));
    expect(await screen.findByRole("button", { name: "feat(review): describe the change" })).toBeTruthy();
  });

  it("returns to the thread after committing from the full review", async () => {
    const commit = vi.fn(async () => ({ changes: { files: [], added: 0, removed: 0 }, pushed: false, detail: "Committed abc1234" }));
    const suggest = vi.fn(async () => ({ message: "fix(review): restore commit flow" }));
    renderApp(workbench({ commit }, suggest), { extensions: [workspaceExtension, reviewExtension] });

    fireEvent.click(await screen.findByRole("button", { name: "Changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open full review" }));
    const message = await screen.findByRole("button", { name: "fix(review): restore commit flow" });
    const proposal = message.closest(".commit-proposal");
    expect(proposal).not.toBeNull();

    fireEvent.click(within(proposal as HTMLElement).getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(commit).toHaveBeenCalledWith("fix(review): restore commit flow", false));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Back to thread" })).toBeNull());
  });
});
