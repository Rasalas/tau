// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientStorage, HostExtensionClient, PageProps, PreferencesStore, UiFileDiff, UiSession, WorkbenchActions } from "tau";
import { TestPageActionSlot, TestProviders, TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import { reviewKey, type ConflictFile, type LocalReviewsAnswer, type NoteThread, type ThreadBranch } from "./local-reviews.js";
import { LocalReviewsStore } from "./local-reviews-store.js";
import { PendingReviewStore } from "./pending-review.js";
import type { PullRequestFiles } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { parseGitHubDetail, parseGitHubThreads, parseRequestUrl, parseUnifiedDiff } from "./pull-request-json.js";
import { parseGitHubList } from "./pull-request-list-json.js";
import { PullRequestsPage } from "./pull-requests-page.js";
import { RowRequests } from "./requests.js";
import { ReviewDetailStore } from "./review-detail-store.js";
import { ReviewsFilter } from "./reviews-filter.js";
import { ReviewsPage, ReviewsSidebar, type ReviewsPageParts } from "./reviews-page.js";
import { ThreadLinkRows } from "./thread-links-store.js";

afterEach(() => {
  cleanup();
  delete document.body.dataset.profile;
  vi.unstubAllGlobals();
});

const NOW = Date.now();
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
/** A diff line, whose words the highlighter splits into spans. */
const code = (text: string) => (_: string, element: Element | null) => Boolean(element?.classList.contains("diff-code") && element.textContent?.includes(text));

const branch = (name: string, patch: Partial<ThreadBranch> = {}): ThreadBranch => ({
  path: `/work/${name}`, root: "/repo/shop-api", branch: `fix/${name}`, target: "main", tip: `${name}-tip`,
  ahead: 1, behind: 0, files: 3, added: 59, removed: 5,
  paths: [
    { path: "src/PairingRequestWatcher.tsx", added: 6, removed: 3 },
    { path: "src/PairingRequestWatcher.test.tsx", added: 41, removed: 2 },
    { path: "src/watcher.ts", added: 12, removed: 0 },
  ],
  uncommitted: 0, committedAt: NOW - 4 * 60_000, merged: false, conflicts: [], workspace: `ws-${name}`, rootWorkspace: "ws-shop", ...patch,
});

const thread = (id: string, workspace: string, title: string): UiSession => ({
  id, path: `/sessions/${id}.jsonl`, title, modifiedAt: NOW - 4 * 60_000, projectPath: "/work", workspaceId: workspace, projectName: "shop-api", messageCount: 2,
  modelProvider: "anthropic", model: "claude-sonnet-4-5",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd: 0.84, turns: 1 },
});

const FLAKE = reviewKey("/repo/shop-api", "fix/pairing-flake");
const THREADS = [thread("t1", "ws-pairing-flake", "Fix flaky pairing test"), thread("t3", "ws-pagination", "Add pagination to all list endpoints")];

const diffOf = (path: string, lines = 4): UiFileDiff => ({
  path, added: 2, removed: 1,
  hunks: [{
    header: "@@ -31,7 +31,10 @@",
    lines: [
      { kind: "context", text: `// ${path}`, oldLine: 31, newLine: 31 },
      { kind: "removed", text: "useEffect(() => {", oldLine: 32 },
      ...Array.from({ length: lines }, (_, index) => ({ kind: "added" as const, text: `const watcher${index} = new Watcher(onRequest);`, newLine: 32 + index })),
    ],
  }],
});

interface Options { answer?: LocalReviewsAnswer; params?: Record<string, unknown>; lines?: number; runs?: unknown[]; conflicts?: { tip: string; files: ConflictFile[] }; notes?: NoteThread[] }

function setupLocal(options: Options = {}) {
  const answer: LocalReviewsAnswer = options.answer ?? { branches: [branch("pairing-flake")], asks: {}, merged: [] };
  const invoke = vi.fn(async (command: string, input?: unknown) => {
    if (command === "local-reviews") return answer;
    if (command === "local-review-summary") return { summary: "The watcher subscribes on construction now.", turns: 4, prompts: ["Reproduce the flake", "Move the subscription", "Regression tests", "20× green"] };
    if (command === "file-diff") return diffOf((input as { relPath: string }).relPath, options.lines);
    if (command === "local-review-conflicts") return options.conflicts;
    if (command === "local-review-notes") return options.notes ?? [];
    if (command === "local-review-commit") return { detail: "Committed abc1234" };
    if (command === "local-review-ask" || command === "local-review-merge") return { branch: "fix/pairing-flake", state: "merged", files: [], detail: "Merged.", into: "main", root: "/repo/shop-api" };
    return undefined;
  });
  const host = { invoke, onEvent: () => () => undefined } as unknown as HostExtensionClient;
  const scripts = { invoke: vi.fn(async () => options.runs ?? []), onEvent: () => () => undefined } as unknown as HostExtensionClient;
  const store = new LocalReviewsStore(host, scripts);
  const sidebar = new ReviewDetailStore();
  const workspace = { invoke: vi.fn(async (command: string) => command === "list-editors" ? [{ id: "zed", name: "Zed" }] : undefined), onEvent: () => () => undefined } as unknown as HostExtensionClient;
  const parts: ReviewsPageParts = {
    store, host, rows: new RowRequests(async () => undefined),
    remote: { client: {} as PullRequestClient, chips: () => undefined, rows: new RowRequests(async () => undefined), shared: {} as never, sidebar },
    filter: new ReviewsFilter(),
    detail: { store: sidebar, notes: new PendingReviewStore(() => undefined), workspace },
  };
  const navigate = vi.fn();
  const toast = vi.fn();
  const actions = { toast, notify: vi.fn(), switchSession: vi.fn(async () => true), openExternal: vi.fn() } as unknown as WorkbenchActions;
  const slot = document.createElement("div");
  document.body.append(slot);
  const props: PageProps = { actions, params: options.params ?? { tab: "ready", review: FLAKE }, navigate, close: vi.fn(), sidebar: true };
  render(
    <TestProviders>
      <TestThreadStore threads={THREADS}>
        <nav aria-label="Page sidebar"><ReviewsSidebar {...props} parts={parts} /></nav>
        <TestPageActionSlot slot={slot}><ReviewsPage {...props} parts={parts} /></TestPageActionSlot>
      </TestThreadStore>
    </TestProviders>,
  );
  return { invoke, navigate, toast, workspace, actions, parts, sidebar: () => screen.getByRole("navigation", { name: "Page sidebar" }) };
}

describe("a local review's detail (1e)", () => {
  it("shows completed work under Merged with its request and cleanup, without integration actions", async () => {
    const answer: LocalReviewsAnswer = { branches: [branch("pairing-flake", {
      merged: true, mergedBy: "request", behind: 30, mergeBlocked: "Check out main before merging.",
      request: { url: "https://github.com/acme/shop-api/pull/5", number: 5 },
    })], asks: {}, merged: [] };
    setupLocal({ answer, params: { tab: "merged", review: FLAKE } });
    const article = await screen.findByRole("article", { name: "Fix flaky pairing test" });
    expect((await within(article).findByRole("link", { name: "PR #5" })).getAttribute("href")).toBe("https://github.com/acme/shop-api/pull/5");
    expect(within(article).getByRole("button", { name: "Remove worktree and branch" })).toBeTruthy();
    expect(within(article).queryByRole("button", { name: /Merge into|Ask the thread to rebase/u })).toBeNull();
    expect(article.textContent).not.toContain("moved 30 commits");
    expect(article.textContent).not.toContain("Check out main");
  });

  it("blocks merging with all picks when the destination is not checked out", async () => {
    const message = "Check out main in the project's main folder before merging. It currently has fix/privacy.";
    const answer: LocalReviewsAnswer = { branches: [branch("pairing-flake", { conflicts: ["src/watcher.ts"], mergeBlocked: message })], asks: {}, merged: [] };
    const conflicts = { tip: "pairing-flake-tip", files: [{ path: "src/watcher.ts", hunks: [{ main: ["b"], thread: ["a"], mainLine: 1, threadLine: 1 }] }] };
    setupLocal({ answer, params: { tab: "conflicts", review: FLAKE }, conflicts });
    const hunk = await screen.findByRole("group", { name: "Hunk 1 of 1" });
    fireEvent.click(within(hunk).getByRole("button", { name: "Keep this thread" }));
    await within(hunk).findByText("Kept this thread");
    expect((screen.getByRole("button", { name: "Merge with my picks" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(message)).toBeTruthy();
  });

  it("keeps the thread accessible after cleanup and hides the removal action", async () => {
    const answer: LocalReviewsAnswer = { branches: [], asks: {}, merged: [{
      ...branch("pairing-flake"), target: "main", key: FLAKE, title: "Fix flaky pairing test", threadId: "t1", at: Date.now(),
    }] };
    setupLocal({ answer, params: { tab: "merged", review: FLAKE } });
    const article = await screen.findByRole("article", { name: "Fix flaky pairing test" });
    expect(within(article).getByRole("button", { name: "Open thread" })).toBeTruthy();
    expect(within(article).queryByRole("button", { name: "Remove worktree and branch" })).toBeNull();
  });
  it("names the review, what it changed and what it costs, with Merge into its target and Request changes", async () => {
    setupLocal();
    const article = await screen.findByRole("article", { name: "Fix flaky pairing test" });
    expect(within(article).getByRole("heading", { name: "Fix flaky pairing test" })).toBeTruthy();
    const meta = article.querySelector(".rvd-meta")!;
    expect(meta.textContent).toContain("fix/pairing-flake→main");
    expect(meta.textContent).toContain("3 files+59−5");
    expect(meta.textContent).toContain("claude-sonnet-4-5");
    expect(meta.textContent).toContain("$0.84");
    expect(await within(article).findByText("The watcher subscribes on construction now.")).toBeTruthy();
    expect(within(article).getByRole("button", { name: "Merge into main" })).toBeTruthy();
    expect(within(article).getByRole("button", { name: "Request changes" })).toBeTruthy();
    expect(within(article).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Changes", "Turns4", "Checks"]);
  });

  it("swaps the sidebar for the review's own: the way back at both ends, its files, turns and notes", async () => {
    const { sidebar, navigate } = setupLocal();
    const turns = await within(sidebar()).findByRole("list", { name: "Turns" });
    expect(within(turns).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["1Reproduce the flake", "2Move the subscription", "3Regression tests", "420× green"]);
    expect(within(sidebar()).getByText("Files · 3")).toBeTruthy();
    expect(within(sidebar()).getByText("Turns · 4")).toBeTruthy();
    expect(within(sidebar()).getByText("Review notes · 0")).toBeTruthy();
    const backs = within(sidebar()).getAllByRole("button", { name: "All reviews" });
    expect(backs).toHaveLength(2);
    expect(within(sidebar()).queryByRole("button", { name: "Back to thread" })).toBeNull();
    expect(within(sidebar()).queryByRole("searchbox")).toBeNull();
    fireEvent.click(backs[1]!);
    expect(navigate).toHaveBeenLastCalledWith({ tab: "ready" }, { root: true, replace: true });
  });

  it("goes back with ⌘[, but not while a field has the focus", async () => {
    const { navigate } = setupLocal();
    await screen.findByRole("article", { name: "Fix flaky pairing test" });
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    const field = await screen.findByRole("textbox", { name: "Note to the thread" });
    field.focus();
    fireEvent.keyDown(field, { key: "[", metaKey: true });
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(document.body, { key: "[", metaKey: true });
    expect(navigate).toHaveBeenCalledWith({ tab: "ready" }, { root: true, replace: true });
  });

  it("draws every file under the next, each with its path, Open in editor and a fold", async () => {
    const { workspace, invoke } = setupLocal();
    const article = await screen.findByRole("article", { name: "Fix flaky pairing test" });
    const files = await within(article).findAllByRole("region");
    expect(files.map((file) => file.getAttribute("aria-label"))).toEqual(["src/PairingRequestWatcher.tsx", "src/PairingRequestWatcher.test.tsx", "src/watcher.ts"]);
    // Each file's diff is there, from its own read.
    await within(files[2]!).findByText(code("const watcher0 = new Watcher(onRequest);"));
    expect(invoke).toHaveBeenCalledWith("file-diff", { workspace: "ws-pairing-flake", relPath: "src/PairingRequestWatcher.test.tsx", options: { scope: "branch", baseRef: "main" } });
    expect(within(files[0]!).getByText("src/PairingRequestWatcher.tsx")).toBeTruthy();
    fireEvent.click(within(files[2]!).getByRole("button", { name: "Open in editor" }));
    await waitFor(() => expect(workspace.invoke).toHaveBeenCalledWith("open-in-editor", { editorId: "zed", relPath: "src/watcher.ts", workspace: "ws-pairing-flake" }));
    fireEvent.click(within(files[2]!).getByRole("button", { name: "Collapse src/watcher.ts" }));
    expect(within(files[2]!).queryByText(code("const watcher0 = new Watcher(onRequest);"))).toBeNull();
    fireEvent.click(within(files[2]!).getByRole("button", { name: "Expand src/watcher.ts" }));
    await within(files[2]!).findByText(code("const watcher0 = new Watcher(onRequest);"));
  });

  it("jumps to a file from the sidebar", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const { sidebar } = setupLocal();
    const files = await within(sidebar()).findByRole("list", { name: "Files" });
    fireEvent.click(within(files).getByRole("button", { name: /^src\/watcher\.ts/u }));
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    expect((scrolled.mock.contexts.at(-1) as HTMLElement).getAttribute("aria-label")).toBe("src/watcher.ts");
  });

  it("reads and draws a file only when it comes near the viewport", async () => {
    const observers: Array<{ callback: IntersectionObserverCallback; targets: Element[] }> = [];
    vi.stubGlobal("IntersectionObserver", class {
      readonly record = { callback: undefined as unknown as IntersectionObserverCallback, targets: [] as Element[] };
      constructor(callback: IntersectionObserverCallback) { this.record.callback = callback; observers.push(this.record); }
      observe(target: Element) { this.record.targets.push(target); }
      disconnect() { this.record.targets = []; }
      unobserve() {}
    });
    const { invoke } = setupLocal();
    const article = await screen.findByRole("article", { name: "Fix flaky pairing test" });
    await within(article).findAllByRole("region");
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));
    expect(invoke.mock.calls.filter(([command]) => command === "file-diff")).toHaveLength(0);
    const near = observers.find((record) => record.targets.length === 3)!;
    const second = near.targets[1]!;
    act(() => { near.callback([{ target: second, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver); });
    await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "file-diff")).toHaveLength(1));
    expect(invoke).toHaveBeenCalledWith("file-diff", expect.objectContaining({ relPath: "src/PairingRequestWatcher.test.tsx" }));
  });

  it("scrolls a long file inside its card, so the diff view keeps to the rows in view", async () => {
    setupLocal({ lines: 500 });
    const article = await screen.findByRole("article", { name: "Fix flaky pairing test" });
    await waitFor(() => expect(article.querySelectorAll(".rvd-diff.bounded")).toHaveLength(3));
  });

  it("collects a note from a line in the sidebar until it is sent, and sends it to the thread as a turn", async () => {
    const { sidebar, invoke, toast } = setupLocal();
    const first = (await screen.findAllByRole("region"))[0]!;
    fireEvent.click(await within(first).findByRole("button", { name: "Note on line 33" }));
    const box = await within(first).findByRole("group", { name: "Note on line 33" });
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: "useMemo for a side-effecting constructor is fragile" } });
    fireEvent.click(within(box).getByRole("button", { name: "Add note" }));
    await within(sidebar()).findByText("Review notes · 1");
    expect(within(sidebar()).getByText("kept until you send")).toBeTruthy();
    expect(within(sidebar()).getByText("useMemo for a side-effecting constructor is fragile")).toBeTruthy();
    // The note stays under its line, and a second one joins it.
    fireEvent.click(within(first).getByRole("button", { name: "Note on line 34" }));
    const second = await within(first).findByRole("group", { name: "Note on line 34" });
    fireEvent.change(within(second).getByRole("textbox"), { target: { value: "dispose() should clear the buffer" } });
    fireEvent.click(within(second).getByRole("button", { name: "Add note" }));
    await within(sidebar()).findByText("Review notes · 2");
    fireEvent.click(within(sidebar()).getByRole("button", { name: "Send both as one turn" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-review-ask", expect.objectContaining({ kind: "note", threadId: "t1", branch: "fix/pairing-flake" })));
    const ask = invoke.mock.calls.find(([command]) => command === "local-review-ask")![1] as { text: string; notes: Array<{ line: number }> };
    expect(ask.notes.map((note) => note.line)).toEqual([33, 34]);
    const sent = ask.text;
    expect(sent).toContain("`src/PairingRequestWatcher.tsx:33`");
    expect(sent).toContain("useMemo for a side-effecting constructor is fragile");
    expect(sent).toContain("`src/PairingRequestWatcher.tsx:34`");
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "2 notes sent to the thread as one turn" })));
    await within(sidebar()).findByText("Review notes · 0");
  });

  it("lists the thread's turns and Project Scripts' runs under their tabs", async () => {
    const runs = [
      { id: "r1", scriptId: "test", name: "Unit tests", directory: "/work/pairing-flake", status: "succeeded", startedAt: 1 },
      { id: "r2", scriptId: "lint", name: "Lint", directory: "/work/pairing-flake", status: "failed", startedAt: 2 },
    ];
    setupLocal({ runs });
    await screen.findByRole("article", { name: "Fix flaky pairing test" });
    const article = screen.getByRole("article", { name: "Fix flaky pairing test" });
    fireEvent.click(await within(article).findByRole("tab", { name: /^Turns/u }));
    const turns = await within(article).findByRole("list", { name: "Turns" });
    expect(within(turns).getByText("Move the subscription")).toBeTruthy();
    fireEvent.click(within(article).getByRole("tab", { name: /^Checks/u }));
    const checks = await within(article).findByRole("region", { name: "Project scripts" });
    expect(within(checks).getAllByRole("button").map((item) => item.getAttribute("aria-label"))).toEqual(["Unit tests: Passed", "Lint: Failed"]);
  });

  it("opens at its checks when asked, with the runs as a mini pipeline beside the title that shows them again", async () => {
    const runs = [
      { id: "r1", scriptId: "test", name: "Unit tests", directory: "/work/pairing-flake", status: "succeeded", startedAt: 1 },
      { id: "r2", scriptId: "lint", name: "Lint", directory: "/work/pairing-flake", status: "failed", startedAt: 2 },
    ];
    setupLocal({ runs, params: { tab: "ready", review: FLAKE, focus: "checks" } });
    const article = await screen.findByRole("article", { name: "Fix flaky pairing test" });
    const checksTab = () => within(article).getByRole("tab", { name: /^Checks/u });
    expect(checksTab().getAttribute("aria-selected")).toBe("true");
    const mini = await within(article).findByRole("button", { name: "Checks: Project scripts failed" });
    expect(mini.closest("h1")).toBeNull();
    fireEvent.click(within(article).getByRole("tab", { name: /^Changes/u }));
    fireEvent.click(mini);
    await waitFor(() => expect(checksTab().getAttribute("aria-selected")).toBe("true"));
  });

  it("picks a side per hunk in a conflict (2e), merges with the picks, and can still ask the thread to rebase", async () => {
    const key = reviewKey("/repo/shop-api", "fix/pagination");
    const answer: LocalReviewsAnswer = { branches: [branch("pagination", { conflicts: ["src/watcher.ts"], behind: 14 })], asks: {}, merged: [] };
    const conflicts = { tip: "pagination-tip", files: [{ path: "src/watcher.ts", hunks: [
      { main: ["return { rows, total };"], thread: ["return page(rows, limit);"], mainLine: 41, threadLine: 41, before: "const limit = 1;" },
      { main: ["import { requireTenant } from \"./tenant\";"], thread: ["import { page } from \"./envelope\";"], mainLine: 3, threadLine: 3 },
    ] }] };
    const { sidebar, invoke } = setupLocal({ answer, params: { tab: "conflicts", review: key }, conflicts });
    const article = await screen.findByRole("article", { name: "Add pagination to all list endpoints" });
    expect(article.textContent).toContain("main moved 14 commits since this branch started");
    expect(article.textContent).toContain("1 file changed on both sides. Pick a side per hunk");
    expect(within(article).queryByRole("tab")).toBeNull();
    const merge = within(article).getByRole("button", { name: "Merge with my picks" }) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    await within(sidebar()).findByText("Conflicts · 1 of 3 files");
    expect(within(sidebar()).getByText("Clean · 2")).toBeTruthy();
    await within(sidebar()).findByText("2 hunks");
    const first = await within(article).findByRole("group", { name: "Hunk 1 of 2" });
    expect(first.textContent).toContain("return page(rows, limit);");
    fireEvent.click(within(first).getByRole("button", { name: "Keep this thread" }));
    await within(first).findByText("Kept this thread");
    expect(merge.disabled).toBe(true);
    fireEvent.click(within(within(article).getByRole("group", { name: "Hunk 2 of 2" })).getByRole("button", { name: "Keep both" }));
    await waitFor(() => expect(merge.disabled).toBe(false));
    fireEvent.click(merge);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-review-merge", expect.objectContaining({ workspace: "ws-pagination", picks: { "src/watcher.ts": ["thread", "both"] } })));
    fireEvent.click(within(article).getByRole("button", { name: "Ask the thread to rebase" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-review-ask", expect.objectContaining({ kind: "rebase", threadId: "t3", conflicts: ["src/watcher.ts"] })));
  });

  it("writes a hunk by hand in a conflict", async () => {
    const key = reviewKey("/repo/shop-api", "fix/pagination");
    const answer: LocalReviewsAnswer = { branches: [branch("pagination", { conflicts: ["src/watcher.ts"] })], asks: {}, merged: [] };
    const conflicts = { tip: "pagination-tip", files: [{ path: "src/watcher.ts", hunks: [{ main: ["b"], thread: ["a"], mainLine: 1, threadLine: 1 }] }] };
    const { invoke } = setupLocal({ answer, params: { tab: "conflicts", review: key }, conflicts });
    const hunk = await screen.findByRole("group", { name: "Hunk 1 of 1" });
    fireEvent.click(within(hunk).getByRole("button", { name: "Edit by hand" }));
    const field = within(hunk).getByRole("textbox", { name: "Hunk 1 by hand" }) as HTMLTextAreaElement;
    expect(field.value).toBe("a\nb");
    fireEvent.change(field, { target: { value: "ab" } });
    fireEvent.click(within(hunk).getByRole("button", { name: "Done" }));
    await within(hunk).findByText("Edited by hand");
    fireEvent.click(screen.getByRole("button", { name: "Merge with my picks" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-review-merge", expect.objectContaining({ picks: { "src/watcher.ts": [{ text: "ab" }] } })));
  });

  it("commits the worktree without merging (Commit only), which only offers itself with work not committed", async () => {
    const answer: LocalReviewsAnswer = { branches: [branch("pairing-flake", { uncommitted: 2 })], asks: {}, merged: [] };
    const { invoke, toast } = setupLocal({ answer });
    const commit = await screen.findByRole("button", { name: "Commit only" }) as HTMLButtonElement;
    expect((screen.getByRole("button", { name: "Merge into main" }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(commit.disabled).toBe(false));
    fireEvent.click(commit);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-review-commit", { workspace: "ws-pairing-flake", message: "Fix flaky pairing test" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Committed on fix/pairing-flake" })));
  });

  it("shows a sent note's conversation under its line, and a reply goes to the thread as a turn", async () => {
    const notes: NoteThread[] = [{ id: "n1", path: "src/PairingRequestWatcher.tsx", line: 33, side: "new", said: [{ body: "Does replay() dedupe?", at: 1, answer: "Yes — the host keys requests by device id." }] }];
    const { invoke } = setupLocal({ notes });
    const first = (await screen.findAllByRole("region"))[0]!;
    const talk = await within(first).findByRole("group", { name: "Note on line 33, sent" });
    expect(talk.textContent).toContain("Does replay() dedupe?");
    expect(talk.textContent).toContain("Yes — the host keys requests by device id.");
    const reply = within(talk).getByRole("group", { name: "Reply on line 33" });
    fireEvent.change(within(reply).getByRole("textbox"), { target: { value: "Add the test" } });
    fireEvent.click(within(reply).getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-review-ask", expect.objectContaining({ kind: "note", notes: [expect.objectContaining({ note: "n1", line: 33, body: "Add the test" })] })));
    await within(talk).findByText("The thread has not answered yet.");
  });

  it("merges from the header", async () => {
    const { invoke } = setupLocal();
    const merge = await screen.findByRole("button", { name: "Merge into main" });
    fireEvent.click(merge);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("local-review-merge", expect.objectContaining({ workspace: "ws-pairing-flake", tip: "pairing-flake-tip" })));
  });
});

// A pull request in the same view.

const REF = parseRequestUrl("https://github.com/acme/tau/pull/7")!;
const PARAMS = { url: REF.url, number: 7, service: "github" as const, workspace: "/project" };

function fakeClient(passing: boolean): PullRequestClient {
  // Nothing failing, so the primary control is the merge itself.
  const detail = { ...parseGitHubDetail(REF, fixture("gh-pr-view-discussed.json")), ...(passing ? { checks: [] } : {}) };
  const { threads, viewed } = parseGitHubThreads(fixture("gh-pr-threads-discussed.json"));
  const entries = parseUnifiedDiff(fixture("gh-pr-diff.patch"));
  const files: PullRequestFiles = { files: entries.map((entry) => ({ ...entry.file, viewed: viewed.get(entry.file.path) ?? "unviewed" })), diffs: entries.map((entry) => entry.diff), viewedOn: "host" };
  return {
    view: vi.fn(async () => detail), checks: vi.fn(async () => detail.checks), threads: vi.fn(async () => threads), files: vi.fn(async () => files),
    comment: vi.fn(async () => undefined), viewed: vi.fn(async (_url: string, _path: string, value: boolean) => value ? "viewed" as const : "unviewed" as const),
    review: vi.fn(async () => detail), resolve: vi.fn(async () => threads), editComment: vi.fn(async () => undefined),
    candidates: vi.fn(async () => ({ labels: [], reviewers: [] })), links: vi.fn(async () => []), listMany: vi.fn(async () => ({ lists: [], failures: [] })),
    action: vi.fn(async () => { throw new Error("not in this test"); }), stack: vi.fn(async () => null), linkedThreads: vi.fn(async () => []), onLinksChanged: () => () => undefined,
  } as unknown as PullRequestClient;
}

function memoryStorage(): ClientStorage {
  const values = new Map<string, string>();
  return { get: (key) => values.get(key) ?? null, set: (key, value) => { values.set(key, value); }, remove: (key) => { values.delete(key); }, keys: () => [...values.keys()] };
}

function preferences(): PreferencesStore {
  const snapshot = {};
  return { subscribe: () => () => undefined, getSnapshot: () => snapshot, optionValue: (_extension: string, _id: string, fallback: unknown) => fallback, setOption: vi.fn() } as unknown as PreferencesStore;
}

function setupRemote(passing = true, extra: Record<string, unknown> = {}) {
  const client = fakeClient(passing);
  const storage = memoryStorage();
  const sidebar = new ReviewDetailStore();
  const shared = { links: new ThreadLinkRows(client), pending: new PendingReviewStore(() => storage, () => `held-${Math.random()}`), preferences: preferences(), dialogs: {} as never };
  const remote = { client, chips: () => undefined, rows: new RowRequests(async () => undefined), shared, sidebar };
  const parts: ReviewsPageParts = {
    store: new LocalReviewsStore({ invoke: async () => ({ branches: [], asks: {}, merged: [] }), onEvent: () => () => undefined } as unknown as HostExtensionClient),
    host: {} as HostExtensionClient, rows: remote.rows, remote, filter: new ReviewsFilter(),
    detail: { store: sidebar, notes: shared.pending, workspace: {} as HostExtensionClient },
  };
  const navigate = vi.fn();
  const actions = { activeThread: () => ({ sessionId: "thread-1", cwd: "/project", draftPending: false }), notify: vi.fn(), openExternal: vi.fn(), focusComposer: vi.fn(), composerDraft: () => "", copyText: vi.fn(async () => undefined), toast: vi.fn() } as unknown as WorkbenchActions;
  const props: PageProps = { actions, params: { tab: "remote", ...PARAMS, ...extra }, navigate, close: vi.fn(), sidebar: true };
  render(
    <TestProviders>
      <TestThreadStore threads={THREADS}>
        <nav aria-label="Page sidebar"><ReviewsSidebar {...props} parts={parts} /></nav>
        <PullRequestsPage {...props} navigate={(next, options) => navigate({ ...next, tab: "remote" }, options)} parts={remote} />
      </TestThreadStore>
    </TestProviders>,
  );
  return { client, navigate, shared, sidebar: () => screen.getByRole("navigation", { name: "Page sidebar" }) };
}

describe("a pull request's detail (1e)", () => {
  beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });

  it("is the same view: title, branch → base, changes, the merge into its base and the sidebar of its files and commits", async () => {
    const { sidebar } = setupRemote();
    const article = await screen.findByRole("article", { name: "PR #7" });
    expect(within(article).getByRole("heading", { name: "Add the output helper" })).toBeTruthy();
    const meta = article.querySelector(".rvd-meta")!;
    expect(meta.textContent).toContain("feat/output→main");
    expect(within(article).getByRole("img", { name: "Open" })).toBeTruthy();
    expect(within(article).getAllByRole("tab").map((tab) => tab.textContent?.replace(/\d+|·.*/gu, "").trim())).toEqual(["Changes", "Timeline", "Checks"]);
    expect(await within(article).findByRole("button", { name: "Squash and merge into main" })).toBeTruthy();
    expect(within(article).getByRole("button", { name: "Request changes" })).toBeTruthy();
    // Every file of the request under the next.
    await waitFor(() => expect(article.querySelectorAll("[data-stack-file]").length).toBeGreaterThan(1));
    const names = [...article.querySelectorAll("[data-stack-file]")].map((file) => file.getAttribute("aria-label"));
    const list = await within(sidebar()).findByRole("list", { name: "Files" });
    expect(within(list).getAllByRole("button")).toHaveLength(names.length);
    // The fixture's detail counts one file; the header, the tab and the sidebar count the listed ones.
    expect(names.length).toBe(4);
    expect(meta.textContent).toContain("4 files");
    expect(within(article).getByRole("tab", { name: /^Changes/u }).textContent).toContain("4");
    expect(within(sidebar()).getByText("Files · 4")).toBeTruthy();
    expect(within(sidebar()).getAllByRole("button", { name: "All pull requests" })).toHaveLength(2);
    expect(within(sidebar()).getByText(/^Commits · \d+$/u)).toBeTruthy();
  });

  it("goes back to the list of pull requests from the sidebar and with ⌘[", async () => {
    const { sidebar, navigate } = setupRemote();
    await screen.findByRole("article", { name: "PR #7" });
    fireEvent.click(within(sidebar()).getAllByRole("button", { name: "All pull requests" })[0]!);
    expect(navigate).toHaveBeenLastCalledWith({ tab: "remote" }, { root: true, replace: true });
    navigate.mockClear();
    fireEvent.keyDown(document.body, { key: "[", metaKey: true });
    expect(navigate).toHaveBeenLastCalledWith({ tab: "remote" }, { root: true, replace: true });
  });

  it("gives the focus back to the row the request opened from", async () => {
    const client = fakeClient(true);
    const entries = parseGitHubList(fixture("gh-pr-list.json"), "tester").slice(0, 3);
    (client as { listMany: unknown }).listMany = vi.fn(async () => ({ lists: [{ service: "github", host: "github.com", repo: "cli/cli", entries, truncated: false, limit: 100, workspaces: ["/cli"] }], failures: [] }));
    const storage = memoryStorage();
    const shared = { links: new ThreadLinkRows(client), pending: new PendingReviewStore(() => storage), preferences: preferences(), dialogs: {} as never };
    const parts = { client, chips: () => undefined, rows: new RowRequests(async () => undefined), shared, sidebar: new ReviewDetailStore() };
    const navigate = vi.fn();
    const actions = { activeThread: () => undefined, notify: vi.fn(), openExternal: vi.fn(), toast: vi.fn() } as unknown as WorkbenchActions;
    const page = (params: Record<string, unknown>) => (
      <TestProviders>
        <TestThreadStore threads={[]} projects={[{ path: "/cli", workspaceId: "/cli", name: "cli", lastOpenedAt: 1 }]}>
          <PullRequestsPage actions={actions} params={params} navigate={navigate} close={vi.fn()} parts={parts} />
        </TestThreadStore>
      </TestProviders>
    );
    const view = render(page({}));
    const second = entries[1]!;
    const row = await screen.findByRole("button", { name: `#${second.ref.number} ${second.title}` });
    row.focus();
    fireEvent.click(row);
    const [params] = navigate.mock.lastCall as [Record<string, unknown>];
    view.rerender(page(params));
    await screen.findByRole("article");
    // A browser drops the focus of a hidden list; jsdom does not.
    row.blur();
    view.rerender(page({}));
    expect(document.activeElement).toBe(row);
  });

  it("holds a line comment as a note in the sidebar until the review is submitted", async () => {
    const { sidebar, shared } = setupRemote();
    const article = await screen.findByRole("article", { name: "PR #7" });
    await waitFor(() => expect(article.querySelector("[data-stack-file]")).not.toBeNull());
    const region = article.querySelector<HTMLElement>("[data-stack-file]")!;
    const button = await within(region).findAllByRole("button", { name: /^Comment on line \d+$/u });
    fireEvent.click(button[0]!);
    const box = await within(region).findByRole("group", { name: /^Comment on line \d+$/u });
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: "Name this" } });
    fireEvent.click(within(box).getByRole("button", { name: "Add to review" }));
    await within(sidebar()).findByText("Review notes · 1");
    expect(shared.pending.comments(PARAMS.url)).toHaveLength(1);
    fireEvent.click(within(sidebar()).getByRole("button", { name: "Submit review" }));
    expect(await screen.findByRole("dialog", { name: /^Review the/u })).toBeTruthy();
  });

  it("opens at its checks when asked, and the mini pipeline beside the title shows them again", async () => {
    setupRemote(false, { focus: "checks" });
    const article = await screen.findByRole("article", { name: "PR #7" });
    const checksTab = () => within(article).getByRole("tab", { name: /^Checks/u });
    expect(checksTab().getAttribute("aria-selected")).toBe("true");
    expect(await within(article).findByRole("button", { name: /^smoke: Failed/u })).toBeTruthy();
    fireEvent.click(within(article).getByRole("tab", { name: /^Timeline/u }));
    fireEvent.click(await within(article).findByRole("button", { name: /^Checks: .*failed/u }));
    await waitFor(() => expect(checksTab().getAttribute("aria-selected")).toBe("true"));
  });

  it("lists the timeline and the checks under their tabs", async () => {
    setupRemote(false);
    const article = await screen.findByRole("article", { name: "PR #7" });
    fireEvent.click(within(article).getByRole("tab", { name: /^Timeline/u }));
    expect(await within(article).findByRole("list", { name: "PR #7 timeline" })).toBeTruthy();
    fireEvent.click(within(article).getByRole("tab", { name: /^Checks/u }));
    expect(await within(article).findByRole("button", { name: /^smoke: Failed/u })).toBeTruthy();
  });
});
