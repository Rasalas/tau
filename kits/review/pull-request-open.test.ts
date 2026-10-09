// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVIEWS_PAGE } from "./local-reviews.js";
import { PULL_REQUEST_TAB } from "./protocol.js";
import { openPullRequest, openPullRequests } from "./pull-request-open.js";

const REQUEST = { url: "https://github.com/acme/tau/pull/87", number: 87, provider: "github" as const };

afterEach(() => { delete document.body.dataset.profile; });

describe("opening a pull request", () => {
  it("opens the desktop's tab for the request", () => {
    const actions = { openStageTab: vi.fn(() => "tab"), openPage: vi.fn() };
    openPullRequest(actions, REQUEST, "/work");
    expect(actions.openStageTab).toHaveBeenCalledWith(PULL_REQUEST_TAB, { url: REQUEST.url, number: 87, service: "github", workspace: "/work" }, { key: REQUEST.url });
    expect(actions.openPage).not.toHaveBeenCalled();
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
