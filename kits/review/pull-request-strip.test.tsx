// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientStorage, HostSnapshot, PreferencesStore, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { reviewExtension } from "./desktop.js";
import type { ReviewRequest, ThreadPullRequestLink } from "./protocol.js";
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

function setup({ branch, links = [], draftPending = false, empty = false }: { branch?: ReviewRequest; links?: ThreadPullRequestLink[]; draftPending?: boolean; empty?: boolean } = {}) {
  let changed: ((threadId: string) => void) | undefined;
  let current = links;
  const client = { links: vi.fn(async () => current), onLinksChanged: (listener: (threadId: string) => void) => { changed = listener; return () => undefined; } };
  const load = vi.fn(async () => branch);
  const parts = { rows: new RowRequests(load), links: new ThreadLinkRows(client), preferences: preferences(), dismissals: new StripDismissals(memoryStorage) };
  const actions = { activeThread: () => ({ sessionId: "t1", cwd: "/work", draftPending }), openStageTab: vi.fn(() => "tab") } as unknown as WorkbenchActions;
  const snapshot = { sessionId: "t1", cwd: "/work", projectLabel: "fix/refresh-apps-without-socket", isStreaming: false, messages: empty ? [] : [{ id: "m1" }] } as unknown as HostSnapshot;
  const view = render(<PullRequestStrip snapshot={snapshot} actions={actions} parts={parts} />);
  const relink = (next: ThreadPullRequestLink[]) => { current = next; act(() => changed?.("t1")); };
  return { view, parts, actions, load, relink };
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
  it("draws the branch's open request with its checks, repository and branch, and opens its tab", async () => {
    const { actions, load } = setup({ branch: BRANCH });
    const open = await screen.findByRole("button", { name: /^Open pull request #224 in acme\/lakebed on GitHub, open, checks 3\/3 passed/u });
    expect(load).toHaveBeenCalledWith("/work");
    expect(strip()!.className).toBe("review-pr-strip state-open");
    expect(open.textContent).toBe("#224lakebedfix/refresh-apps-without-socket");
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
    expect(empty.view.container.innerHTML).toBe("");
    cleanup();
    const draft = setup({ branch: BRANCH, draftPending: true });
    await waitFor(() => expect(draft.load).toHaveBeenCalled());
    expect(draft.view.container.innerHTML).toBe("");
    cleanup();
    const fresh = setup({ branch: BRANCH, empty: true });
    await waitFor(() => expect(fresh.load).toHaveBeenCalled());
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
});
