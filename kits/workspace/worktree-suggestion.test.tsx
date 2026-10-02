// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NewThreadResult } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { createMemoryStorage, setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { WORKTREE_SUGGESTION_REASON } from "./branch-menu.js";
import { workspaceExtension } from "./desktop.js";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

const REPO = { root: "/project", isRepo: true, isDirty: false, branch: "main", worktrees: [], refs: [{ name: "main", isCurrent: true }], worktreeParent: "/project-worktrees" };

/** A project whose thread "busy" has a turn running in `busyIn`; the window shows another, idle thread. */
function start(busyIn: string) {
  const createWorktree = vi.fn(async () => ({ workspaceId: "ws1_worktree", displayPath: "/project-worktrees/fix-header" }));
  const newSession = vi.fn(async (): Promise<NewThreadResult> => ({ version: 1, updates: [], submission: { accepted: true } }));
  const thread = (id: string, projectPath: string) => ({ id, path: `/${id}.jsonl`, title: id, modifiedAt: 1, projectPath, projectName: projectPath.slice(1), messageCount: 2 });
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: {
        projects: [{ path: "/project", name: "project", lastOpenedAt: 2 }],
        sessions: [thread("idle", "/project"), thread("busy", busyIn)],
        runs: { busy: 1 },
      },
      detail: { sessionId: "idle", messages: [{ id: "answer", role: "assistant", text: "Idle answer", timestamp: 1 }], isStreaming: false, activeTools: [] },
      catalog: { sessionId: "idle", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
      project: { cwd: "/project" },
    }),
    invokeHostExtension: workspaceHostStub({
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => REPO,
      getWorktreeBase: async () => ({ ref: "main", commit: "abc1234", shortCommit: "abc1234", fromOrigin: false }),
      getFileTree: async () => [],
      createWorktree,
    }, { "tau.thread-titles": async () => undefined }),
    newSession,
  });
  renderApp(client, { storage: createMemoryStorage(), extensions: [workspaceExtension] });
  return { createWorktree, newSession };
}

async function openDraft(): Promise<HTMLElement> {
  await screen.findByText("Idle answer");
  fireEvent.click(await screen.findByRole("button", { name: "New thread" }));
  const heading = await screen.findByRole("heading", { name: "What should project do next?" });
  return heading.parentElement!.querySelector(".region-draft-actions") as HTMLElement;
}

describe("a new thread's worktree suggestion (K125)", () => {
  it("offers its own worktree, preselected, while another thread's turn runs in the same folder; sending creates it", async () => {
    const { createWorktree, newSession } = start("/project");
    const pills = await openDraft();
    const suggestion = await within(pills).findByRole("switch", { name: "Start in its own worktree" });
    await waitFor(() => expect(suggestion.getAttribute("aria-checked")).toBe("true"));
    expect(suggestion.closest("label")?.getAttribute("data-tooltip")).toBe(WORKTREE_SUGGESTION_REASON);
    expect(await screen.findByRole("button", { name: /, branch tau\/…$/u })).toBeTruthy();

    // Deselectable: the Run-on pill goes back to the checkout's branch.
    fireEvent.click(suggestion);
    await waitFor(() => expect(suggestion.getAttribute("aria-checked")).toBe("false"));
    expect(await screen.findByRole("button", { name: /, branch main$/u })).toBeTruthy();
    fireEvent.click(suggestion);
    await waitFor(() => expect(suggestion.getAttribute("aria-checked")).toBe("true"));

    const composer = await screen.findByPlaceholderText(/Ask anything/u);
    fireEvent.change(composer, { target: { value: "Fix the header" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1));
    expect(createWorktree.mock.calls[0]).toEqual([expect.stringMatching(/^tau\/[0-9a-f]{8}$/u), expect.objectContaining({ startFromOrigin: true }), "/project"]);
    await waitFor(() => expect(newSession).toHaveBeenCalledTimes(1));
    expect(newSession.mock.calls[0]).toEqual(expect.arrayContaining(["ws1_worktree"]));
  });

  it("starts in the checkout as before when the suggestion is turned off", async () => {
    const { createWorktree, newSession } = start("/project");
    const pills = await openDraft();
    const suggestion = await within(pills).findByRole("switch", { name: "Start in its own worktree" });
    await waitFor(() => expect(suggestion.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(suggestion);
    await waitFor(() => expect(suggestion.getAttribute("aria-checked")).toBe("false"));

    const composer = await screen.findByPlaceholderText(/Ask anything/u);
    fireEvent.change(composer, { target: { value: "Fix the header" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledTimes(1));
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("offers nothing while the running turn is in another folder", async () => {
    start("/elsewhere");
    const pills = await openDraft();
    // The Run-on pill's branch comes from the same Git read the suggestion waits for.
    expect(await screen.findByRole("button", { name: /, branch main$/u })).toBeTruthy();
    expect(within(pills).queryByRole("switch", { name: "Start in its own worktree" })).toBeNull();
  });
});
