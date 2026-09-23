// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopExtension, UiFileDiff, UiWorkspaceChanges } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { plainChipText, renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { workspaceExtension } from "../workspace/desktop.js";
import composerContext from "../composer-context/desktop.js";
import { reviewExtension } from "./desktop.js";
import { REVIEW_HOST_EXTENSION_ID, WORKSPACE_STORE_SERVICE, type WorkspaceStoreApi } from "./protocol.js";
import { parseGitHubDetail, parseGitHubThreads, parseRequestUrl } from "./pull-request-json.js";

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

const SESSION = { id: "session", path: "session", title: "Review thread", modifiedAt: 1, projectPath: "/project", projectName: "project", projectLabel: "feat/review", messageCount: 1 };

function workbench(overrides: Parameters<typeof workspaceHostStub>[0] = {}, review: (command: string, input?: unknown) => Promise<unknown> = async () => undefined, sessions: unknown[] = []) {
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
      threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: sessions as never[] },
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
  it("lets a third package open Review through the declared store service", async () => {
    const example: DesktopExtension = {
      id: "example.review-consumer",
      name: "Review consumer",
      activate(context) {
        return context.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (store) => context.registerStatusItem({
          id: "example.review",
          align: "left",
          profiles: ["desktop"],
          Component: () => <button onClick={() => store.openReview("src/a.ts")}>Review from example</button>,
        }));
      },
    };
    const suggest = vi.fn(async () => ({ message: "fix: review from another package" }));
    renderApp(workbench({}, suggest), { extensions: [example, reviewExtension, workspaceExtension] });

    fireEvent.click(await screen.findByRole("button", { name: "Review from example" }));
    await waitFor(() => expect(document.querySelector(".diff-code")?.textContent).toContain("const reviewed = true;"));
    expect(await screen.findByRole("button", { name: "fix: review from another package" })).toBeTruthy();
  });

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

  it("says in the commit box, not in a toast, why no message was written", async () => {
    const suggest = vi.fn(async () => { throw new Error("Provider is not configured: openai"); });
    renderApp(workbench({}, suggest), { extensions: [workspaceExtension, reviewExtension] });

    fireEvent.click(await screen.findByRole("button", { name: "Changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open full review" }));

    const hint = await waitFor(() => {
      const found = document.querySelector(".commit-proposal .commit-message-error");
      expect(found?.textContent).toBe("No suggestion: Provider is not configured: openai");
      return found;
    });
    expect(hint).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update a" })).toBeTruthy();
    expect(screen.getAllByText(/Provider is not configured/u)).toHaveLength(1);
  });

  it("comments on a line and hands the comment to the composer as a chip", async () => {
    renderApp(workbench(), { extensions: [workspaceExtension, reviewExtension, composerContext] });

    fireEvent.click(await screen.findByRole("button", { name: "Changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open full review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Comment on line 1" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Comment" }), { target: { value: "Name it after what it checks." } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(await screen.findByText("Name it after what it checks.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 comment" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send to composer" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Back to thread" })).toBeNull());
    // The chip sits in the prompt's text; its popover shows the comment.
    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    await waitFor(() => expect(plainChipText(composer.value)).toContain("a.ts:1"));
    fireEvent.click(screen.getByRole("button", { name: "Chip a.ts:1" }));
    expect((await screen.findByRole("dialog", { name: "a.ts:1" })).textContent).toContain("Name it after what it checks.");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    fireEvent.click(await screen.findByRole("button", { name: "Open full review" }));
    expect(await screen.findByRole("button", { name: "0 comments" })).toBeTruthy();
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

const NO_REQUEST = { branch: "feat/review", base: "main", remote: "git@github.com:acme/tau.git", service: "github" };
const OPEN_REQUEST = { provider: "github", number: 7, title: "Review everything", url: "https://github.com/acme/tau/pull/7", baseRef: "main", state: "open", draft: true, body: "Why", checks: { passed: 2, failed: 0, pending: 1, total: 3 } };

/**
 * The request lifecycle through the kit's own host commands: the section in
 * Workspace Kit's Changes panel, and the mark on the thread's rail row.
 */
describe("Review Kit request lifecycle in the workbench", () => {
  it("commits, drafts a title and body, and creates a draft pull request after the form is confirmed", async () => {
    const commit = vi.fn(async () => ({ changes: { files: [], added: 0, removed: 0 }, pushed: false, detail: "Committed abc1234" }));
    let status: Record<string, unknown> = NO_REQUEST;
    const review = vi.fn(async (command: string, input?: unknown) => {
      if (command === "pr-status") return (input as { workspace?: string } | undefined)?.workspace ? { request: status.request } : status;
      if (command === "pr-draft") return { title: "Review every changed file", body: "## Summary\nAll of it.", base: "main", generated: true };
      if (command === "pr-create") {
        status = { ...NO_REQUEST, request: OPEN_REQUEST };
        return { status, url: OPEN_REQUEST.url };
      }
      return undefined;
    });
    renderApp(workbench({ commit }, review), { extensions: [workspaceExtension, reviewExtension] });

    fireEvent.click(await screen.findByRole("button", { name: "Changes" }));
    expect(await screen.findByText("No PR for feat/review")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Commit & create PR…" }));

    await waitFor(() => expect(commit).toHaveBeenCalledWith("Update a", false));
    expect(await screen.findByDisplayValue("Review every changed file")).toBeTruthy();
    expect(review).not.toHaveBeenCalledWith("pr-create", expect.anything());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Create draft PR" }));

    await waitFor(() => expect(review).toHaveBeenCalledWith("pr-create", { title: "Review every changed file", body: "## Summary\nAll of it.", base: "main", draft: true }));
    expect(await screen.findByRole("button", { name: "PR #7" })).toBeTruthy();
    expect(screen.getByText("draft")).toBeTruthy();
    expect(screen.getByText("checks 1 pending")).toBeTruthy();
  });

  it("opens the request as a stage tab from the Changes panel, read through the kit's own host commands", async () => {
    const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
    const review = vi.fn(async (command: string) => {
      if (command === "pr-status") return { ...NO_REQUEST, request: OPEN_REQUEST };
      if (command === "pr-view") return parseGitHubDetail(parseRequestUrl(OPEN_REQUEST.url)!, fixture("gh-pr-view-discussed.json"));
      if (command === "pr-checks") return [];
      if (command === "pr-comments") return parseGitHubThreads(fixture("gh-pr-threads-discussed.json")).threads;
      return undefined;
    });
    renderApp(workbench({}, review), { extensions: [workspaceExtension, reviewExtension] });

    fireEvent.click(await screen.findByRole("button", { name: "Changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "PR #7" }));

    expect(await screen.findByRole("heading", { name: "Add the output helper" })).toBeTruthy();
    expect(review).toHaveBeenCalledWith("pr-view", { url: OPEN_REQUEST.url });
    expect(await screen.findByText("The offset counts the chunk's end.")).toBeTruthy();
  });

  it("asks before merging and merges with the chosen method", async () => {
    let status: Record<string, unknown> = { ...NO_REQUEST, request: { ...OPEN_REQUEST, draft: false } };
    const review = vi.fn(async (command: string) => {
      if (command === "pr-status") return status;
      if (command === "pr-merge") {
        status = { ...NO_REQUEST, request: { ...OPEN_REQUEST, draft: false, state: "merged" } };
        return status;
      }
      return undefined;
    });
    renderApp(workbench({}, review), { extensions: [workspaceExtension, reviewExtension] });

    fireEvent.click(await screen.findByRole("button", { name: "Changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Merge…" }));
    expect(screen.getByText(/Merge PR #7 into/u)).toBeTruthy();
    expect(review).not.toHaveBeenCalledWith("pr-merge", expect.anything());
    fireEvent.click(screen.getByRole("radio", { name: "Rebase" }));
    // A check is still running, so the host could merge it later; merging now stays one click away.
    expect(screen.getByRole("button", { name: "Enable auto-merge" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Merge now" }));

    await waitFor(() => expect(review).toHaveBeenCalledWith("pr-merge", { method: "rebase" }));
    expect(await screen.findByText("merged")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Merge…" })).toBeNull();
  });

  it("arms auto-merge, deletes the branch when asked, and disarms it again", async () => {
    let status: Record<string, unknown> = { ...NO_REQUEST, request: { ...OPEN_REQUEST, draft: false, headRef: "feature/pr" } };
    const review = vi.fn(async (command: string, input?: unknown) => {
      if (command === "pr-status") return status;
      if (command === "pr-auto-merge") {
        const enable = (input as { enable: boolean }).enable;
        status = { ...NO_REQUEST, request: { ...OPEN_REQUEST, draft: false, headRef: "feature/pr", ...(enable ? { autoMerge: { method: "squash" } } : {}) } };
        return status;
      }
      if (command === "pr-merge") return { ...NO_REQUEST, request: { ...OPEN_REQUEST, state: "merged" }, merge: { branchDeleted: "feature/pr" } };
      return undefined;
    });
    renderApp(workbench({}, review), { extensions: [workspaceExtension, reviewExtension] });

    fireEvent.click(await screen.findByRole("button", { name: "Changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Merge…" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Delete feature\/pr after merging/u }));
    fireEvent.click(screen.getByRole("button", { name: "Enable auto-merge" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("pr-auto-merge", { enable: true, method: "squash", deleteBranch: true }));
    expect(await screen.findByText("auto-merge · squash")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Disable auto-merge" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("pr-auto-merge", { enable: false }));
    await waitFor(() => expect(screen.queryByText("auto-merge · squash")).toBeNull());
  });

  it("edits the title and marks the request ready", async () => {
    const review = vi.fn(async (command: string) => {
      if (command === "pr-status" || command === "pr-edit") return { ...NO_REQUEST, request: OPEN_REQUEST };
      return undefined;
    });
    renderApp(workbench({}, review), { extensions: [workspaceExtension, reviewExtension] });

    fireEvent.click(await screen.findByRole("button", { name: "Changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "PR title" }), { target: { value: "Review it all" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(review).toHaveBeenCalledWith("pr-edit", { title: "Review it all", draft: false }));
  });

  it("says what is missing instead of offering a step that cannot work", async () => {
    const review = vi.fn(async (command: string) => (command === "pr-status"
      ? { ...NO_REQUEST, problem: "GitHub CLI (gh) is not installed or not on your PATH." }
      : undefined));
    renderApp(workbench({}, review), { extensions: [workspaceExtension, reviewExtension] });

    fireEvent.click(await screen.findByRole("button", { name: "Changes" }));
    expect(await screen.findByText("GitHub CLI (gh) is not installed or not on your PATH.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /create PR/u })).toBeNull();
  });

  it("shows the request and its checks on the thread's rail row", async () => {
    const review = vi.fn(async (command: string, input?: unknown) => {
      if (command === "pr-status" && (input as { workspace?: string } | undefined)?.workspace === "/project") return { request: OPEN_REQUEST };
      if (command === "pr-status") return NO_REQUEST;
      return undefined;
    });
    // The rail is virtualized; give it a height so jsdom draws its rows.
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(800);
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(300);
    try {
      renderApp(workbench({}, review, [SESSION]), { extensions: [workspaceExtension, reviewExtension] });

      const badge = await screen.findByLabelText("PR #7 draft, checks 1 pending");
      expect(badge.closest(".thread-row")).not.toBeNull();
      expect(review.mock.calls.filter(([command, input]) => command === "pr-status" && (input as { workspace?: string } | undefined)?.workspace)).toHaveLength(1);
    } finally {
      height.mockRestore();
      width.mockRestore();
    }
  });
});
