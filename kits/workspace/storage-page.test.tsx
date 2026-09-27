// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { missingSettingsRows } from "../../src/renderer/test-support/kit-settings-page.js";
import { createStoragePage, formatBytes, STORAGE_SETTINGS_ROWS, type StorageHost } from "./storage-page.js";
import type { CleanupPolicy, UiStorageReport, UiStorageWorktree } from "./storage-protocol.js";
import { EMPTY_POLICY, NO_CLEANUP, patchPolicy } from "./worktree-cleanup.js";

afterEach(cleanup);

const NOW = Date.UTC(2026, 8, 22, 12);

function tree(overrides: Partial<UiStorageWorktree>): UiStorageWorktree {
  return {
    path: "/work/repo-worktrees/tau-a",
    repository: "/work/repo",
    repositoryName: "repo",
    branch: "tau/a",
    createdAt: NOW - 3 * 86_400_000,
    lastActivityAt: NOW - 3 * 86_400_000,
    sizeBytes: 5 * 1024 * 1024,
    threadIds: [],
    dirtyFiles: 0,
    unpushedCommits: 0,
    commitsBeyondBase: 0,
    rules: NO_CLEANUP,
    verdict: { remove: false, reasons: [], blockers: [] },
    ...overrides,
  };
}

function fakeHost(initial: UiStorageReport) {
  let report = initial;
  const listeners = new Set<() => void>();
  const host: StorageHost & { setReport(next: UiStorageReport): void } = {
    report: vi.fn(async () => report),
    setPolicy: vi.fn(async (patch) => {
      const policy: CleanupPolicy = patchPolicy(report.policy, patch);
      report = { ...report, policy };
      return policy;
    }),
    cleanUp: vi.fn(async (paths: string[]) => ({ removed: paths, kept: [] })),
    remove: vi.fn(async (_path: string, confirm: boolean) => confirm
      ? { removed: true as const }
      : { removed: false as const, confirm: ["uncommitted" as const], dirtyFiles: 2, unpushedCommits: 0 }),
    onChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    setReport: (next) => { report = next; for (const listener of listeners) listener(); },
  };
  return host;
}

const report = (worktrees: UiStorageWorktree[], policy: CleanupPolicy = EMPTY_POLICY): UiStorageReport => ({
  worktrees,
  totalBytes: worktrees.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
  policy,
  currentRepository: { path: "/work/repo", name: "repo" },
  generatedAt: NOW,
});

describe("Settings → Storage", () => {
  it("lists every worktree with its size and says what the next cleanup removes", async () => {
    const due = tree({ path: "/w/due", branch: "tau/due", verdict: { remove: true, reasons: ["unchanged"], blockers: [] } });
    const kept = tree({ path: "/w/kept", branch: "tau/kept", dirtyFiles: 2, verdict: { remove: false, reasons: ["unchanged"], blockers: ["uncommitted"] } });
    const host = fakeHost(report([due, kept], patchPolicy(EMPTY_POLICY, { rules: { unchanged: true } })));
    const Page = createStoragePage(host);
    render(<Page onNotify={() => undefined} />);

    const list = await screen.findByRole("list", { name: "Worktrees" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Worktrees · 10 MB")).toBeTruthy();
    expect(screen.getByText("Next cleanup · unchanged")).toBeTruthy();
    expect(screen.getByText("Kept · uncommitted changes")).toBeTruthy();
    expect(screen.getByText("The rules would remove 1 worktree now.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clean up 1 now" }));
    await waitFor(() => expect(host.cleanUp).toHaveBeenCalledWith(["/w/due"]));
    expect(missingSettingsRows({ rows: STORAGE_SETTINGS_ROWS })).toEqual([]);
  });

  it("asks before removing a worktree with uncommitted work", async () => {
    const host = fakeHost(report([tree({ path: "/w/dirty", dirtyFiles: 2 })]));
    const notices: string[] = [];
    const Page = createStoragePage(host);
    render(<Page onNotify={(message) => notices.push(message)} />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove /w/dirty" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("2 uncommitted files will be lost");
    expect(host.remove).toHaveBeenLastCalledWith("/w/dirty", false);
    host.setReport(report([]));
    fireEvent.click(within(alert).getByRole("button", { name: "Remove anyway" }));
    await waitFor(() => expect(host.remove).toHaveBeenLastCalledWith("/w/dirty", true));
    await waitFor(() => expect(notices).toEqual(["Removed /w/dirty; the branch tau/a stays."]));
  });

  it("switches the rules between the host and the repository on screen", async () => {
    const host = fakeHost(report([]));
    const Page = createStoragePage(host);
    render(<Page onNotify={() => undefined} />);

    fireEvent.click(await screen.findByRole("switch", { name: "Delete unchanged worktrees" }));
    await waitFor(() => expect(host.setPolicy).toHaveBeenCalledWith({ rules: { unchanged: true } }));

    const scope = screen.getByRole("radiogroup", { name: "Rules for" });
    expect(within(scope).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["This machine", "repo"]);
    fireEvent.click(within(scope).getByRole("radio", { name: "repo" }));
    expect(screen.queryByRole("switch", { name: "Delete unchanged worktrees" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    await waitFor(() => expect(host.setPolicy).toHaveBeenCalledWith({ project: "/work/repo", mode: "custom" }));
    const merged = await screen.findByRole("switch", { name: "Delete merged worktrees" });
    fireEvent.click(merged);
    await waitFor(() => expect(host.setPolicy).toHaveBeenLastCalledWith({ project: "/work/repo", mode: "custom", rules: { onMerge: true } }));
    expect(screen.getByText("No worktree Tau made is on disk")).toBeTruthy();
  });

  it("sets the days of the inactive rule, refuses what is not a whole number, and turns the rule off", async () => {
    const host = fakeHost(report([]));
    const Page = createStoragePage(host);
    render(<Page onNotify={() => undefined} />);

    fireEvent.click(await screen.findByRole("switch", { name: "Delete inactive worktrees" }));
    await waitFor(() => expect(host.setPolicy).toHaveBeenLastCalledWith({ rules: { afterDays: 8 } }));
    const days = await screen.findByRole("spinbutton", { name: "Delete inactive worktrees after" });
    fireEvent.change(days, { target: { value: "2.5" } });
    fireEvent.blur(days);
    expect(screen.getByRole("alert").textContent).toBe("Enter a whole number.");
    fireEvent.change(days, { target: { value: "30" } });
    fireEvent.blur(days);
    await waitFor(() => expect(host.setPolicy).toHaveBeenLastCalledWith({ rules: { afterDays: 30 } }));
    fireEvent.click(screen.getByRole("switch", { name: "Delete inactive worktrees" }));
    await waitFor(() => expect(host.setPolicy).toHaveBeenLastCalledWith({ rules: { afterDays: null } }));
    await waitFor(() => expect(screen.queryByRole("spinbutton", { name: "Delete inactive worktrees after" })).toBeNull());
  });

  it("says when the worktrees could not be read, and reads them again", async () => {
    const host = fakeHost(report([]));
    vi.mocked(host.report).mockRejectedValueOnce(new Error("git worktree list failed"));
    const Page = createStoragePage(host);
    render(<Page onNotify={() => undefined} />);

    expect((await screen.findByRole("alert")).textContent).toContain("git worktree list failed");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No worktree Tau made is on disk")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Measure again" }));
    await waitFor(() => expect(host.report).toHaveBeenCalledTimes(3));
  });

  it("formats sizes the way a disk tool does", () => {
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(734 * 1024 * 1024)).toBe("734 MB");
  });
});
