// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiSetupStage, UiWorktreeSetup } from "./protocol.js";
import { SetupCard, setupsOnScreen } from "./setup-card.js";

afterEach(cleanup);

const stage = (id: string, status: UiSetupStage["status"], patch: Partial<UiSetupStage> = {}): UiSetupStage => ({
  id, label: id === "fetch" ? "Fetch base branch" : id === "checkout" ? "Create worktree" : "Install", status, tail: [], ...patch,
});

const setup = (patch: Partial<UiWorktreeSetup> = {}): UiWorktreeSetup => ({
  id: "s1",
  project: "/repo",
  worktree: "/repo-worktrees/tau-x",
  branch: "tau/x",
  phase: "running",
  startedAt: 1_000,
  stages: [
    stage("fetch", "done", { startedAt: 1_000, endedAt: 2_000 }),
    stage("checkout", "done", { startedAt: 2_000, endedAt: 3_000 }),
    stage("script:install", "running", { startedAt: 3_000, tail: ["resolving", "added 3 packages"], command: "npm ci", runId: "r1" }),
  ],
  ...patch,
});

describe("which setups the screen shows", () => {
  it("follows the new thread from its checkout to its worktree", () => {
    const running = setup();
    expect(setupsOnScreen([running], { cwd: "/repo/", draftPending: true })).toEqual([running]);
    expect(setupsOnScreen([running], { cwd: "/repo", draftPending: false })).toEqual([]);
    expect(setupsOnScreen([running], { cwd: "/repo-worktrees/tau-x", draftPending: false })).toEqual([running]);
    // Once the thread may start, the draft no longer waits on the setup.
    expect(setupsOnScreen([setup({ released: true })], { cwd: "/repo", draftPending: true })).toEqual([]);
  });

  it("drops a clean finish and keeps a failure until it is dismissed", () => {
    const clean = setup({ phase: "done", stages: [stage("checkout", "done"), stage("script:install", "done")] });
    const failed = setup({ id: "s2", phase: "done", stages: [stage("checkout", "done"), stage("script:install", "failed", { detail: "exit 1" })] });
    expect(setupsOnScreen([clean, failed], { cwd: "/repo-worktrees/tau-x", draftPending: false })).toEqual([failed]);
  });
});

describe("the setup card", () => {
  it("shows every step, the script's last lines and the two ways out of a blocking script", async () => {
    const actions = { cancel: vi.fn(async () => undefined), release: vi.fn(async () => undefined), dismiss: vi.fn(async () => undefined) };
    render(<SetupCard setup={setup()} actions={actions} notify={() => undefined} />);
    expect(screen.getByText("Setting up worktree…")).toBeTruthy();
    expect(screen.getByText("Fetch base branch")).toBeTruthy();
    expect(screen.getByText("added 3 packages")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Start now/u }));
    await waitFor(() => expect(actions.release).toHaveBeenCalledWith("s1"));
    fireEvent.click(screen.getByRole("button", { name: /Cancel/u }));
    await waitFor(() => expect(actions.cancel).toHaveBeenCalledWith("s1"));
    fireEvent.click(screen.getByRole("button", { name: /Details/u }));
    expect(screen.getByText("npm ci")).toBeTruthy();
  });

  it("says what ended the setup and offers to dismiss it", async () => {
    const actions = { cancel: vi.fn(async () => undefined), release: vi.fn(async () => undefined), dismiss: vi.fn(async () => undefined) };
    const cancelled = setup({
      phase: "cancelled",
      endedAt: 9_000,
      stages: [stage("checkout", "done"), stage("script:install", "skipped", { detail: "cancelled" })],
    });
    render(<SetupCard setup={cancelled} actions={actions} notify={() => undefined} />);
    expect(screen.getByText("Worktree setup cancelled")).toBeTruthy();
    expect(screen.getByText("8s")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Cancel/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(actions.dismiss).toHaveBeenCalledWith("s1"));
  });
});
