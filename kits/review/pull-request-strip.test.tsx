// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientStorage, DesktopExtension, HostSnapshot, PreferencesStore, TranscriptRow, TranscriptRowsHandle, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { reviewExtension } from "./desktop.js";
import { PULL_REQUEST_DRAG_TYPE, PULL_REQUEST_TAB, THREAD_PULL_REQUESTS_TAB, type PullRequestCheck, type ReviewRequest, type ThreadPullRequestLink } from "./protocol.js";
import { RequestLinks } from "./request-links.js";
import type { PullRequestClient } from "./pull-request-client.js";
import PullRequestStrip from "./pull-request-strip.js";
import { STRIP_OPTION, StripDismissals, checksPulse, requestEndings, stripEnded, stripRequests, watchTally, watchedRequests } from "./pull-request-strip-logic.js";
import { PullRequestWatchFeed } from "./pr-watch-client.js";
import { parseRequestUrl } from "./pull-request-json.js";
import type { PullRequestWatch, WatchSnapshot } from "./pr-watch-protocol.js";
import { RowRequests } from "./requests.js";
import { ThreadLinkRows } from "./thread-links-store.js";

afterEach(cleanup);

function memoryStorage(): ClientStorage {
  const values = new Map<string, string>();
  return { get: (key) => values.get(key) ?? null, set: (key, value) => { values.set(key, value); }, remove: (key) => { values.delete(key); }, keys: () => [...values.keys()] };
}

function preferences(): PreferencesStore {
  const options = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  let snapshot = {};
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    optionValue: (_extension: string, id: string, fallback: unknown) => options.has(id) ? options.get(id) : fallback,
    setOption: (_extension: string, id: string, value: unknown) => { options.set(id, value); snapshot = {}; for (const listener of listeners) listener(); },
  } as unknown as PreferencesStore;
}

const BRANCH: ReviewRequest = {
  provider: "github", number: 224, title: "Refresh apps without a socket", url: "https://github.com/acme/lakebed/pull/224",
  baseRef: "main", headRef: "fix/refresh-apps-without-socket", state: "open", checks: { passed: 3, failed: 0, pending: 0, total: 3 },
};

const link = (number: number, extra: Partial<ThreadPullRequestLink> = {}): ThreadPullRequestLink => ({
  url: `https://github.com/acme/lakebed/pull/${number}`, service: "github", host: "github.com", repo: "acme/lakebed", number,
  source: "agent", linkedAt: number, title: `Change ${number}`, state: "open", ...extra,
});

/** A transcript-rows handle that keeps what the strip published, per thread. */
function endingRows() {
  const published = new Map<string, readonly TranscriptRow[]>();
  const handle: TranscriptRowsHandle = { setRows: (sessionId, rows) => { published.set(sessionId, rows); }, clear: () => published.clear(), dispose: () => published.clear() };
  return { handle, rows: (sessionId = "t1") => published.get(sessionId) ?? [] };
}

function setup({ branch, links = [], draftPending = false, empty = false, live, unlinked = false, watches, messages, endings }: { branch?: ReviewRequest; links?: ThreadPullRequestLink[]; draftPending?: boolean; empty?: boolean; live?: PullRequestClient; unlinked?: boolean; watches?: PullRequestWatchFeed; messages?: { id: string; timestamp: number }[]; endings?: TranscriptRowsHandle } = {}) {
  let changed: ((threadId: string) => void) | undefined;
  let current = unlinked ? [] : links.length ? links : branch ? [link(branch.number, { ...branch })] : [];
  const client = { links: vi.fn(async () => current), onLinksChanged: (listener: (threadId: string) => void) => { changed = listener; return () => undefined; } };
  let currentBranch = branch;
  const load = vi.fn(async () => currentBranch);
  const parts = { rows: new RowRequests(load), links: new ThreadLinkRows(client), preferences: preferences(), dismissals: new StripDismissals(memoryStorage), ...(live ? { client: live } : {}), ...(watches ? { watches } : {}), ...(endings ? { endings } : {}) };
  const actions = { activeThread: () => ({ sessionId: "t1", cwd: "/work", draftPending }), openStageTab: vi.fn(() => "tab") } as unknown as WorkbenchActions;
  const snapshot = { sessionId: "t1", cwd: "/work", projectLabel: "fix/refresh-apps-without-socket", isStreaming: false, messages: empty ? [] : messages ?? [{ id: "m1" }] } as unknown as HostSnapshot;
  const view = render(<><RequestLinks actions={actions} /><PullRequestStrip snapshot={snapshot} actions={actions} parts={parts} /></>);
  const relink = (next: ThreadPullRequestLink[]) => { current = next; act(() => changed?.("t1")); };
  return { view, parts, actions, load, relink, externalLinks: (next: ThreadPullRequestLink[]) => { current = next; }, externalState: (state: ReviewRequest["state"]) => { if (currentBranch) { currentBranch = { ...currentBranch, state }; current = current.map((entry) => entry.url === currentBranch!.url ? { ...entry, state } : entry); } } };
}

const strip = () => document.querySelector(".review-pr-strip");

describe("choosing the thread's request", () => {
  it("puts open requests first, the branch's own before links, then the latest link", () => {
    expect(stripRequests(undefined, [])).toBeUndefined();
    const found = stripRequests({ ...BRANCH, state: "merged" }, [link(1, { linkedAt: 5 }), link(2, { linkedAt: 9 }), link(3, { state: "closed", linkedAt: 20 })])!;
    expect([found.primary.number, ...found.others.map((entry) => entry.number)]).toEqual([2, 1, 224, 3]);
    const open = stripRequests(BRANCH, [link(1, { linkedAt: 50 })])!;
    expect(open.primary.number).toBe(224);
  });

  it("merges a link of the branch's request into it, and trusts the link when it saw the request end", () => {
    const found = stripRequests(BRANCH, [link(224, { state: "merged", headRef: "other" })])!;
    expect(found.others).toEqual([]);
    expect(found.primary).toMatchObject({ number: 224, state: "merged", headRef: "fix/refresh-apps-without-socket", repo: "acme/lakebed", checks: BRANCH.checks });
  });

  it("hides per thread for one request in one state, and forgets the oldest past its limit", () => {
    const storage = memoryStorage();
    const dismissals = new StripDismissals(() => storage);
    const request = { url: BRANCH.url, state: "open" as const };
    dismissals.hide("t1", request);
    expect(new StripDismissals(() => storage).isHidden("t1", request)).toBe(true);
    expect(dismissals.isHidden("t1", { ...request, state: "merged" })).toBe(false);
    expect(dismissals.isHidden("t2", request)).toBe(false);
    for (let index = 0; index < 200; index += 1) dismissals.hide(`other-${index}`, request);
    expect(dismissals.isHidden("t1", request)).toBe(false);
    expect(dismissals.isHidden("other-199", request)).toBe(true);
  });
});

describe("the pull-request strip", () => {
  it("refreshes linked completion without a local event and trusts it over the cached open branch", async () => {
    vi.useFakeTimers();
    try {
      const { externalLinks } = setup({ branch: BRANCH, links: [link(224)] });
      await act(async () => undefined);
      expect(strip()?.classList.contains("state-open")).toBe(true);
      externalLinks([link(224, { state: "merged" })]);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(strip()).toBeNull();
    } finally { cleanup(); vi.useRealTimers(); }
  });
  it("reads external completion when the branch cache is explicitly refreshed", async () => {
    const { externalState, parts } = setup({ branch: BRANCH });
    await waitFor(() => expect(strip()?.classList.contains("state-open")).toBe(true));
    externalState("merged");
    await act(async () => { parts.rows.ensure("/work", true); });
    expect(strip()).toBeNull();
  });
  it("refreshes an externally merged request while the same branch remains on screen", async () => {
    vi.useFakeTimers();
    try {
      const { externalState } = setup({ branch: BRANCH });
      await act(async () => undefined);
      expect(strip()?.classList.contains("state-open")).toBe(true);
      externalState("merged");
      await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
      expect(strip()).toBeNull();
      expect(screen.queryByRole("button", { name: /, open,/ })).toBeNull();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("draws the branch's open request with its checks, repository and branch, and opens its tab", async () => {
    const { actions, load } = setup({ branch: BRANCH });
    const open = await screen.findByRole("button", { name: /^Open pull request #224 in acme\/lakebed on GitHub, open, checks 3\/3 passed/u });
    expect(load).toHaveBeenCalledWith("/work");
    expect(strip()!.className).toBe("review-pr-strip state-open");
    expect(open.textContent).toBe("#224Refresh apps without a socketOpen");
    // The state is its glyph, named in the tooltip.
    expect(within(open).getByRole("img", { name: "Open" }).getAttribute("data-tooltip")).toBe("Open");
    expect(open.querySelector(".review-pr-strip-checks.passed")!.getAttribute("data-tooltip")).toBe("Checks: 3/3 passed");
    // The provider is a mark with a tooltip, never a name beside it.
    expect(open.querySelector(".review-pr-strip-service")!.getAttribute("data-tooltip")).toBe("GitHub · github.com/acme/lakebed");
    fireEvent.click(open);
    expect(actions.openStageTab).toHaveBeenCalledWith("review.pull-request", { url: BRANCH.url, number: 224, service: "github", workspace: "/work" }, { key: BRANCH.url });
  });

  it("drags a linked request as typed composer context with ordinary URL fallbacks", async () => {
    const request = link(31, { headRef: "feature/context", draft: true });
    const { actions } = setup({ links: [request] });
    const button = await screen.findByRole("button", { name: /^Open pull request #31 / });
    expect(button.draggable).toBe(true);
    const dataTransfer = { setData: vi.fn(), effectAllowed: "none" };
    fireEvent.dragStart(button, { dataTransfer });
    expect(dataTransfer.effectAllowed).toBe("copy");
    expect(JSON.parse(dataTransfer.setData.mock.calls.find(([type]) => type === PULL_REQUEST_DRAG_TYPE)![1]))
      .toEqual({ number: 31, title: "Change 31", url: request.url, branch: "feature/context" });
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", request.url);
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/uri-list", request.url);
    expect(actions.openStageTab).not.toHaveBeenCalled();
  });

  it.each([
    [{ state: "open", checks: { passed: 1, failed: 1, pending: 0, total: 2 } }, "state-open", "Open", "failed"],
    [{ state: "open", checks: { passed: 1, failed: 0, pending: 1, total: 2 } }, "state-open", "Open", "pending"],
    [{ state: "open", draft: true }, "state-draft", "Draft", undefined],
  ] as const)("tints %j as %s", async (patch, className, word, checks) => {
    setup({ branch: { ...BRANCH, checks: undefined, ...patch } as ReviewRequest });
    await waitFor(() => expect(strip()).not.toBeNull());
    expect(strip()!.classList.contains(className)).toBe(true);
    const glyph = strip()!.querySelector(".review-pr-strip-glyph")!;
    expect(glyph.getAttribute("aria-label")).toBe(word);
    expect(glyph.classList.contains(className.replace("state-", ""))).toBe(true);
    expect(strip()!.querySelector(".review-pr-strip-checks")?.classList[1]).toBe(checks);
  });

  it("shows a linked request when the branch has none, with the others as +N", async () => {
    const { actions } = setup({ links: [link(7, { linkedAt: 1, state: "merged" }), link(9, { linkedAt: 2, headRef: "feat/nine" })] });
    const more = await waitFor(() => {
      const found = document.querySelector(".review-pr-strip-more");
      if (!found) throw new Error("no +N yet");
      return found;
    });
    expect(strip()!.querySelector(".review-pr-strip-number")!.textContent).toBe("#9");
    expect(more.textContent).toBe("+1");
    expect(more.getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.getByRole("button", { name: /^Open pull request #9 .*1 more linked/u })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View all 2 linked requests" }));
    expect(actions.openStageTab).toHaveBeenCalledWith(THREAD_PULL_REQUESTS_TAB, { threadId: "t1", workspace: "/work" }, { key: "thread-pull-requests:t1" });
    expect(more.closest("button")?.parentElement?.closest("button")).toBeNull();
  });

  it("opens the rail's request popover on +N hover and lets the pointer enter its links", async () => {
    const { actions } = setup({ links: [link(7, { state: "merged" }), link(9)] });
    const more = await screen.findByRole("button", { name: "View all 2 linked requests" });
    fireEvent.pointerEnter(more, { pointerType: "mouse" });
    const popup = await screen.findByRole("dialog", { name: "Thread pull requests" });
    expect(within(popup).getAllByRole("link")).toHaveLength(2);
    const request = within(popup).getByRole("link", { name: "PR #7, merged: Change 7" });
    fireEvent.pointerLeave(more, { pointerType: "mouse" });
    fireEvent.pointerEnter(popup.firstElementChild!, { pointerType: "mouse" });
    fireEvent.click(request);
    expect(actions.openStageTab).toHaveBeenCalledWith(PULL_REQUEST_TAB, {
      url: link(7).url, number: 7, service: "github", workspace: "/work",
      fromThread: { threadId: "t1", workspace: "/work" },
    }, { key: link(7).url });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread pull requests" })).toBeNull());
  });

  it("opens +N's popover with ArrowDown and closes it with Escape", async () => {
    setup({ links: [link(7), link(9)] });
    const more = await screen.findByRole("button", { name: "View all 2 linked requests" });
    more.focus();
    fireEvent.keyDown(more, { key: "ArrowDown" });
    const popup = await screen.findByRole("dialog", { name: "Thread pull requests" });
    await within(popup).findByRole("link", { name: "PR #9, open: Change 9" });
    expect(document.activeElement).toBe(more);
    fireEvent.keyDown(more, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread pull requests" })).toBeNull());
  });

  it("follows a link's state change, and × hides it until the state changes again", async () => {
    const { relink } = setup({ links: [link(9)] });
    const hide = await screen.findByRole("button", { name: "Hide PR #9 for this thread" });
    fireEvent.click(hide);
    expect(strip()).toBeNull();
    relink([link(9, { draft: true })]);
    await waitFor(() => expect(strip()?.classList.contains("state-draft")).toBe(true));
  });

  it("draws nothing without a request, for a draft or a thread without messages, or with the setting off", async () => {
    const empty = setup();
    await waitFor(() => expect(empty.load).toHaveBeenCalled());
    expect(empty.view.container.textContent).toBe("");
    cleanup();
    const draft = setup({ branch: BRANCH, draftPending: true });
    await act(async () => undefined);
    expect(draft.load).not.toHaveBeenCalled();
    expect(draft.view.container.innerHTML).toBe("");
    cleanup();
    const fresh = setup({ branch: BRANCH, empty: true });
    await act(async () => undefined);
    expect(fresh.load).not.toHaveBeenCalled();
    expect(fresh.view.container.innerHTML).toBe("");
    cleanup();
    const { parts } = setup({ branch: BRANCH });
    await waitFor(() => expect(strip()).not.toBeNull());
    act(() => parts.preferences.setOption("tau.review", STRIP_OPTION, false));
    expect(strip()).toBeNull();
  });

  it("is a composer-above region of the kit, below the runtime banners and above the settled note", async () => {
    const { registry } = createKitHarness();
    registry.activate(reviewExtension);
    const region = registry.getRegions("composer-above").find((entry) => entry.id === "review.pull-request-strip")!;
    expect(region.order).toBe(80);
    registry.deactivate(reviewExtension.id);
  });

  it.each(["desktop", "web"] as const)("consolidates supported desktop cards while keeping the %s fallback and older services", (profile) => {
    const { registry } = createKitHarness(undefined, profile);
    const register = vi.fn(() => () => undefined);
    let summarySupported = true;
    const workspace: DesktopExtension = { id: "test.workspace-summary", name: "Workspace summary", activate(context) {
      return context.provideService("tau.workspace/store", {
        ...(summarySupported ? { registerWorkspaceSummarySection: register } : {}),
        registerReviewView: register,
        registerCommitMessageSuggester: register,
        registerChangesSection: register,
        registerThreadRowAccessory: register,
      });
    } };
    registry.activate(reviewExtension);
    const stripRegion = () => registry.getRegions("composer-above").find((entry) => entry.id === "review.pull-request-strip");
    expect(stripRegion()).toBeTruthy();
    registry.activate(workspace);
    expect(stripRegion()).toBeTruthy();
    registry.deactivate(workspace.id);
    expect(stripRegion()).toBeTruthy();
    summarySupported = false;
    registry.activate(workspace);
    expect(stripRegion()).toBeTruthy();
    registry.deactivate(workspace.id);
    registry.deactivate(reviewExtension.id);
    expect(stripRegion()).toBeUndefined();
  });
});

describe("the checks on the chip", () => {
  const RUN = "https://github.com/acme/lakebed/actions/runs/77/job/";
  const running: PullRequestCheck[] = [
    { name: "lint", status: "passed", workflow: "CI", url: `${RUN}1` },
    { name: "test", status: "pending", workflow: "CI", url: `${RUN}2`, startedAt: new Date(Date.now() - 60_000).toISOString() },
    { name: "e2e", status: "pending", workflow: "CI", url: `${RUN}3`, queued: true },
  ];

  // Each test its own request: finished reads are kept per request for a while.
  const request = (number: number, checks: ReviewRequest["checks"]): ReviewRequest => ({ ...BRANCH, number, url: `https://github.com/acme/lakebed/pull/${number}`, checks });
  const FILE = [{ id: "lint", needs: [] }, { id: "test", needs: ["lint"] }, { id: "e2e", needs: ["test"] }];

  it("draws a circle per stage while checks run, fills the running one, and opens the request at its checks", async () => {
    const checks = vi.fn(async () => running);
    const pipeline = vi.fn(async () => ({ 77: { jobs: FILE, expected: { test: 120_000 } } }));
    const branch = request(301, { passed: 1, failed: 0, pending: 2, total: 3 });
    const { actions } = setup({ branch, live: { checks, pipeline } as unknown as PullRequestClient });
    const mini = await screen.findByRole("img", { name: "Checks: CI passed, running, queued" });
    expect(pipeline).toHaveBeenCalledWith(branch.url, ["77"]);
    // The running stage: about half of its usual two minutes.
    const wedge = mini.querySelector(".plm-stage[data-state=running] .pl-wedge")!;
    const [filled, turn] = wedge.getAttribute("stroke-dasharray")!.split(" ").map(Number);
    expect(filled! / turn!).toBeGreaterThan(0.49);
    expect(filled! / turn!).toBeLessThan(0.6);
    fireEvent.click(mini);
    expect(actions.openStageTab).toHaveBeenCalledWith("review.pull-request", expect.objectContaining({ url: branch.url, focus: "checks" }), { key: branch.url });
    expect(checks).toHaveBeenCalledTimes(1);
  });

  it("lists a stage's jobs with their times on hover", async () => {
    const branch = request(302, { passed: 1, failed: 0, pending: 2, total: 3 });
    setup({ branch, live: { checks: vi.fn(async () => running), pipeline: vi.fn(async () => ({ 77: { jobs: FILE, expected: {} } })) } as unknown as PullRequestClient });
    const mini = await screen.findByRole("img", { name: "Checks: CI passed, running, queued" });
    fireEvent.pointerEnter(mini.querySelector(".plm-stage[data-state=running]")!);
    const card = await screen.findByRole("tooltip");
    expect(card.textContent).toMatch(/^CIStage 2 of 3test1m \d+s, no usual time yet$/u);
    fireEvent.pointerLeave(mini);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("reads finished checks once, and not again when the chip comes back soon", async () => {
    const passed = running.map((check) => ({ ...check, status: "passed" as const, queued: false }));
    const checks = vi.fn(async () => passed);
    const branch = request(303, { passed: 3, failed: 0, pending: 0, total: 3 });
    const live = { checks, pipeline: vi.fn(async () => ({})) } as unknown as PullRequestClient;
    setup({ branch, live });
    await screen.findByRole("img", { name: "Checks: CI passed" });
    cleanup();
    setup({ branch, live });
    await screen.findByRole("img", { name: "Checks: CI passed" });
    expect(checks).toHaveBeenCalledTimes(1);
  });

  it("shows the finished state the live read found, before the row learns it", async () => {
    const checks = vi.fn(async () => running.map((check) => ({ ...check, status: check.name === "e2e" ? "failed" as const : "passed" as const, queued: false })));
    setup({ branch: request(304, { passed: 1, failed: 0, pending: 2, total: 3 }), live: { checks, pipeline: vi.fn(async () => ({})) } as unknown as PullRequestClient });
    expect(await screen.findByRole("img", { name: "Checks: CI failed" })).toBeTruthy();
  });
});

describe("live check completion", () => {
  it("keeps polling when one job failed while another is still running", async () => {
    vi.useFakeTimers();
    try {
      const checks = vi.fn()
        .mockResolvedValueOnce([{ name: "performance", status: "failed", workflow: "CI" }, { name: "smoke", status: "pending", workflow: "CI" }])
        .mockResolvedValue([{ name: "performance", status: "passed", workflow: "CI" }, { name: "smoke", status: "passed", workflow: "CI" }]);
      setup({ branch: { ...BRANCH, url: `${BRANCH.url}05`, checks: { passed: 0, failed: 1, pending: 1, total: 2 } }, live: { checks, pipeline: vi.fn(async () => ({})) } as unknown as PullRequestClient });
      await act(async () => undefined);
      expect(screen.getByRole("img", { name: "Checks: CI failed" })).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(checks).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("img", { name: "Checks: CI passed" })).toBeTruthy();
    } finally { cleanup(); vi.useRealTimers(); }
  });

  it("keeps reading an empty answer after a push until the checks appear", async () => {
    vi.useFakeTimers();
    try {
      const checks = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ name: "smoke", status: "pending", workflow: "CI" }]);
      setup({ branch: { ...BRANCH, url: `${BRANCH.url}06`, checks: undefined }, live: { checks, pipeline: vi.fn(async () => ({})) } as unknown as PullRequestClient });
      await act(async () => undefined);
      expect(checks).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(checks).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("img", { name: "Checks: CI running" })).toBeTruthy();
    } finally { cleanup(); vi.useRealTimers(); }
  });

  it("reads checks that just finished again, as the next stage may not have started, and stops once they settle", async () => {
    vi.useFakeTimers();
    try {
      const done = new Date().toISOString();
      const checks = vi.fn().mockResolvedValue([{ name: "lint", status: "passed", workflow: "CI", completedAt: done }]);
      setup({ branch: { ...BRANCH, url: `${BRANCH.url}07`, checks: { passed: 1, failed: 0, pending: 0, total: 1 } }, live: { checks, pipeline: vi.fn(async () => ({})) } as unknown as PullRequestClient });
      await act(async () => undefined);
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(checks).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
      // A minute after the last check ended, the answer is believed.
      expect(checks).toHaveBeenCalledTimes(7);
    } finally { cleanup(); vi.useRealTimers(); }
  });

  it("reads running checks rarely while their usual end is far ahead", async () => {
    vi.useFakeTimers();
    try {
      const RUN = "https://github.com/acme/lakebed/actions/runs/88/job/";
      const checks = vi.fn().mockResolvedValue([{ name: "test", status: "pending", workflow: "CI", url: `${RUN}1`, startedAt: new Date().toISOString() }]);
      const pipeline = vi.fn(async () => ({ 88: { jobs: [{ id: "test", needs: [] }], expected: { test: 20 * 60_000 } } }));
      setup({ branch: { ...BRANCH, url: `${BRANCH.url}09`, checks: { passed: 0, failed: 0, pending: 1, total: 1 } }, live: { checks, pipeline } as unknown as PullRequestClient });
      await act(async () => undefined);
      expect(pipeline).toHaveBeenCalled();
      // The first wait is the ordinary one, before the usual durations arrived; then once a minute.
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(checks).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
      expect(checks).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(checks).toHaveBeenCalledTimes(3);
    } finally { cleanup(); vi.useRealTimers(); }
  });
});

it("rereads finished checks when the request summary changes within the cache lifetime", async () => {
  const url = `${BRANCH.url}06`;
  const checks = vi.fn().mockResolvedValueOnce([{ name: "CI", status: "failed" }]).mockResolvedValue([{ name: "CI", status: "passed" }]);
  const live = { checks, pipeline: vi.fn(async () => ({})) } as unknown as PullRequestClient;
  setup({ branch: { ...BRANCH, url, checks: { passed: 0, failed: 1, pending: 0, total: 1 } }, live });
  await screen.findByRole("img", { name: "Checks: Other checks failed" });
  cleanup();
  setup({ branch: { ...BRANCH, url, checks: { passed: 1, failed: 0, pending: 0, total: 1 } }, live });
  await screen.findByRole("img", { name: "Checks: Other checks passed" });
  expect(checks).toHaveBeenCalledTimes(2);
});

it("keeps finished checks scoped to the current host client", async () => {
  const url = `${BRANCH.url}07`;
  const branch = { ...BRANCH, url, checks: { passed: 0, failed: 0, pending: 0, total: 0 } };
  const first = { checks: vi.fn(async () => [{ name: "CI", status: "failed" }]), pipeline: vi.fn(async () => ({})) } as unknown as PullRequestClient;
  setup({ branch, live: first });
  await screen.findByRole("img", { name: "Checks: Other checks failed" });
  cleanup();
  const second = { checks: vi.fn(async () => [{ name: "CI", status: "passed" }]), pipeline: vi.fn(async () => ({})) } as unknown as PullRequestClient;
  setup({ branch, live: second });
  await screen.findByRole("img", { name: "Checks: Other checks passed" });
  expect(second.checks).toHaveBeenCalledTimes(1);
});

it("does not let an unmounted checks lookup overwrite a newer finished answer", async () => {
  let finish!: (checks: PullRequestCheck[]) => void;
  const checks = vi.fn().mockImplementationOnce(() => new Promise<PullRequestCheck[]>((resolve) => { finish = resolve; })).mockResolvedValue([{ name: "CI", status: "passed" }]);
  const live = { checks, pipeline: vi.fn(async () => ({})) } as unknown as PullRequestClient;
  const branch = { ...BRANCH, url: `${BRANCH.url}08`, checks: { passed: 1, failed: 0, pending: 0, total: 1 } };
  setup({ branch, live });
  await act(async () => undefined);
  cleanup();
  setup({ branch, live });
  await screen.findByRole("img", { name: "Checks: Other checks passed" });
  await act(async () => { finish([{ name: "CI", status: "failed" }]); });
  cleanup();
  setup({ branch, live });
  await screen.findByRole("img", { name: "Checks: Other checks passed" });
  expect(checks).toHaveBeenCalledTimes(2);
});


it("does not present an unlinked branch PR as this thread's association", async () => {
  const { load } = setup({ branch: { ...BRANCH, state: "merged" }, unlinked: true });
  await waitFor(() => expect(load).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: /Open pull request/ })).toBeNull();
});

const snapshotAt = (head: string, checks: WatchSnapshot["checks"] = "pending"): WatchSnapshot => ({ state: "OPEN", head, checks, failed: [], comments: "0", conflict: false });
const watchOf = (number: number, extra: Partial<PullRequestWatch> = {}): PullRequestWatch => ({
  threadId: "t1", ref: parseRequestUrl(link(number).url)!, status: "watching", startedAt: number, wakes: 0, commentStreak: 0, baseline: snapshotAt("a"), ...extra,
});

/** A watch feed whose host answers `watches` and pushes what `emit` gives it. */
function watchFeed(watches: PullRequestWatch[]) {
  let push: ((value: unknown) => void) | undefined;
  let current = watches;
  const invoke = vi.fn(async (command: string, input?: unknown) => {
    if (command === "watch-stop") current = current.map((watch) => watch.ref.url === (input as { url: string }).url ? { ...watch, status: "ended" as const } : watch);
    return { watches: current, canManage: true };
  });
  const feed = new PullRequestWatchFeed({ invoke, onEvent: (_name: string, listener: (value: unknown) => void) => { push = listener; return () => undefined; } } as never);
  return { feed, invoke, emit: (next: PullRequestWatch[]) => { current = next; act(() => push?.(next)); } };
}

describe("the thread's watched requests", () => {
  it("lists every other watch under the first request, in the order it started, from the link where there is one", () => {
    const primary = stripRequests(undefined, [link(345, { linkedAt: 9 }), link(331, { linkedAt: 1 })])!;
    const rows = watchedRequests(primary.primary, primary.others, [watchOf(331, { startedAt: 2 }), watchOf(345), watchOf(12, { startedAt: 1 }), watchOf(40, { status: "ended" }), watchOf(41, { threadId: "t2" })], "t1");
    expect(rows.map(({ request }) => [request.number, request.title])).toEqual([[12, undefined], [331, "Change 331"]]);
  });

  it("moves its pulse on a push, new counts, or what the watch read; not on a later read of the same state", () => {
    const request = { ...stripRequests(undefined, [link(1, { headSha: "a" })])!.primary };
    const pulse = checksPulse(request, watchOf(1));
    expect(checksPulse(request, watchOf(1, { lastReadAt: 99 }))).toBe(pulse);
    expect(checksPulse({ ...request, headSha: "b" }, watchOf(1))).not.toBe(pulse);
    expect(checksPulse(request, watchOf(1, { baseline: snapshotAt("b") }))).not.toBe(pulse);
    expect(checksPulse(request, watchOf(1, { baseline: snapshotAt("a", "done") }))).not.toBe(pulse);
    expect(checksPulse(request, watchOf(1, { status: "ended", baseline: snapshotAt("c") }))).toBe(checksPulse(request));
  });

  it("draws a row per watched request with its own watch, and drops it when the watch stops", async () => {
    const { feed, emit } = watchFeed([watchOf(331), watchOf(345)]);
    setup({ links: [link(345, { linkedAt: 9 }), link(331, { linkedAt: 1 }), link(332, { linkedAt: 2 })], watches: feed });
    expect(await screen.findByRole("group", { name: "2 pull requests" })).toBeTruthy();
    // There from the first draw: no arrival.
    expect(document.querySelector(".review-pr-strip.arriving")).toBeNull();
    emit([watchOf(331), watchOf(345), watchOf(332)]);
    await waitFor(() => expect(document.querySelector(".review-pr-strip.arriving")?.textContent).toContain("#332"));
    emit([watchOf(331), watchOf(345)]);
    await waitFor(() => expect(document.querySelector(".review-pr-strip.leaving")).toBeNull());
    expect(screen.getByRole("button", { name: /^Open pull request #345/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Open pull request #331/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Watching for PR #345" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Watching for PR #331" })).toBeTruthy();
    // +N counts only the links no row shows: #332 alone.
    expect(screen.getByRole("button", { name: "View all 3 linked requests" }).textContent).toBe("+1");
    emit([watchOf(331, { status: "ended" }), watchOf(345)]);
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Open pull request #331/u })).toBeNull());
    // It folds away hidden from assistive technology, then goes.
    expect(document.querySelector(".review-pr-strip.leaving[aria-hidden=true]")).not.toBeNull();
    await waitFor(() => expect(document.querySelector(".review-pr-strip.leaving")).toBeNull());
    expect(screen.queryByRole("group", { name: /pull requests/u })).toBeNull();
  });

  it("tallies folded watches worst first, and leaves out one without checks", () => {
    const failed = { ...snapshotAt("a", "done"), failed: [{ id: "1", name: "smoke" }] };
    expect(watchTally([watchOf(1, { baseline: snapshotAt("a", "done") }), watchOf(2, { baseline: failed }), watchOf(3), watchOf(4, { baseline: snapshotAt("a", "none") }), watchOf(5, { status: "unreadable" }), watchOf(6, { baseline: snapshotAt("b", "done") })]))
      .toEqual([{ tone: "failed", count: 1 }, { tone: "unreadable", count: 1 }, { tone: "pending", count: 1 }, { tone: "passed", count: 2 }]);
  });

  it("folds watches past the third into one line that says where they stand, and unfolds them", async () => {
    const numbers = [11, 12, 13, 14, 15];
    const failed = { ...snapshotAt("a", "done"), failed: [{ id: "1", name: "smoke" }] };
    const { feed } = watchFeed(numbers.map((number) => watchOf(number, number === 15 ? { baseline: failed } : {})));
    setup({ links: [link(1, { linkedAt: 99 }), ...numbers.map((number) => link(number))], watches: feed });
    const fold = await screen.findByRole("button", { name: "2 more watched: 1 failed, 1 running" });
    expect(fold.classList.contains("failed")).toBe(true);
    expect(screen.queryByRole("button", { name: /^Open pull request #14/u })).toBeNull();
    expect(screen.getByRole("button", { name: "View all 6 linked requests" }).textContent).toBe("+2");
    fireEvent.click(fold);
    expect(screen.getByRole("button", { name: /^Open pull request #15/u })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.queryByRole("button", { name: /^Open pull request #15/u })).toBeNull();
  });

  it("reads finished checks again when the watch sees a push, and keeps the old ones on the chip meanwhile", async () => {
    let finish!: (checks: PullRequestCheck[]) => void;
    const checks = vi.fn()
      .mockResolvedValueOnce([{ name: "CI", status: "failed" }])
      .mockImplementationOnce(() => new Promise<PullRequestCheck[]>((resolve) => { finish = resolve; }));
    const { feed, emit } = watchFeed([watchOf(331, { baseline: snapshotAt("a", "done") })]);
    setup({ links: [link(331)], live: { checks, pipeline: vi.fn(async () => ({})) } as unknown as PullRequestClient, watches: feed });
    await screen.findByRole("img", { name: "Checks: Other checks failed" });
    emit([watchOf(331, { baseline: snapshotAt("b") })]);
    await waitFor(() => expect(checks).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("img", { name: "Checks: Other checks failed" })).toBeTruthy();
    await act(async () => { finish([{ name: "CI", status: "pending" }]); });
    expect(await screen.findByRole("img", { name: "Checks: Other checks running" })).toBeTruthy();
  });
});

describe("a merged or closed request", () => {
  const ended = (number: number, extra: Partial<ThreadPullRequestLink> = {}) => stripRequests(undefined, [link(number, { state: "merged", endedAt: 500, ...extra })])!.primary;

  it("folds the strip away unless a watch of the thread still reads one of its requests", () => {
    expect(stripEnded(ended(9), [], "t1")).toBe(true);
    expect(stripEnded(ended(9, { state: "closed" }), [], "t1")).toBe(true);
    expect(stripEnded(ended(9), [watchOf(9)], "t1")).toBe(false);
    expect(stripEnded(ended(9), [watchOf(12, { status: "unreadable" })], "t1")).toBe(false);
    expect(stripEnded(ended(9), [watchOf(9, { status: "ended" }), watchOf(9, { threadId: "t2" })], "t1")).toBe(true);
    expect(stripEnded(stripRequests(undefined, [link(9)])!.primary, [], "t1")).toBe(false);
  });

  it("places each end after the last message before it, and leaves out what a watch's wake says or will say", () => {
    const messages = [{ id: "a", timestamp: 100 }, { id: "b", timestamp: 400 }, { id: "c", timestamp: 900 }];
    const { primary, others } = stripRequests(undefined, [
      link(1, { state: "merged", endedAt: 500 }), link(2, { state: "closed", endedAt: 50 }), link(3, { state: "merged", endedAt: 950 }), link(4),
      link(5, { state: "merged", endedAt: 600 }), link(6, { state: "merged", endedAt: 700 }), link(7, { state: "merged", endedAt: 800 }),
    ])!;
    const watches = [watchOf(5, { status: "ended", reason: "PR merged" }), watchOf(6), watchOf(7, { status: "ended", stoppedBy: "user" })];
    expect(requestEndings([primary, ...others], messages, watches, "t1").map(({ request, afterMessageId, watched }) => [request.number, afterMessageId, watched]))
      .toEqual([[7, "b", true], [3, "c", false], [1, "b", false]]);
  });

  it("dates an end from the link's first read of it when the host gave no time", () => {
    expect(stripRequests(undefined, [link(1, { state: "merged", refreshedAt: 300 })])!.primary.endedAt).toBe(300);
    expect(stripRequests(undefined, [link(1, { state: "merged", refreshedAt: 300, endedAt: 200 })])!.primary.endedAt).toBe(200);
    expect(stripRequests(undefined, [link(1, { refreshedAt: 300 })])!.primary.endedAt).toBeUndefined();
  });

  it("leaves the composer for a line in the transcript where it merged, which opens its tab", async () => {
    const endings = endingRows();
    const { actions } = setup({ links: [link(9, { state: "merged", endedAt: 500 })], messages: [{ id: "m1", timestamp: 100 }, { id: "m2", timestamp: 900 }], endings: endings.handle });
    await waitFor(() => expect(endings.rows()).toHaveLength(1));
    expect(strip()).toBeNull();
    const [row] = endings.rows();
    expect(row).toMatchObject({ id: link(9).url, afterMessageId: "m1" });
    render(<>{row!.content}</>);
    const line = screen.getByRole("button", { name: "Open pull request #9, merged: Change 9" });
    expect(line.textContent).toMatch(/^PR #9 merged\d/u);
    fireEvent.click(line);
    expect(actions.openStageTab).toHaveBeenCalledWith(PULL_REQUEST_TAB, { url: link(9).url, number: 9, service: "github", workspace: "/work" }, { key: link(9).url });
  });

  it("stays while its watch still reads it, and folds without a line once the watch's wake said it merged", async () => {
    const endings = endingRows();
    const { feed, emit } = watchFeed([watchOf(9)]);
    setup({ links: [link(9, { state: "merged", endedAt: 500 })], messages: [{ id: "m1", timestamp: 100 }], watches: feed, endings: endings.handle });
    await waitFor(() => expect(strip()?.classList.contains("state-merged")).toBe(true));
    expect(endings.rows()).toEqual([]);
    emit([watchOf(9, { status: "ended", reason: "PR merged" })]);
    await waitFor(() => expect(strip()).toBeNull());
    expect(endings.rows()).toEqual([]);
  });
});
