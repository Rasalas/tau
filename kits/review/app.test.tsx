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
/** Changes opens the same Diff stage tab as the primary stage action. */
async function openChanges(): Promise<void> {
  await screen.findByRole("button", { name: "Branch feat/review" });
  fireEvent.click(await screen.findByRole("button", { name: "Diff" }));
}

/** The project card, opened from the stage bar's Project actions. */
async function openProjectCard(): Promise<HTMLElement> {
  const trigger = await screen.findByRole("button", { name: "Project actions" });
  if (trigger.getAttribute("aria-haspopup") === "dialog") {
    fireEvent.click(trigger);
    const menu = await screen.findByRole("dialog", { name: "Project actions" });
    return within(menu).findByRole("region", { name: "Project workspace" });
  }
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  return screen.findByRole("region", { name: "Project workspace" });
}

/** The Git button leads to the commit card; the review stays a way in its menu. */
async function openStageReview(): Promise<void> {
  const card = await openProjectCard();
  fireEvent.click(await within(card).findByRole("button", { name: "Choose Git action" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /^Review changes/u }));
}

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
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveProperty("value", "fix: review from another package"));
  });

  it("opens Diff, stages a file, then commits through stage review", async () => {
    const commit = vi.fn(async () => ({ changes: { files: [], added: 0, removed: 0 }, pushed: true, detail: "Committed and pushed." }));
    let hostChanges = CHANGES;
    const stage = vi.fn(async () => (hostChanges = { files: [{ path: "src/a.ts", name: "a.ts", directory: "src", status: "modified", added: 1, removed: 0, staged: true }], added: 1, removed: 0, branch: "feat/review" }));
    renderApp(workbench({ commit, stageFile: stage, getChanges: async () => hostChanges }), { extensions: [workspaceExtension, reviewExtension] });

    await openChanges();
    await screen.findByRole("button", { name: "Branch vs target" });
    expect(document.querySelector(".review-embedded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to thread" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Stage src/a.ts" }));
    await waitFor(() => expect(stage).toHaveBeenCalled());
    expect(await screen.findByRole("region", { name: "Commit" })).toBeTruthy();
    await openStageReview();
    const bar = await screen.findByRole("region", { name: "Commit" });
    expect(screen.queryByRole("button", { name: "Back to thread" })).toBeNull();
    await waitFor(() => expect(within(bar).getByRole("button", { name: "Commit & push" }).getAttribute("title")).toContain("Commits the 1 staged file on feat/review"));

    const message = within(bar).getByRole("textbox", { name: "Commit message" });
    await waitFor(() => {
      expect(document.querySelector(".diff-code")?.textContent).toContain("const reviewed = true;");
      expect(message).toHaveProperty("disabled", false);
    });
    fireEvent.change(message, { target: { value: "feat(review): commit from the review" } });
    const commitButton = within(bar).getByRole("button", { name: /Commit & push/u });
    await waitFor(() => {
      expect(message).toHaveProperty("value", "feat(review): commit from the review");
      expect(commitButton).toHaveProperty("disabled", false);
    });
    fireEvent.click(commitButton);
    await waitFor(() => expect(commit).toHaveBeenCalledWith("feat(review): commit from the review", true));
  });

  it("opens the stage review over a changed file and proposes a commit message", async () => {
    const suggest = vi.fn(async () => ({ message: "feat(review): describe the change" }));
    renderApp(workbench({}, suggest), { extensions: [workspaceExtension, reviewExtension] });

    await openStageReview();

    await waitFor(() => expect(document.querySelector(".diff-code")?.textContent).toContain("const reviewed = true;"));
    await waitFor(() => expect(suggest).toHaveBeenCalledWith("suggest-commit-message", expect.objectContaining({
      provider: "openai",
      modelId: "gpt-luna",
      style: "conventional",
      branch: "feat/review",
      files: [{ path: "src/a.ts", added: 1, removed: 0 }],
    })));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Commit message" }) as HTMLTextAreaElement).value).toBe("feat(review): describe the change"));
  });

  it("says in the commit box, not in a toast, why no message was written", async () => {
    const suggest = vi.fn(async (command: string) => {
      if (command === "suggest-commit-message") throw new Error("Provider is not configured: openai");
      return undefined;
    });
    renderApp(workbench({}, suggest), { extensions: [workspaceExtension, reviewExtension] });

    await openStageReview();

    const hint = await waitFor(() => {
      const found = document.querySelector(".review-commit .review-commit-note");
      expect(found?.textContent?.trim()).toBe("Could not write a message from the diff: openai is not set up.");
      return found;
    });
    expect(hint).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveProperty("value", "Update a");
    expect(screen.getAllByText(/openai is not set up/u)).toHaveLength(1);
  });

  it("comments on a line and hands the comment to the composer as a chip", async () => {
    renderApp(workbench(), { extensions: [workspaceExtension, reviewExtension, composerContext] });

    await openStageReview();
    fireEvent.click(await screen.findByRole("button", { name: "Comment on line 1" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Comment" }), { target: { value: "Name it after what it checks." } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(await screen.findByText("Name it after what it checks.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 comment" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send to composer" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Back to thread" })).toBeNull());
    // The chip sits in the prompt's text; its popover shows the comment.
    const composer = screen.getByPlaceholderText(/Ask anything/u) as HTMLTextAreaElement;
    await waitFor(() => expect(plainChipText(composer.value)).toContain("a.ts:1"));
    fireEvent.click(screen.getByRole("button", { name: "Chip a.ts:1" }));
    expect((await screen.findByRole("dialog", { name: "a.ts:1" })).textContent).toContain("Name it after what it checks.");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    await openStageReview();
    expect(await screen.findByRole("button", { name: "0 comments" })).toBeTruthy();
  });

  it("returns to the thread after committing from the stage review", async () => {
    const commit = vi.fn(async () => ({ changes: { files: [], added: 0, removed: 0 }, pushed: false, detail: "Committed abc1234" }));
    const suggest = vi.fn(async () => ({ message: "fix(review): restore commit flow" }));
    renderApp(workbench({ commit }, suggest), { extensions: [workspaceExtension, reviewExtension] });

    await openStageReview();
    const bar = await screen.findByRole("region", { name: "Commit" });
    await waitFor(() => expect((within(bar).getByRole("textbox", { name: "Commit message" }) as HTMLTextAreaElement).value).toBe("fix(review): restore commit flow"));
    expect(within(bar).getByRole("button", { name: "Commit & push" }).getAttribute("title")).toBe("Commits all 1 changed file on feat/review, then pushes feat/review.");

    // Local commit sits behind the arrow; the lead action is the push.
    fireEvent.click(within(bar).getByRole("button", { name: "More ways to commit" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Commit\b(?! &)/u }));

    await waitFor(() => expect(commit).toHaveBeenCalledWith("fix(review): restore commit flow", false));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Back to thread" })).toBeNull());
  });
});

const NO_REQUEST = { branch: "feat/review", base: "main", remote: "git@github.com:acme/tau.git", service: "github" };
/** What the Local PR tab asks besides the request's status. */
const LOCAL_PR = {
  "local-pr": { root: "/project", branch: "feat/review", base: "main", commits: [], forkedAt: 0 },
  "local-pr-evidence": { available: false, evidence: [] },
};
const OPEN_REQUEST = { headSha: "seen-head", provider: "github", number: 7, title: "Review everything", url: "https://github.com/acme/tau/pull/7", baseRef: "main", state: "open", draft: true, body: "Why", checks: { passed: 2, failed: 0, pending: 1, total: 3 } };

/**
 * The request lifecycle through the kit's own host commands: the section above
 * the review's file list, which the Changes entry opens, and the mark on the thread's rail row.
 */
describe("Review Kit request lifecycle in the workbench", () => {
  it("opens the one card from the review's commit menu and commits, pushes and creates a draft from it", async () => {
    const commit = vi.fn(async () => ({ changes: { files: [], added: 0, removed: 0 }, pushed: false, detail: "Committed abc1234" }));
    const push = vi.fn(async () => ({ detail: "Pushed abc1234" }));
    let status: Record<string, unknown> = NO_REQUEST;
    const review = vi.fn(async (command: string, input?: unknown) => {
      if (command === "pr-status") return (input as { full?: boolean; workspace?: string } | undefined)?.workspace && !(input as { full?: boolean }).full ? { request: status.request } : status;
      if (command === "local-pr-describe") return { title: "Review every changed file", body: "## Summary\nAll of it.", base: "main", generated: true };
      if (command === "pr-create") {
        status = { ...NO_REQUEST, request: OPEN_REQUEST };
        return { status, url: OPEN_REQUEST.url };
      }
      return LOCAL_PR[command as keyof typeof LOCAL_PR];
    });
    renderApp(workbench({ commit, push }, review), { extensions: [workspaceExtension, reviewExtension] });

    await openStageReview();
    expect(await screen.findByText("No PR for feat/review")).toBeTruthy();
    // Only one Commit button is on screen; creating the request is a step in its menu, once the message is drafted.
    const bar = await screen.findByRole("region", { name: "Commit" });
    expect(screen.queryByRole("button", { name: "Commit & create PR…" })).toBeNull();
    const more = within(bar).getByRole("button", { name: "More ways to commit" }) as HTMLButtonElement;
    await waitFor(() => expect(more.disabled).toBe(false));
    fireEvent.click(more);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Commit & create PR…/u }));

    // The card takes the review's message, shows the files, and has the description written for the commit that is not made yet.
    const card = await screen.findByRole("dialog", { name: "Commit, push & PR" });
    expect((within(card).getByRole("textbox", { name: "Commit message" }) as HTMLTextAreaElement).value).toBe("Update a");
    expect(within(card).getByLabelText("1 changed file").textContent).toContain("a.ts");
    await waitFor(() => expect((within(card).getByRole("textbox", { name: "PR title" }) as HTMLInputElement).value).toBe("Review every changed file"));
    expect(review).toHaveBeenCalledWith("local-pr-describe", expect.objectContaining({ pending: { message: "Update a", files: [{ path: "src/a.ts", added: 1, removed: 0 }] } }));
    expect(commit).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("checkbox", { name: "Draft" }));
    fireEvent.click(within(card).getByRole("button", { name: "Commit, push & PR" }));

    await waitFor(() => expect(review).toHaveBeenCalledWith("pr-create", { workspace: "/project", branch: "feat/review", title: "Review every changed file", body: "## Summary\nAll of it.", base: "", draft: true }));
    expect(commit).toHaveBeenCalledWith("Update a", false);
    expect(push).toHaveBeenCalledOnce();
    expect(await screen.findByText("PR #7 created as draft.")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Commit, push & PR" })).toBeNull();
  });

  it("takes a thread with changes and no upstream to an open pull request with one click and a confirmation", async () => {
    const commit = vi.fn(async () => ({ changes: { files: [], added: 0, removed: 0 }, pushed: false, detail: "Committed abc1234" }));
    const push = vi.fn(async () => ({ detail: "Pushed abc1234" }));
    let status: Record<string, unknown> = NO_REQUEST;
    const review = vi.fn(async (command: string, input?: unknown) => {
      if (command === "pr-status") return (input as { full?: boolean; workspace?: string } | undefined)?.workspace && !(input as { full?: boolean }).full ? { request: status.request } : status;
      if (command === "suggest-commit-message") return { message: "feat(review): preview the request" };
      if (command === "local-pr-describe") return { title: "Preview the request", body: "Shows the files first.", base: "main", generated: true };
      if (command === "pr-create") {
        status = { ...NO_REQUEST, request: OPEN_REQUEST };
        return { status, url: OPEN_REQUEST.url };
      }
      return LOCAL_PR[command as keyof typeof LOCAL_PR];
    });
    renderApp(workbench({ commit, push, getWorkspaceInfo: async () => ({ ...WORKSPACE, upstream: undefined }) }, review), { extensions: [workspaceExtension, reviewExtension] });

    const card = await openProjectCard();
    fireEvent.click(await within(card).findByRole("button", { name: "Commit, push & PR" }));

    const dialog = await screen.findByRole("dialog", { name: "Commit, push & PR" });
    await waitFor(() => expect((within(dialog).getByRole("textbox", { name: "Commit message" }) as HTMLTextAreaElement).value).toBe("feat(review): preview the request"));
    await waitFor(() => expect((within(dialog).getByRole("textbox", { name: "PR title" }) as HTMLInputElement).value).toBe("Preview the request"));
    expect(review).toHaveBeenCalledWith("local-pr-describe", expect.objectContaining({ pending: expect.objectContaining({ message: "feat(review): preview the request" }) }));
    expect(commit).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Commit, push & PR" }));

    await waitFor(() => expect(review).toHaveBeenCalledWith("pr-create", { workspace: "/project", branch: "feat/review", title: "Preview the request", body: "Shows the files first.", base: "", draft: false }));
    expect(commit).toHaveBeenCalledWith("feat(review): preview the request", false);
    expect(push).toHaveBeenCalledOnce();
    expect(await screen.findByText("PR #7 created.")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Commit, push & PR" })).toBeNull();
  });

  it("stays open at the step that failed, names it, keeps what worked, and continues there", async () => {
    const commit = vi.fn(async () => ({ changes: { files: [], added: 0, removed: 0 }, pushed: false, detail: "Committed abc1234" }));
    const push = vi.fn(async () => ({ detail: "Pushed abc1234" }));
    push.mockRejectedValueOnce(new Error("remote: permission denied"));
    const review = vi.fn(async (command: string, input?: unknown) => {
      if (command === "pr-status") return (input as { full?: boolean; workspace?: string } | undefined)?.workspace && !(input as { full?: boolean }).full ? {} : NO_REQUEST;
      if (command === "local-pr-describe") return { title: "Preview the request", body: "Shows the files first.", base: "main", generated: true };
      if (command === "pr-create") return { status: { ...NO_REQUEST, request: OPEN_REQUEST }, url: OPEN_REQUEST.url };
      return LOCAL_PR[command as keyof typeof LOCAL_PR];
    });
    renderApp(workbench({ commit, push }, review), { extensions: [workspaceExtension, reviewExtension] });

    const card = await openProjectCard();
    fireEvent.click(await within(card).findByRole("button", { name: "Commit, push & PR" }));
    const dialog = await screen.findByRole("dialog", { name: "Commit, push & PR" });
    await waitFor(() => expect((within(dialog).getByRole("textbox", { name: "PR title" }) as HTMLInputElement).value).toBe("Preview the request"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Commit, push & PR" }));

    // The error toast carries the reason; the card names the step and offers to go on.
    expect(await screen.findByText("Pushing failed: remote: permission denied")).toBeTruthy();
    const retry = await within(dialog).findByRole("button", { name: "Try again" });
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    const steps = within(dialog).getByRole("list", { name: "Progress" });
    expect(within(steps).getByText("Committed")).toBeTruthy();
    expect(within(steps).getByText("Pushing failed")).toBeTruthy();
    expect(review).not.toHaveBeenCalledWith("pr-create", expect.anything());
    expect((within(dialog).getByRole("textbox", { name: "Commit message" }) as HTMLTextAreaElement).disabled).toBe(true);

    fireEvent.click(retry);
    await waitFor(() => expect(review).toHaveBeenCalledWith("pr-create", expect.anything()));
    expect(commit).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Commit, push & PR" })).toBeNull());
  });

  it("leads the Git button to the same form once the branch is committed, and the form writes itself", async () => {
    const clean = { branch: "feat/review", files: [], fileCount: 0, added: 0, removed: 0 };
    const review = vi.fn(async (command: string, input?: unknown) => {
      if (command === "pr-status") return (input as { full?: boolean; workspace?: string } | undefined)?.workspace && !(input as { full?: boolean }).full ? {} : NO_REQUEST;
      if (command === "local-pr") return { ...LOCAL_PR["local-pr"], commits: [{ sha: "c1", subject: "feat: add the card", body: "", at: 1_000 }] };
      if (command === "local-pr-describe") return { title: "Add the card", body: "It previews the request.", base: "main", generated: true };
      if (command === "pr-create") return { status: { ...NO_REQUEST, request: OPEN_REQUEST }, url: OPEN_REQUEST.url };
      return LOCAL_PR[command as keyof typeof LOCAL_PR];
    });
    renderApp(workbench({ getChanges: async () => clean, getWorkspaceInfo: async () => ({ ...WORKSPACE, isDirty: false, ahead: 1 }) }, review), { extensions: [workspaceExtension, reviewExtension] });

    const card = await openProjectCard();
    fireEvent.click(await within(card).findByRole("button", { name: "Create PR" }));

    // Opened empty, the form wrote the title and description from the commits.
    await waitFor(() => expect((screen.getByRole("textbox", { name: "PR title" }) as HTMLInputElement).value).toBe("Add the card"));
    fireEvent.click(screen.getByRole("button", { name: "Create PR…" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("pr-create", { workspace: "/project", branch: "feat/review", title: "Add the card", body: "It previews the request.", base: "main", draft: false }));
  });

  it("opens the request as a stage tab from the review, read through the kit's own host commands", async () => {
    const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
    const review = vi.fn(async (command: string) => {
      if (command === "pr-status") return { ...NO_REQUEST, request: OPEN_REQUEST };
      if (command === "pr-view") return parseGitHubDetail(parseRequestUrl(OPEN_REQUEST.url)!, fixture("gh-pr-view-discussed.json"));
      if (command === "pr-checks") return [];
      if (command === "pr-comments") return parseGitHubThreads(fixture("gh-pr-threads-discussed.json")).threads;
      return undefined;
    });
    renderApp(workbench({}, review), { extensions: [workspaceExtension, reviewExtension] });

    await openStageReview();
    fireEvent.click(await screen.findByRole("button", { name: "PR #7" }));

    expect(await screen.findByRole("heading", { name: "Add the output helper" })).toBeTruthy();
    // The review stepped aside for the tab.
    expect(screen.queryByRole("button", { name: "Back to thread" })).toBeNull();
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

    await openStageReview();
    fireEvent.click(await screen.findByRole("button", { name: "Merge…" }));
    expect(screen.getByText(/Merge PR #7 into/u)).toBeTruthy();
    expect(review).not.toHaveBeenCalledWith("pr-merge", expect.anything());
    fireEvent.click(screen.getByRole("radio", { name: "Rebase" }));
    // A check is still running, so the host could merge it later; merging now stays one click away.
    expect(screen.getByRole("button", { name: "Enable auto-merge" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Merge now" }));

    await waitFor(() => expect(review).toHaveBeenCalledWith("pr-merge", { workspace: "/project", number: OPEN_REQUEST.number, headSha: "seen-head", method: "rebase" }));
    expect(await screen.findByRole("img", { name: "Merged" })).toBeTruthy();
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

    await openStageReview();
    fireEvent.click(await screen.findByRole("button", { name: "Merge…" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Delete feature\/pr after merging/u }));
    fireEvent.click(screen.getByRole("button", { name: "Enable auto-merge" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("pr-auto-merge", { workspace: "/project", number: OPEN_REQUEST.number, headSha: "seen-head", enable: true, method: "squash", deleteBranch: true }));
    expect(await screen.findByText("auto-merge · squash")).toBeTruthy();

    // The request's line shows the new status before the actions come back.
    fireEvent.click(await screen.findByRole("button", { name: "Disable auto-merge" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("pr-auto-merge", { workspace: "/project", number: OPEN_REQUEST.number, headSha: "seen-head", enable: false }));
    await waitFor(() => expect(screen.queryByText("auto-merge · squash")).toBeNull());
  });

  it("edits the title and marks the request ready", async () => {
    const review = vi.fn(async (command: string) => {
      if (command === "pr-status" || command === "pr-edit") return { ...NO_REQUEST, request: OPEN_REQUEST };
      return undefined;
    });
    renderApp(workbench({}, review), { extensions: [workspaceExtension, reviewExtension] });

    await openStageReview();
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

    await openStageReview();
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
