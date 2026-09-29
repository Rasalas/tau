// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient, PageProps, UiSession, WorkbenchActions } from "tau";
import { TestPageActionSlot, TestProviders, TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { reviewExtension } from "./desktop.js";
import { reviewKey, type LocalReviewsAnswer, type ThreadBranch } from "./local-reviews.js";
import { LocalReviewsStore } from "./local-reviews-store.js";
import { RowRequests } from "./requests.js";
import { ReviewsFilter } from "./reviews-filter.js";
import { ReviewsPage, ReviewsSidebar, shortAge, type ReviewsPageParts } from "./reviews-page.js";
import type { PullRequestClient } from "./pull-request-client.js";

afterEach(() => {
  cleanup();
  delete document.body.dataset.profile;
});

const NOW = Date.now();

const branch = (name: string, patch: Partial<ThreadBranch> = {}): ThreadBranch => ({
  path: `/work/${name}`, root: "/repo/shop-api", branch: `feat/${name}`, target: "main", tip: `${name}-tip`,
  ahead: 1, behind: 0, files: 3, added: 59, removed: 5,
  paths: [{ path: "src/PairingRequestWatcher.tsx", added: 6, removed: 3 }, { path: "src/watcher.ts", added: 12, removed: 0 }],
  uncommitted: 0, committedAt: NOW - 4 * 60_000, merged: false, conflicts: [], workspace: `ws-${name}`, rootWorkspace: "ws-shop", ...patch,
});

const thread = (id: string, workspace: string, title: string): UiSession => ({
  id, path: `/sessions/${id}.jsonl`, title, modifiedAt: NOW - 4 * 60_000, projectPath: "/work", workspaceId: workspace, projectName: "shop-api", messageCount: 2,
  modelProvider: "anthropic", model: "claude-sonnet-4-5",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd: 0.84, turns: 1 },
});

const ANSWER: LocalReviewsAnswer = {
  branches: [
    branch("pairing-flake"),
    branch("webhook-retries"),
    branch("pagination", { conflicts: ["src/routes/orders.ts"], files: 31, added: 1902, removed: 1811 }),
  ],
  asks: { [reviewKey("/repo/shop-api", "feat/webhook-retries")]: { kind: "note", text: "retry budget", at: 1, tip: "webhook-retries-tip" } },
  merged: [{ key: "old", root: "/repo/shop-api", rootWorkspace: "ws-shop", branch: "feat/old", target: "main", title: "Old work", at: NOW - 60_000, files: 1, added: 1, removed: 0, costUsd: 9.3 }],
};
const THREADS = [thread("t1", "ws-pairing-flake", "Fix flaky pairing test"), thread("t2", "ws-webhook-retries", "Write ADR for webhook retries"), thread("t3", "ws-pagination", "Add pagination to all list endpoints")];

function setup(options: { answer?: LocalReviewsAnswer; params?: Record<string, unknown>; compact?: boolean; sidebar?: boolean } = {}) {
  if (options.compact) document.body.dataset.profile = "compact";
  const invoke = vi.fn(async (command: string, input?: unknown) => {
    if (command === "local-reviews") return options.answer ?? ANSWER;
    if (command === "local-review-merge") return { branch: "feat/pairing-flake", state: "merged", files: [], detail: "Merged.", into: "main", root: "/repo/shop-api" };
    if (command === "local-review-summary") return { summary: "The watcher subscribes on construction now.", turns: 4 };
    if (command === "file-diff") return { path: (input as { relPath: string }).relPath, hunks: [], additions: 6, deletions: 3 };
    return undefined;
  });
  const host = { invoke, onEvent: () => () => undefined } as unknown as HostExtensionClient;
  const store = new LocalReviewsStore(host);
  const parts: ReviewsPageParts = {
    store,
    host,
    rows: new RowRequests(async () => undefined),
    remote: { client: { listMany: vi.fn(async () => ({ lists: [], failures: [] })) } as unknown as PullRequestClient, chips: () => undefined, rows: new RowRequests(async () => undefined), shared: {} as never },
    filter: new ReviewsFilter(),
  };
  const navigate = vi.fn();
  const toast = vi.fn();
  const switchSession = vi.fn(async () => true);
  const actions = { toast, notify: vi.fn(), switchSession, openExternal: vi.fn() } as unknown as WorkbenchActions;
  const slot = document.createElement("div");
  document.body.append(slot);
  const props: PageProps = { actions, params: options.params ?? {}, navigate, close: vi.fn(), ...(options.sidebar ? { sidebar: true } : {}) };
  const view = render(
    <TestProviders>
      <TestThreadStore threads={THREADS}>
        {options.sidebar ? <nav aria-label="Page sidebar"><ReviewsSidebar {...props} parts={parts} /></nav> : null}
        <TestPageActionSlot slot={slot}><ReviewsPage {...props} parts={parts} /></TestPageActionSlot>
      </TestThreadStore>
    </TestProviders>,
  );
  return { invoke, navigate, toast, switchSession, slot, view, props, parts };
}

describe("the Reviews page", () => {
  it("lists the queue: ready ones, then changes requested and conflicts, with their counts", async () => {
    const { invoke } = setup();
    await screen.findByText("Fix flaky pairing test");
    expect(invoke).toHaveBeenCalledWith("local-reviews", { workspaces: ["ws-pagination", "ws-pairing-flake", "ws-webhook-retries"] });
    const tabs = screen.getAllByRole("navigation", { name: "Reviews" }).at(-1)!;
    expect(within(tabs).getAllByRole("button").map((button) => button.textContent)).toEqual(["Ready1", "Requested1", "Conflicts1", "Merged1", "Remote"]);
    expect(screen.getByRole("region", { name: "Changes requested" }).textContent).toContain("Your note: retry budget");
    const conflicts = screen.getByRole("region", { name: "Conflicts" });
    expect(within(conflicts).getByRole("button", { name: /Ask thread to rebase/u })).toBeTruthy();
    const ready = screen.getByRole("region", { name: "Ready to merge" });
    expect(ready.textContent).toContain("feat/pairing-flake → main");
    expect(ready.textContent).toContain("3 files+59−5");
    expect(ready.textContent).toContain("no checks");
    expect(ready.textContent).toContain("$0.84");
    expect(ready.textContent).toContain("4m");
    expect(screen.getByText(/^Merged · 1 this month, \$9\.30\./u)).toBeTruthy();
  });

  it("merges a ready branch from its row and says so", async () => {
    const { invoke, toast } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /^Merge$/u }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-review-merge", expect.objectContaining({ workspace: "ws-pairing-flake", tip: "pairing-flake-tip", threadId: "t1", title: "Fix flaky pairing test", costUsd: 0.84 })));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Merged feat/pairing-flake into main" })));
  });

  it("asks a conflicting branch's thread to rebase", async () => {
    const { invoke } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /Ask thread to rebase/u }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-review-ask", expect.objectContaining({ kind: "rebase", threadId: "t3", branch: "feat/pagination", target: "main", conflicts: ["src/routes/orders.ts"] })));
  });

  it("opens a review as a view of the page, and moves between states with tabs", async () => {
    const { navigate } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Fix flaky pairing test, feat/pairing-flake" }));
    expect(navigate).toHaveBeenCalledWith({ tab: "ready", review: reviewKey("/repo/shop-api", "feat/pairing-flake") }, { label: "Fix flaky pairing test" });
    const tabs = screen.getAllByRole("navigation", { name: "Reviews" }).at(-1)!;
    fireEvent.click(within(tabs).getByRole("button", { name: /Conflicts/u }));
    expect(navigate).toHaveBeenLastCalledWith({ tab: "conflicts" }, { replace: true });
  });

  it("filters the list from the page head", async () => {
    const { slot } = setup();
    await screen.findByText("Fix flaky pairing test");
    fireEvent.change(within(slot).getByRole("searchbox", { name: "Filter reviews" }), { target: { value: "webhook" } });
    expect(screen.queryByText("Fix flaky pairing test")).toBeNull();
    expect(screen.getByText("Write ADR for webhook retries")).toBeTruthy();
  });

  it("shows one review (1q): the summary, its files with a diff on a click, and a note back to the thread", async () => {
    const key = reviewKey("/repo/shop-api", "feat/pairing-flake");
    const { invoke, switchSession } = setup({ params: { tab: "ready", review: key } });
    expect(await screen.findByText("The watcher subscribes on construction now.")).toBeTruthy();
    expect(screen.getByText("4 turns")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /PairingRequestWatcher\.tsx/u }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("file-diff", { workspace: "ws-pairing-flake", relPath: "src/PairingRequestWatcher.tsx", options: { scope: "branch", baseRef: "main" } }));
    fireEvent.click(screen.getByRole("button", { name: /^Note$/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note to the thread" }), { target: { value: "Keep the old name" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to thread" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-review-ask", expect.objectContaining({ kind: "note", text: "Keep the old name", threadId: "t1" })));
    fireEvent.click(screen.getByRole("button", { name: "Open thread" }));
    expect(switchSession).toHaveBeenCalledWith("/sessions/t1.jsonl");
  });

  it("keeps Merge off with the reason for a branch with uncommitted work", async () => {
    setup({ answer: { branches: [branch("pairing-flake", { uncommitted: 2 })], asks: {}, merged: [] } });
    const merge = await screen.findByRole("button", { name: /^Merge$/u }) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    expect(merge.dataset.tooltip).toBe("2 files are not committed; ask the thread to commit first.");
  });

  it("says what lands here when nothing does", async () => {
    setup({ answer: { branches: [], asks: {}, merged: [] } });
    expect(await screen.findByText("Nothing to review")).toBeTruthy();
    expect(screen.getByText(/^Merged · 0 this month\./u)).toBeTruthy();
  });

  it("draws a phone's rows (1p) under tabs, with no column heads", async () => {
    setup({ compact: true });
    await screen.findByText("Fix flaky pairing test");
    expect(document.querySelector(".rv-columns")).toBeNull();
    expect(document.querySelectorAll(".rv-card")).toHaveLength(3);
  });
});

describe("the Reviews sidebar", () => {
  it("lists the states, the projects and Remote with their counts, and the page drops its tabs and head filter", async () => {
    const { slot } = setup({ sidebar: true });
    const sidebar = screen.getByRole("navigation", { name: "Page sidebar" });
    await within(sidebar).findByRole("group", { name: "Projects" });
    expect(within(within(sidebar).getByRole("group", { name: "Reviews" })).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["Ready to merge1", "Changes requested1", "Conflicts1", "Merged1"]);
    expect(within(within(sidebar).getByRole("group", { name: "Projects" })).getByRole("button").textContent).toBe("Sshop-api3");
    expect(within(sidebar).getByRole("button", { name: "Remote pull requests" })).toBeTruthy();
    expect(within(sidebar).getByRole("button", { name: /Ready to merge/u }).getAttribute("aria-current")).toBe("page");
    // The page is the table alone.
    expect(await screen.findByRole("region", { name: "Ready to merge" })).toBeTruthy();
    expect(screen.queryAllByRole("navigation", { name: "Reviews" })).toHaveLength(0);
    expect(within(slot).queryByRole("searchbox")).toBeNull();
  });

  it("switches what the page lists out of any detail, filters it, and moves with the arrows", async () => {
    const { navigate } = setup({ sidebar: true, params: { tab: "ready", review: "some-key" } });
    const sidebar = screen.getByRole("navigation", { name: "Page sidebar" });
    await within(sidebar).findByRole("group", { name: "Projects" });
    fireEvent.click(within(sidebar).getByRole("button", { name: /Conflicts/u }));
    expect(navigate).toHaveBeenLastCalledWith({ tab: "conflicts" }, { root: true, replace: true });
    fireEvent.click(within(sidebar).getByRole("button", { name: /shop-api/u }));
    expect(navigate).toHaveBeenLastCalledWith({ tab: "ready", project: "ws-shop" }, { root: true, replace: true });

    const field = within(sidebar).getByRole("searchbox", { name: "Filter reviews" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Ready to merge1");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Changes requested1");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement?.textContent).toBe("Remote pull requests");
  });

  it("filters the page's list from its field", async () => {
    setup({ sidebar: true });
    await screen.findByText("Fix flaky pairing test");
    fireEvent.change(within(screen.getByRole("navigation", { name: "Page sidebar" })).getByRole("searchbox", { name: "Filter reviews" }), { target: { value: "webhook" } });
    await waitFor(() => expect(screen.queryByText("Fix flaky pairing test")).toBeNull());
    expect(screen.getByText("Write ADR for webhook retries")).toBeTruthy();
  });
});

describe("the Reviews entry", () => {
  it("is the page a phone's bottom navigation takes first, in place of Pull requests, counting what waits for the user", async () => {
    const invoke = vi.fn(async (_extension: string, command: string) => (command === "local-reviews" ? ANSWER : undefined));
    const { registry } = createKitHarness(invoke, "compact");
    registry.activate(reviewExtension);
    const pages = registry.getPages();
    expect(pages.map((page) => [page.id, page.label, page.order, page.prominent, Boolean(page.Sidebar)])).toEqual([["review.reviews", "Reviews", 10, true, true]]);
    function Badge() {
      const count = pages[0]!.useBadge?.();
      return <output>{count ?? "none"}</output>;
    }
    render(<TestProviders><TestThreadStore threads={THREADS}><Badge /></TestThreadStore></TestProviders>);
    // Ready and in conflict wait for the user; changes requested wait for the thread.
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("2"));
    expect(invoke).toHaveBeenCalledWith("tau.review", "local-reviews", { workspaces: ["ws-pagination", "ws-pairing-flake", "ws-webhook-retries"] });
    registry.deactivate?.(reviewExtension.id);
  });
});

describe("the list's age", () => {
  it("reads like the design: minutes, hours, days", () => {
    expect(shortAge(NOW - 4 * 60_000, NOW)).toBe("4m");
    expect(shortAge(NOW - 3 * 3600_000, NOW)).toBe("3h");
    expect(shortAge(NOW - 2 * 86_400_000, NOW)).toBe("2d");
  });
});
