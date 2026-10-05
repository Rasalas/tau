// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientStorage, DesktopExtension, HostSnapshot, PreferencesStore, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { reviewExtension } from "./desktop.js";
import type { PullRequestCheck, ReviewRequest, ThreadPullRequestLink } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";
import PullRequestStrip from "./pull-request-strip.js";
import { STRIP_OPTION, StripDismissals, stripRequests } from "./pull-request-strip-logic.js";
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

function setup({ branch, links = [], draftPending = false, empty = false, live, unlinked = false }: { branch?: ReviewRequest; links?: ThreadPullRequestLink[]; draftPending?: boolean; empty?: boolean; live?: PullRequestClient; unlinked?: boolean } = {}) {
  let changed: ((threadId: string) => void) | undefined;
  let current = unlinked ? [] : links.length ? links : branch ? [link(branch.number, { ...branch })] : [];
  const client = { links: vi.fn(async () => current), onLinksChanged: (listener: (threadId: string) => void) => { changed = listener; return () => undefined; } };
  let currentBranch = branch;
  const load = vi.fn(async () => currentBranch);
  const parts = { rows: new RowRequests(load), links: new ThreadLinkRows(client), preferences: preferences(), dismissals: new StripDismissals(memoryStorage), ...(live ? { client: live } : {}) };
  const actions = { activeThread: () => ({ sessionId: "t1", cwd: "/work", draftPending }), openStageTab: vi.fn(() => "tab") } as unknown as WorkbenchActions;
  const snapshot = { sessionId: "t1", cwd: "/work", projectLabel: "fix/refresh-apps-without-socket", isStreaming: false, messages: empty ? [] : [{ id: "m1" }] } as unknown as HostSnapshot;
  const view = render(<PullRequestStrip snapshot={snapshot} actions={actions} parts={parts} />);
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
      externalLinks([link(224, { state: "merged" })]);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(strip()?.classList.contains("state-merged")).toBe(true);
    } finally { cleanup(); vi.useRealTimers(); }
  });
  it("reads external completion when the branch cache is explicitly refreshed", async () => {
    const { externalState, parts } = setup({ branch: BRANCH });
    await act(async () => undefined);
    externalState("merged");
    await act(async () => { parts.rows.ensure("/work", true); });
    expect(strip()?.classList.contains("state-merged")).toBe(true);
  });
  it("refreshes an externally merged request while the same branch remains on screen", async () => {
    vi.useFakeTimers();
    try {
      const { externalState } = setup({ branch: BRANCH });
      await act(async () => undefined);
      expect(strip()?.classList.contains("state-open")).toBe(true);
      externalState("merged");
      await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
      expect(strip()?.classList.contains("state-merged")).toBe(true);
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

  it.each([
    [{ state: "open", checks: { passed: 1, failed: 1, pending: 0, total: 2 } }, "state-open", "Open", "failed"],
    [{ state: "open", checks: { passed: 1, failed: 0, pending: 1, total: 2 } }, "state-open", "Open", "pending"],
    [{ state: "open", draft: true }, "state-draft", "Draft", undefined],
    [{ state: "merged" }, "state-merged", "Merged", undefined],
    [{ state: "closed" }, "state-closed", "Closed", undefined],
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
    setup({ links: [link(7, { linkedAt: 1, state: "merged" }), link(9, { linkedAt: 2, headRef: "feat/nine" })] });
    const more = await waitFor(() => {
      const found = document.querySelector(".review-pr-strip-more");
      if (!found) throw new Error("no +N yet");
      return found;
    });
    expect(strip()!.querySelector(".review-pr-strip-number")!.textContent).toBe("#9");
    expect(more.textContent).toBe("+1");
    expect(more.getAttribute("data-tooltip")).toBe("#7 Change 7 · merged");
    expect(screen.getByRole("button", { name: /^Open pull request #9 .*1 more linked/u })).toBeTruthy();
  });

  it("follows a link's state change, and × hides it until the state changes again", async () => {
    const { relink } = setup({ links: [link(9)] });
    const hide = await screen.findByRole("button", { name: "Hide PR #9 for this thread" });
    fireEvent.click(hide);
    expect(strip()).toBeNull();
    relink([link(9, { state: "merged" })]);
    await waitFor(() => expect(strip()?.classList.contains("state-merged")).toBe(true));
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
