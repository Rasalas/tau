import type { MouseEvent } from "react";
import type { WorkbenchActions } from "tau";
import { REVIEWS_PAGE } from "./local-reviews.js";
import { PULL_REQUEST_TAB, PULL_REQUESTS_TAB, THREAD_PULL_REQUESTS_TAB, type ReviewRequest } from "./protocol.js";
import type { ThreadPullRequestsParams } from "./thread-request-tree.js";
import type { PullRequestTabParams } from "./pull-request-logic.js";
import { pullRequestTarget } from "./pull-request-target.js";

type OpenActions = Pick<WorkbenchActions, "openStageTab"> & Partial<Pick<WorkbenchActions, "openPage" | "openExternal">>;

/** The pull-request tabs are desktop-only; a phone or tablet reads requests on the Reviews page. */
function compactClient(): boolean {
  return typeof document !== "undefined" && document.body.dataset.profile === "compact";
}

/** A click that asks for the browser whatever the setting says: a middle click, or with ⌘ or Ctrl held. */
export interface RequestClick { button?: number; metaKey?: boolean; ctrlKey?: boolean }

export function opensInBrowser(click?: RequestClick): boolean {
  return click !== undefined && (click.button === 1 || click.metaKey === true || click.ctrlKey === true);
}

/**
 * Opens a request where the "Open pull requests in" setting says: Tau's view, or the request's own page in
 * the browser. A guide opens in Tau either way, only Tau having one; a `click` that asks for the browser wins over both.
 */
export function openPullRequest(actions: OpenActions, request: Pick<ReviewRequest, "url" | "number" | "provider">, workspace?: string, focus?: "checks" | "guide", fromThread?: ThreadPullRequestsParams, click?: RequestClick): string {
  if (actions.openExternal && (opensInBrowser(click) || (pullRequestTarget() === "browser" && focus !== "guide"))) {
    actions.openExternal(request.url);
    return request.url;
  }
  return openPullRequestInTau(actions, request, workspace, focus, fromThread);
}

/** `onClick` and `onAuxClick` for a request's button: a click that asks for the browser calls `browse`, any other `open`. */
export function requestClicks(browse: (click: RequestClick) => void, open: () => void) {
  return {
    onClick: (event?: MouseEvent) => { if (event && opensInBrowser(event)) browse(event); else open(); },
    onAuxClick: (event: MouseEvent) => { if (event.button !== 1) return; event.preventDefault(); browse(event); },
  };
}

/** Opens a request's view on the stage, at its checks or guide with `focus`; the same request is always the same tab. */
export function openPullRequestInTau(actions: OpenActions, request: Pick<ReviewRequest, "url" | "number" | "provider">, workspace?: string, focus?: "checks" | "guide", fromThread?: ThreadPullRequestsParams): string {
  if (compactClient() && actions.openPage) {
    actions.openPage(REVIEWS_PAGE, { tab: "remote", url: request.url, number: request.number, service: request.provider, ...(workspace ? { workspace } : {}), ...(focus ? { focus } : {}) });
    return request.url;
  }
  const params: PullRequestTabParams = { url: request.url, number: request.number, service: request.provider, ...(workspace ? { workspace } : {}), ...(focus ? { focus, at: Date.now() } : {}), ...(fromThread ? { fromThread } : {}) };
  return actions.openStageTab(PULL_REQUEST_TAB, params, { key: request.url });
}

/** Opens the Pull Requests page: one project's, or every project's with `"all"`; one tab per scope. */
export function openPullRequests(actions: OpenActions, workspace?: string | "all"): string {
  if (compactClient() && actions.openPage) {
    actions.openPage(REVIEWS_PAGE, { tab: "remote" });
    return REVIEWS_PAGE;
  }
  const params = workspace === "all" ? { scope: "all" } : workspace ? { workspace } : {};
  return actions.openStageTab(PULL_REQUESTS_TAB, params, { key: `pull-requests:${workspace ?? ""}` });
}

/** One overview per thread, independent of the repository's full request list. */
export function openThreadPullRequests(actions: OpenActions, threadId: string, workspace?: string, branchUrl?: string, scrollTop?: number): string {
  const params: ThreadPullRequestsParams = { threadId, ...(workspace ? { workspace } : {}), ...(branchUrl ? { branchUrl } : {}), ...(scrollTop !== undefined ? { scrollTop } : {}) };
  if (compactClient() && actions.openPage) {
    actions.openPage(REVIEWS_PAGE, { tab: "remote", ...params });
    return REVIEWS_PAGE;
  }
  return actions.openStageTab(THREAD_PULL_REQUESTS_TAB, params, { key: `thread-pull-requests:${threadId}` });
}
