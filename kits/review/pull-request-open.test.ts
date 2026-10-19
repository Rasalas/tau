// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVIEWS_PAGE } from "./local-reviews.js";
import { PULL_REQUEST_TAB, THREAD_PULL_REQUESTS_TAB } from "./protocol.js";
import { openPullRequest, openPullRequestInTau, openPullRequests, openThreadPullRequests, opensInBrowser, requestClicks } from "./pull-request-open.js";
import { trackPullRequestTarget } from "./pull-request-target.js";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { REVIEW_HOST_EXTENSION_ID } from "./protocol.js";
import { pullRequestTabParams } from "./pull-request-logic.js";
import type { WorkbenchActions } from "tau";

const REQUEST = { url: "https://github.com/acme/tau/pull/87", number: 87, provider: "github" as const };

afterEach(() => { delete document.body.dataset.profile; });

describe("opening a pull request", () => {
  it("opens the desktop's tab for the request", () => {
    const actions = { openStageTab: vi.fn(() => "tab"), openPage: vi.fn() };
    openPullRequest(actions, REQUEST, "/work");
    expect(actions.openStageTab).toHaveBeenCalledWith(PULL_REQUEST_TAB, { url: REQUEST.url, number: 87, service: "github", workspace: "/work" }, { key: REQUEST.url });
    expect(actions.openPage).not.toHaveBeenCalled();
  });

  it("opens the desktop's tab at its guide", () => {
    const actions = { openStageTab: vi.fn(() => "tab") };
    openPullRequest(actions, REQUEST, undefined, "guide");
    expect(actions.openStageTab).toHaveBeenCalledWith(PULL_REQUEST_TAB, expect.objectContaining({ url: REQUEST.url, focus: "guide", at: expect.any(Number) }), { key: REQUEST.url });
  });

  it("keeps the overview origin and scroll position when the detail tab is restored", () => {
    const actions = { openStageTab: vi.fn<WorkbenchActions["openStageTab"]>(() => "tab") };
    const fromThread = { threadId: "source-thread", workspace: "/source", scrollTop: 240 };
    openPullRequest(actions, REQUEST, "/source", undefined, fromThread);
    const params = actions.openStageTab.mock.calls[0]![1]!;
    expect(pullRequestTabParams(params)).toMatchObject({ url: REQUEST.url, fromThread });
    openThreadPullRequests(actions, fromThread.threadId, fromThread.workspace, undefined, fromThread.scrollTop);
    expect(actions.openStageTab).toHaveBeenLastCalledWith(THREAD_PULL_REQUESTS_TAB, fromThread, { key: "thread-pull-requests:source-thread" });
  });

  it("keeps a thread's overview in its own tab, and uses Reviews on compact clients", () => {
    const actions = { openStageTab: vi.fn(() => "tab"), openPage: vi.fn() };
    openThreadPullRequests(actions, "t1", "/work");
    expect(actions.openStageTab).toHaveBeenCalledWith(THREAD_PULL_REQUESTS_TAB, { threadId: "t1", workspace: "/work" }, { key: "thread-pull-requests:t1" });
    document.body.dataset.profile = "compact";
    openThreadPullRequests(actions, "t1", "/work");
    expect(actions.openPage).toHaveBeenCalledWith(REVIEWS_PAGE, { tab: "remote", threadId: "t1", workspace: "/work" });
  });

  it("opens the request on the Reviews page where the client draws no pull-request tab", () => {
    document.body.dataset.profile = "compact";
    const actions = { openStageTab: vi.fn(() => "tab"), openPage: vi.fn() };
    openPullRequest(actions, REQUEST, "/work", "checks");
    expect(actions.openPage).toHaveBeenCalledWith(REVIEWS_PAGE, { tab: "remote", url: REQUEST.url, number: 87, service: "github", workspace: "/work", focus: "checks" });
    openPullRequests(actions, "/work");
    expect(actions.openPage).toHaveBeenLastCalledWith(REVIEWS_PAGE, { tab: "remote" });
    expect(actions.openStageTab).not.toHaveBeenCalled();
  });
});

describe("opening pull requests in the browser", () => {
  const tracked = (target?: string) => {
    const { preferences } = createKitHarness();
    if (target) preferences.setValue(REVIEW_HOST_EXTENSION_ID, "pull-request-target", target);
    return { preferences, stop: trackPullRequestTarget(preferences) };
  };

  it("opens the request's own page instead of Tau's view, on a phone too", () => {
    const { stop } = tracked("browser");
    const actions = { openStageTab: vi.fn(() => "tab"), openPage: vi.fn(), openExternal: vi.fn() };
    openPullRequest(actions, REQUEST, "/work", "checks");
    document.body.dataset.profile = "compact";
    openPullRequest(actions, REQUEST, "/work");
    expect(actions.openExternal.mock.calls).toEqual([[REQUEST.url], [REQUEST.url]]);
    expect(actions.openStageTab).not.toHaveBeenCalled();
    expect(actions.openPage).not.toHaveBeenCalled();
    stop();
  });

  it("opens a middle click or a ⌘ or Ctrl click in the browser whatever the setting, a guide included", () => {
    const { stop } = tracked();
    const actions = { openStageTab: vi.fn(() => "tab"), openExternal: vi.fn() };
    for (const click of [{ button: 1 }, { button: 0, metaKey: true }, { button: 0, ctrlKey: true }]) openPullRequest(actions, REQUEST, "/work", "guide", undefined, click);
    expect(actions.openExternal).toHaveBeenCalledTimes(3);
    openPullRequest(actions, REQUEST, "/work", undefined, undefined, { button: 0 });
    expect(actions.openStageTab).toHaveBeenCalledTimes(1);
    expect([{ button: 0 }, undefined].map(opensInBrowser)).toEqual([false, false]);
    stop();
  });

  it("gives a button handlers that browse on a middle click only", () => {
    const browse = vi.fn();
    const open = vi.fn();
    const { onClick, onAuxClick } = requestClicks(browse, open);
    onClick({ button: 0 } as never);
    onAuxClick({ button: 2, preventDefault: vi.fn() } as never);
    expect([browse.mock.calls.length, open.mock.calls.length]).toEqual([0, 1]);
    onAuxClick({ button: 1, preventDefault: vi.fn() } as never);
    expect(browse).toHaveBeenCalledTimes(1);
  });

  it("keeps Tau's view for a guide and for the explicit Open in Tau", () => {
    const { stop } = tracked("browser");
    const actions = { openStageTab: vi.fn(() => "tab"), openExternal: vi.fn() };
    openPullRequest(actions, REQUEST, undefined, "guide");
    openPullRequestInTau(actions, REQUEST, "/work");
    expect(actions.openStageTab).toHaveBeenCalledTimes(2);
    expect(actions.openExternal).not.toHaveBeenCalled();
    stop();
  });

  it("follows the setting while the kit is active, and returns to Tau when it stops", () => {
    const { preferences, stop } = tracked();
    const actions = { openStageTab: vi.fn(() => "tab"), openExternal: vi.fn() };
    openPullRequest(actions, REQUEST);
    expect(actions.openStageTab).toHaveBeenCalledTimes(1);
    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "pull-request-target", "browser");
    openPullRequest(actions, REQUEST);
    expect(actions.openExternal).toHaveBeenCalledTimes(1);
    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "pull-request-target", "somewhere");
    openPullRequest(actions, REQUEST);
    expect(actions.openStageTab).toHaveBeenCalledTimes(2);
    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "pull-request-target", "browser");
    stop();
    openPullRequest(actions, REQUEST);
    expect(actions.openStageTab).toHaveBeenCalledTimes(3);
  });
});
