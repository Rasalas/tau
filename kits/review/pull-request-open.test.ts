// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVIEWS_PAGE } from "./local-reviews.js";
import { PULL_REQUEST_TAB, THREAD_PULL_REQUESTS_TAB } from "./protocol.js";
import { openPullRequest, openPullRequests, openThreadPullRequests } from "./pull-request-open.js";
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
