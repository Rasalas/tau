// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient, PageProps, UiSession, WorkbenchActions } from "tau";
import { TestPageActionSlot, TestProviders, TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import { createKitHarness, createMemoryStorage, HostClientProvider, setClientStorage } from "../../src/renderer/test-support/kit-harness.js";
import { PullRequestCache } from "./pull-request-cache.js";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { reviewExtension } from "./desktop.js";
import { reviewKey, type LocalReviewsAnswer, type ThreadBranch } from "./local-reviews.js";
import { LocalReviewsStore } from "./local-reviews-store.js";
import { RowRequests } from "./requests.js";
import { ReviewsFilter } from "./reviews-filter.js";
import { InboxPullsStore } from "./inbox-pulls.js";
import { ReviewDetailStore } from "./review-detail-store.js";
import { PendingReviewStore } from "./pending-review.js";
import { ReviewsPage, ReviewsSidebar, shortAge, type ReviewsPageParts } from "./reviews-page.js";
import type { PullRequestClient } from "./pull-request-client.js";
import type { PullRequestListEntry, PullRequestLists } from "./protocol.js";

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

function setup(options: { answer?: LocalReviewsAnswer; params?: Record<string, unknown>; compact?: boolean; sidebar?: boolean; client?: ReturnType<typeof createFakeHostClient>; runs?: unknown[]; pulls?: () => Promise<PullRequestLists> } = {}) {
  if (options.compact) document.body.dataset.profile = "compact";
  const invoke = vi.fn(async (command: string, input?: unknown) => {
    if (command === "local-reviews") return options.answer ?? ANSWER;
    if (command === "local-review-merge") return { branch: "feat/pairing-flake", state: "merged", files: [], detail: "Merged.", into: "main", root: "/repo/shop-api" };
    if (command === "local-review-remove") return { branch: "feat/picked" };
    if (command === "local-review-update-target") return { branch: "main", commits: 361 };
    if (command === "local-review-summary") return { summary: "The watcher subscribes on construction now.", turns: 4 };
    if (command === "file-diff") return { path: (input as { relPath: string }).relPath, added: 1, removed: 0, hunks: [{ header: "@@ -1,1 +1,2 @@", lines: [{ kind: "context", oldLine: 1, newLine: 1, text: "const a = 1;" }, { kind: "added", newLine: 2, text: "const watcher = useMemo(() => new Watcher(), []);" }] }] };
    return undefined;
  });
  const host = { invoke, onEvent: () => () => undefined } as unknown as HostExtensionClient;
  const scripts = { invoke: vi.fn(async () => options.runs ?? []), onEvent: () => () => undefined } as unknown as HostExtensionClient;
  const store = new LocalReviewsStore(host, scripts);
  const sidebar = new ReviewDetailStore();
  const notes = new PendingReviewStore(() => undefined);
  const workspace = { invoke: vi.fn(async (command: string) => command === "list-editors" ? [{ id: "zed", name: "Zed" }] : undefined), onEvent: () => () => undefined } as unknown as HostExtensionClient;
  const client = {
    listMany: vi.fn(options.pulls ?? (async () => ({ lists: [], failures: [] }))),
    action: vi.fn(async () => ({ detail: {}, merge: { branchDeleted: "fix/own" } })),
  } as unknown as PullRequestClient;
  const parts: ReviewsPageParts = {
    store,
    host,
    rows: new RowRequests(async () => undefined),
    remote: { client, chips: () => undefined, rows: new RowRequests(async () => undefined), shared: {} as never, sidebar },
    pulls: new InboxPullsStore(client),
    filter: new ReviewsFilter(),
    detail: { store: sidebar, notes, workspace },
  };
  const navigate = vi.fn();
  const toast = vi.fn();
  const switchSession = vi.fn(async () => true);
  const actions = { toast, notify: vi.fn(), switchSession, openExternal: vi.fn() } as unknown as WorkbenchActions;
  const slot = document.createElement("div");
  document.body.append(slot);
  const props: PageProps = { actions, params: options.params ?? {}, navigate, close: vi.fn(), ...(options.sidebar ? { sidebar: true } : {}) };
  const tree = (params: Record<string, unknown>) => (
    <TestProviders>
      <HostClientProvider client={options.client}>
        <TestThreadStore threads={THREADS}>
          {options.sidebar ? <nav aria-label="Page sidebar"><ReviewsSidebar {...props} params={params} parts={parts} /></nav> : null}
          <TestPageActionSlot slot={slot}><ReviewsPage {...props} params={params} parts={parts} /></TestPageActionSlot>
        </TestThreadStore>
      </HostClientProvider>
    </TestProviders>
  );
  const view = render(tree(props.params));
  /** The page after a navigation: same instance, other params. */
  const show = (params: Record<string, unknown>) => view.rerender(tree(params));
  return { invoke, navigate, toast, switchSession, slot, view, show, props, parts, workspace, notes, client };
}

const pr = (number: number, patch: Partial<PullRequestListEntry> = {}): PullRequestListEntry => ({
  ref: { service: "github", host: "github.com", repo: "acme/shop-api", number, url: `https://github.com/acme/shop-api/pull/${number}` },
  title: `Request ${number}`, author: { login: "me" }, headRef: `fix/${number}`, baseRef: "main", state: "open", draft: false,
  additions: 4, deletions: 2, createdAt: new Date(NOW - 86_400_000).toISOString(), updatedAt: new Date(NOW - 2 * 86_400_000).toISOString(), labels: [], reviewRequested: false, ...patch,
});
const lists = (entries: PullRequestListEntry[], failures: PullRequestLists["failures"] = []): PullRequestLists => ({
  lists: [{ service: "github", host: "github.com", repo: "acme/shop-api", viewer: "me", entries, truncated: false, limit: 100, workspaces: ["ws-shop"] }],
  failures,
});
const headings = () => screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);

describe("the Reviews inbox", () => {
  it("lists what waits, by next step: ready to merge, then what needs the thread", async () => {
    const { invoke } = setup();
    await screen.findByText("Fix flaky pairing test");
    expect(invoke).toHaveBeenCalledWith("local-reviews", { workspaces: ["ws-pagination", "ws-pairing-flake", "ws-webhook-retries"] });
    const tabs = screen.getAllByRole("navigation", { name: "Reviews" }).at(-1)!;
    expect(within(tabs).getAllByRole("button").map((button) => button.textContent)).toEqual(["Inbox3", "Merged", "Pull requests"]);
    expect(screen.getByRole("heading", { level: 2, name: "Inbox" })).toBeTruthy();
    expect(headings()).toEqual(["Ready to merge1", "Needs the thread2"]);
    const ready = screen.getByRole("region", { name: "Ready to merge" });
    expect(ready.textContent).toContain("feat/pairing-flake → main");
    expect(ready.textContent).toContain("3 files+59−5");
    expect(ready.textContent).toContain("No checks");
    expect(ready.textContent).toContain("4m");
    // No model, no cost and no column heads in the list; those are the review's.
    expect(ready.textContent).not.toContain("$0.84");
    expect(document.querySelector(".rv-columns")).toBeNull();
    const needs = screen.getByRole("region", { name: "Needs the thread" });
    expect(within(needs).getByRole("button", { name: /Ask to rebase/u })).toBeTruthy();
    expect(needs.textContent).toContain("Note sent");
    expect(needs.textContent).toContain("Waiting");
    expect(screen.queryByText(/^A thread that reports done lands here/u)).toBeNull();
    expect(document.querySelector(".rv-footer")!.textContent).toBe("1 merged this month · $9.30");
  });

  it("says what the worktree's checks say in the status cell, the words also its tooltip", async () => {
    const runs = [
      { id: "r1", scriptId: "test", name: "Unit tests", directory: "/work/pairing-flake", status: "failed", startedAt: NOW - 1_000, endedAt: NOW - 500 },
      { id: "r2", scriptId: "lint", name: "Lint", directory: "/work/pairing-flake", status: "succeeded", startedAt: NOW - 9_000, endedAt: NOW - 8_000 },
    ];
    setup({ runs });
    const ready = await screen.findByRole("region", { name: "Ready to merge" });
    const status = await within(ready).findByText("1 check failed");
    expect(status.closest<HTMLElement>(".rv-status")!.dataset.tooltip).toBe("1 check failed");
    expect(status.closest<HTMLElement>(".rv-status")!.dataset.tone).toBe("bad");
  });

  it("merges a ready branch from its row after asking, naming the branch and its target, and says so", async () => {
    const { invoke, toast } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /^Merge$/u }));
    const asked = await screen.findByRole("dialog", { name: "Merge feat/pairing-flake into main?" });
    expect(asked.textContent).toContain("lands on main of");
    expect(invoke).not.toHaveBeenCalledWith("local-review-merge", expect.anything());
    fireEvent.click(within(asked).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-review-merge", expect.objectContaining({ workspace: "ws-pairing-flake", tip: "pairing-flake-tip", threadId: "t1", title: "Fix flaky pairing test", costUsd: 0.84 })));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Merged feat/pairing-flake into main" })));
  });

  it("shows work brought back from another machine and merges it through Remote Work", async () => {
    const { invoke } = setup({ answer: { branches: [], asks: {}, merged: [], remote: [{
      link: "rex-work", machine: "rex", root: "/repo/shop-api", rootWorkspace: "ws-shop", target: "main",
      title: "Work brought back from rex", branch: "feat/remote", tip: "remote-tip", commits: 1, files: 1,
      paths: ["src/remote.ts"], conflicts: [], merged: false, at: NOW,
    }] } });
    const title = await screen.findByText("Work brought back from rex");
    const row = title.closest("li")!;
    expect(row.textContent).toContain("rex: feat/remote");
    fireEvent.click(within(row).getByRole("button", { name: "Merge" }));
    const asked = await screen.findByRole("dialog", { name: "Merge feat/remote into main?" });
    expect(asked.textContent).toContain("came back from rex");
    fireEvent.click(within(asked).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-review-merge", expect.objectContaining({ link: "rex-work", branch: "feat/remote", target: "main", tip: "remote-tip" })));
  });

  it("shows an aborted worktree check as stopped rather than passed", async () => {
    setup({ runs: [{ id: "r1", scriptId: "test", name: "Unit tests", directory: "/work/pairing-flake", status: "stopped", startedAt: NOW - 1_000, endedAt: NOW - 500 }] });
    const status = await screen.findByText("1 check stopped");
    expect(status.closest<HTMLElement>(".rv-status")!.dataset.tone).toBe("warn");
    expect(screen.queryByText("Checks passed")).toBeNull();
  });

  it("asks a conflicting branch's thread to rebase", async () => {
    const { invoke } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /Ask to rebase/u }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-review-ask", expect.objectContaining({ kind: "rebase", threadId: "t3", branch: "feat/pagination", target: "main", conflicts: ["src/routes/orders.ts"] })));
  });

  it("shows a branch with a pull request once, with its number, and sends the thread what the request needs", async () => {
    const own = pr(12, { headRef: "feat/pairing-flake", checks: "failing", checkRuns: [{ name: "unit", status: "failed" }, { name: "lint", status: "failed" }] });
    const theirs = pr(13, { author: { login: "dependabot" }, reviewRequested: true, checks: "passing" });
    const { invoke } = setup({ pulls: async () => lists([own, theirs, pr(14, { author: { login: "someone" } }), pr(15, { draft: true })]) });
    const review = await screen.findByRole("region", { name: "Your review" });
    expect(headings()).toEqual(["Your review1", "Needs the thread3"]);
    expect(review.textContent).toContain("#13 · dependabot");
    expect(within(review).getByRole("button", { name: "Review" })).toBeTruthy();
    const needs = screen.getByRole("region", { name: "Needs the thread" });
    const row = within(needs).getByRole("button", { name: "Fix flaky pairing test, feat/pairing-flake" }).closest("li")!;
    expect(row.textContent).toContain("#12 · feat/pairing-flake → main");
    expect(row.textContent).toContain("2 checks failed");
    expect(screen.queryByText("Request 12")).toBeNull();
    expect(screen.queryByText("Request 14")).toBeNull();
    expect(screen.queryByText("Request 15")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Ask to fix" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-review-ask", expect.objectContaining({ kind: "note", threadId: "t1", text: expect.stringContaining("unit, lint") })));
  });

  it("merges the user's own mergeable request through its host, after the request view's question", async () => {
    const { client, toast } = setup({ pulls: async () => lists([pr(21, { checks: "passing", title: "Own fix" })]) });
    const ready = await screen.findByRole("region", { name: "Ready to merge" });
    const row = (await within(ready).findByText("Own fix")).closest("li")!;
    expect(row.textContent).toContain("#21 · fix/21 → main");
    expect(row.textContent).toContain("Checks passed");
    fireEvent.click(within(row).getByRole("button", { name: "Merge" }));
    const dialog = await screen.findByRole("dialog", { name: "Merge PR #21?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Squash and merge" }));
    await waitFor(() => expect(client.action).toHaveBeenCalledWith("https://github.com/acme/shop-api/pull/21", { action: "merge", method: "squash" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "PR #21 merged. Deleted fix/own." })));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Merge PR #21?" })).toBeNull());
  });

  it("keeps the local rows when the pull requests cannot be read, and says so in the foot", async () => {
    setup({ pulls: async () => { throw new Error("gh is not signed in."); } });
    expect(await screen.findByText("Fix flaky pairing test")).toBeTruthy();
    const footer = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(".rv-footer");
      expect(found?.textContent).toContain("Pull requests not read");
      return found!;
    });
    expect(within(footer).getByText("Pull requests not read").dataset.tooltip).toBe("gh is not signed in.");
    expect(within(footer).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("names the projects it could not read behind Details, which Escape closes", async () => {
    setup({ pulls: async () => lists([], [{ workspace: "ws-shop", message: "gh is not signed in." }, { workspace: "/scratch", message: "No remote." }]) });
    const details = await screen.findByRole("button", { name: "Details" });
    expect(document.querySelector(".rv-footer")!.textContent).toBe("1 merged this month · $9.302 projects not readDetails");
    expect(details.getAttribute("aria-expanded")).toBe("false");
    details.focus();
    fireEvent.click(details);
    const card = await screen.findByRole("dialog", { name: "Projects not read" });
    expect(within(card).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["shop-apigh is not signed in.", "/scratchNo remote."]);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document.activeElement ?? card, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Projects not read" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(details));
  });

  it("says when branches are read against origin, and brings a main that is only behind up to date", async () => {
    const stale = { comparedRef: "origin/main", targetBehind: 361 };
    const { invoke } = setup({ answer: { branches: [branch("pairing-flake", stale)], asks: {}, merged: [] } });
    const line = await screen.findByText(/^Compared with origin\/main — local main is 361 commits behind\./u);
    fireEvent.click(within(line).getByRole("button", { name: "Update main" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-review-update-target", { workspace: "ws-shop", target: "main" }));
    cleanup();
    setup({ answer: { branches: [branch("pairing-flake", { ...stale, targetAhead: 2 })], asks: {}, merged: [] } });
    const ahead = await screen.findByText("Compared with origin/main — local main has 2 commits origin/main lacks.");
    expect(within(ahead).queryByRole("button")).toBeNull();
  });

  it("comes back from a review to the row it opened from, with the list scrolled where it was", async () => {
    const { navigate, show } = setup({ params: { tab: "inbox" } });
    const row = await screen.findByRole("button", { name: "Write ADR for webhook retries, feat/webhook-retries" });
    const scroller = row.closest<HTMLElement>(".rv-scroll")!;
    scroller.scrollTop = 120;
    row.focus();
    fireEvent.click(row);
    const key = reviewKey("/repo/shop-api", "feat/webhook-retries");
    expect(navigate).toHaveBeenLastCalledWith({ tab: "inbox", review: key }, { label: "Write ADR for webhook retries" });
    show({ tab: "inbox", review: key });
    scroller.scrollTop = 0;
    show({ tab: "inbox" });
    const again = await screen.findByRole("button", { name: "Write ADR for webhook retries, feat/webhook-retries" });
    expect(document.activeElement).toBe(again);
    expect(again.closest(".rv-scroll")!.scrollTop).toBe(120);
  });

  it("opens a review as a view of the page, and moves between views with tabs", async () => {
    const { navigate } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Fix flaky pairing test, feat/pairing-flake" }));
    expect(navigate).toHaveBeenCalledWith({ tab: "inbox", review: reviewKey("/repo/shop-api", "feat/pairing-flake") }, { label: "Fix flaky pairing test" });
    const tabs = screen.getAllByRole("navigation", { name: "Reviews" }).at(-1)!;
    fireEvent.click(within(tabs).getByRole("button", { name: "Merged" }));
    expect(navigate).toHaveBeenLastCalledWith({ tab: "merged" }, { replace: true });
  });

  it("opens a request's row as the request's view, in the inbox", async () => {
    const { navigate } = setup({ pulls: async () => lists([pr(13, { author: { login: "dependabot" }, reviewRequested: true })]) });
    fireEvent.click(await screen.findByRole("button", { name: "Request 13, #13" }));
    expect(navigate).toHaveBeenLastCalledWith({ tab: "inbox", url: "https://github.com/acme/shop-api/pull/13", number: 13, service: "github", workspace: "ws-shop" }, { label: "#13 Request 13" });
  });

  it("filters the list from the page head", async () => {
    setup();
    await screen.findByText("Fix flaky pairing test");
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter reviews" }), { target: { value: "webhook" } });
    expect(screen.queryByText("Fix flaky pairing test")).toBeNull();
    expect(screen.getByText("Write ADR for webhook retries")).toBeTruthy();
  });

  it("steps through the rows with the arrows and opens the one with the focus on Enter", async () => {
    const { navigate } = setup();
    const filter = await screen.findByRole("searchbox", { name: "Filter reviews" });
    await screen.findByText("Fix flaky pairing test");
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Fix flaky pairing test, feat/pairing-flake");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Add pagination to all list endpoints, feat/pagination");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Write ADR for webhook retries, feat/webhook-retries");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Add pagination to all list endpoints, feat/pagination");
    fireEvent.click(document.activeElement!);
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ review: reviewKey("/repo/shop-api", "feat/pagination") }), expect.anything());
  });

  it("shows one review on a phone (1q): the summary, the first file's diff open, and Request changes at the foot", async () => {
    const key = reviewKey("/repo/shop-api", "feat/pairing-flake");
    const { invoke, switchSession } = setup({ compact: true, params: { tab: "inbox", review: key } });
    expect(await screen.findByText("The watcher subscribes on construction now.")).toBeTruthy();
    expect(screen.getByText("4 turns")).toBeTruthy();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("file-diff", { workspace: "ws-pairing-flake", relPath: "src/PairingRequestWatcher.tsx", options: { scope: "branch", baseRef: "main" } }));
    expect(screen.getByRole("button", { name: /PairingRequestWatcher\.tsx/u }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Request changes/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note to the thread" }), { target: { value: "Keep the old name" } });
    fireEvent.click(screen.getByRole("button", { name: /Send now/u }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-review-ask", expect.objectContaining({ kind: "note", text: "Keep the old name", threadId: "t1" })));
    fireEvent.click(screen.getByRole("button", { name: "Open thread" }));
    expect(switchSession).toHaveBeenCalledWith("/sessions/t1.jsonl");
  });

  it("replaces a file's load error with its diff once a later load succeeds", async () => {
    const key = reviewKey("/repo/shop-api", "feat/pairing-flake");
    const { invoke, parts } = setup({ compact: true, params: { tab: "inbox", review: key } });
    const answer = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, input) => command === "file-diff" ? Promise.reject(new Error("diff unreadable")) : answer(command, input));
    expect(await screen.findByText("diff unreadable")).toBeTruthy();
    invoke.mockImplementation(async (command, input) => command === "local-reviews" ? { ...ANSWER, branches: [branch("pairing-flake", { tip: "moved-tip" }), ...ANSWER.branches.slice(1)] } : answer(command, input));
    await act(() => parts.store.refresh());
    expect(await screen.findByRole("button", { name: "Note on line 2" })).toBeTruthy();
    expect(screen.queryByText("diff unreadable")).toBeNull();
  });

  it("keeps notes on a phone's diff lines for later and sends them as one turn (2o)", async () => {
    const key = reviewKey("/repo/shop-api", "feat/pairing-flake");
    const { invoke, notes } = setup({ compact: true, params: { tab: "inbox", review: key } });
    fireEvent.click(await screen.findByRole("button", { name: "Note on line 2" }));
    expect(screen.getByText("PairingRequestWatcher.tsx:2")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Note to the thread" }), { target: { value: "Use a ref" } });
    fireEvent.click(screen.getByRole("button", { name: "Keep for later" }));
    const held = await screen.findByRole("region", { name: "Review notes" });
    expect(held.textContent).toContain("Use a ref");
    expect(notes.comments(`local:${key}`)).toHaveLength(1);
    fireEvent.click(within(held).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-review-ask", expect.objectContaining({
      kind: "note",
      notes: [expect.objectContaining({ path: "src/PairingRequestWatcher.tsx", line: 2, side: "new", body: "Use a ref" })],
    })));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Review notes" })).toBeNull());
  });

  it("keeps Merge off with the reason for a branch with uncommitted work", async () => {
    setup({ answer: { branches: [branch("pairing-flake", { uncommitted: 2 })], asks: {}, merged: [] } });
    const merge = await screen.findByRole("button", { name: /^Merge$/u }) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    expect(merge.dataset.tooltip).toBe("2 files are not committed; ask the thread to commit first.");
  });

  it("lists a branch the target holds under other commits as merged, and removes its worktree on a confirmed click", async () => {
    const picked = branch("picked", { merged: true, mergedBy: "patches", workspace: "ws-pairing-flake" });
    const answer = { branches: [picked], asks: {}, merged: [] };
    const { invoke, toast } = setup({ answer, params: { tab: "merged" } });
    const merged = await screen.findByRole("region", { name: "Merged" });
    expect(merged.textContent).toContain("Already in main");
    expect(within(merged).queryAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Fix flaky pairing test, feat/picked"]);
    cleanup();
    const detail = setup({ answer, params: { tab: "merged", review: reviewKey("/repo/shop-api", "feat/picked") } });
    expect(await screen.findByText(/^Already in main: every commit's change is there already/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Remove worktree and branch/u }));
    fireEvent.click(within(screen.getByRole("group", { name: "Remove" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(detail.invoke).toHaveBeenCalledWith("local-review-remove", expect.objectContaining({ workspace: "ws-pairing-flake", tip: picked.tip, threadId: "t1" })));
    await waitFor(() => expect(detail.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Removed feat/picked and its worktree" })));
    expect(invoke).not.toHaveBeenCalledWith("local-review-remove", expect.anything());
    expect(toast).not.toHaveBeenCalled();
  });

  it("marks a target that is not the default branch", async () => {
    setup({ answer: { branches: [branch("aside", { target: "feat/chatgpt-plan-sign-in", defaultBranch: "main", workspace: "ws-pairing-flake" })], asks: {}, merged: [] } });
    const into = await screen.findByText("→ feat/chatgpt-plan-sign-in");
    expect(into.dataset.tooltip).toBe("This review targets feat/chatgpt-plan-sign-in; the project's default branch is main.");
  });

  it("says what lands here when nothing does", async () => {
    setup({ answer: { branches: [], asks: {}, merged: [] } });
    expect(await screen.findByText("Nothing waiting")).toBeTruthy();
    expect(screen.getByText(/finished branch lands here/u)).toBeTruthy();
    expect(document.querySelector(".rv-footer")!.textContent).toBe("0 merged this month");
  });

  it("draws a phone's rows (1p) as cards whose one step always shows", async () => {
    setup({ compact: true });
    await screen.findByText("Fix flaky pairing test");
    const cards = [...document.querySelectorAll(".rv-card")];
    expect(cards).toHaveLength(3);
    expect(cards.map((card) => card.querySelector(".rv-card-action")?.textContent)).toEqual(["Merge", "Ask to rebase", "Waiting"]);
    const tabs = screen.getByRole("navigation", { name: "Reviews" });
    expect(within(tabs).getAllByRole("button").map((button) => button.textContent)).toEqual(["Inbox3", "Merged", "Pull requests"]);
  });
});

describe("the Reviews sidebar", () => {
  it("lists Inbox, Merged and All pull requests, then the projects, and the page drops its tabs", async () => {
    setup({ sidebar: true });
    const sidebar = screen.getByRole("navigation", { name: "Page sidebar" });
    await within(sidebar).findByRole("group", { name: "Projects" });
    await waitFor(() => expect(within(within(sidebar).getByRole("group", { name: "Review" })).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["Inbox3", "Merged", "All pull requests"]));
    const project = within(within(sidebar).getByRole("group", { name: "Projects" })).getByRole("button");
    expect(project.textContent).toBe("Sshop-api3");
    expect(project.dataset.tooltip).toBe("shop-api");
    expect(project.querySelector(".rv-nav-label")?.textContent).toBe("shop-api");
    expect(within(sidebar).queryByRole("group", { name: "Elsewhere" })).toBeNull();
    expect(within(sidebar).getByRole("button", { name: /Inbox/u }).getAttribute("aria-current")).toBe("page");
    expect(await screen.findByRole("region", { name: "Ready to merge" })).toBeTruthy();
    expect(screen.queryAllByRole("navigation", { name: "Reviews" })).toHaveLength(0);
    // The filter is in the page's head, not the sidebar.
    expect(within(sidebar).queryByRole("searchbox")).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Filter reviews" })).toBeTruthy();
  });

  it("switches what the page lists, and moves with the arrows", async () => {
    const { navigate } = setup({ sidebar: true });
    const sidebar = screen.getByRole("navigation", { name: "Page sidebar" });
    await within(sidebar).findByRole("group", { name: "Projects" });
    fireEvent.click(within(sidebar).getByRole("button", { name: /Merged/u }));
    expect(navigate).toHaveBeenLastCalledWith({ tab: "merged" }, { root: true, replace: true });
    fireEvent.click(within(sidebar).getByRole("button", { name: /shop-api/u }));
    expect(navigate).toHaveBeenLastCalledWith({ tab: "inbox", project: "ws-shop" }, { root: true, replace: true });

    within(sidebar).getByRole("button", { name: /Inbox/u }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Merged");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement?.textContent).toBe("Sshop-api3");
  });

  it("counts a project's open requests beside its branches", async () => {
    setup({ sidebar: true, pulls: async () => lists([pr(13, { author: { login: "dependabot" }, reviewRequested: true })]) });
    const sidebar = screen.getByRole("navigation", { name: "Page sidebar" });
    await waitFor(() => expect(within(sidebar).getByRole("button", { name: /Inbox/u }).textContent).toBe("Inbox4"));
    expect(within(within(sidebar).getByRole("group", { name: "Projects" })).getByRole("button").textContent).toBe("Sshop-api4");
  });

  it("filters the page's list from the field in its head", async () => {
    setup({ sidebar: true });
    await screen.findByText("Fix flaky pairing test");
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter reviews" }), { target: { value: "webhook" } });
    await waitFor(() => expect(screen.queryByText("Fix flaky pairing test")).toBeNull());
    expect(screen.getByText("Write ADR for webhook retries")).toBeTruthy();
  });
});

describe("the Reviews entry", () => {
  afterEach(() => setClientStorage(undefined));

  /** The kit in a phone's workbench; `cached` seeds the request cache the inbox reads, `answer` is what a host read returns. */
  async function entry(options: { cached?: PullRequestLists; answer?: PullRequestLists; branches?: Promise<unknown> } = {}) {
    const storage = createMemoryStorage();
    if (options.cached) await new PullRequestCache(storage).invoke({ invoke: async () => options.cached } as unknown as HostExtensionClient, "pr-list-many", { state: "open", limit: 100, workspaces: [] });
    setClientStorage(storage);
    const invoke = vi.fn(async (_extension: string, command: string) => command === "local-reviews" ? (await options.branches, ANSWER) : command === "pr-list-many" ? options.answer ?? { lists: [], failures: [] } : undefined);
    const { registry } = createKitHarness(invoke, "compact");
    registry.activate(reviewExtension);
    const page = registry.getPages()[0]!;
    function Badge() {
      const count = page.useBadge?.();
      return <output>{count ?? "none"}</output>;
    }
    return { invoke, registry, page, Badge };
  }
  const own = (number: number) => pr(number, { checks: "passing" });

  it("is the page a phone's bottom navigation takes first, and counts the inbox's rows without asking a host", async () => {
    const { invoke, registry, page, Badge } = await entry();
    expect([page.id, page.label, page.order, page.prominent, Boolean(page.Sidebar)]).toEqual(["review.reviews", "Reviews", 10, true, true]);
    render(<TestProviders><TestThreadStore threads={THREADS}><Badge /></TestThreadStore></TestProviders>);
    // Ready, in conflict and waiting on the thread: the inbox's three rows.
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("3"));
    expect(invoke).toHaveBeenCalledWith("tau.review", "local-reviews", { workspaces: ["ws-pagination", "ws-pairing-flake", "ws-webhook-retries"] });
    expect(invoke).not.toHaveBeenCalledWith("tau.review", "pr-list-many", expect.anything());
    registry.deactivate?.(reviewExtension.id);
  });

  it("counts the cached requests as the inbox does, and follows the page's read when it lands", async () => {
    let read: (value?: unknown) => void = () => undefined;
    const branches = new Promise((resolve) => { read = resolve; });
    const { invoke, registry, page, Badge } = await entry({ cached: lists([own(21), own(22)]), answer: lists([own(21), own(22), own(23)]), branches });
    render(<TestProviders><TestThreadStore threads={THREADS}><Badge /></TestThreadStore></TestProviders>);
    // Until the branches are read, a request could still be one of them: no count yet.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("tau.review", "local-reviews", expect.anything()));
    expect(screen.getByRole("status").textContent).toBe("none");
    read();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("5"));
    expect(invoke).not.toHaveBeenCalledWith("tau.review", "pr-list-many", expect.anything());
    const Page = page.Component;
    const props = { params: {}, navigate: vi.fn(), close: vi.fn(), actions: { toast: vi.fn(), notify: vi.fn() } as unknown as WorkbenchActions };
    render(<TestProviders><TestThreadStore threads={THREADS}><Page {...props} /></TestThreadStore></TestProviders>);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("6"));
    const tabs = await screen.findByRole("navigation", { name: "Reviews" });
    await waitFor(() => expect(within(tabs).getByRole("button", { name: /Inbox/u }).textContent).toBe("Inbox6"));
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
