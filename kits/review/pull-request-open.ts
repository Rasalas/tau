import type { WorkbenchActions } from "tau";
import { REVIEWS_PAGE } from "./local-reviews.js";
import { PULL_REQUEST_TAB, PULL_REQUESTS_TAB, THREAD_PULL_REQUESTS_TAB, type ReviewRequest } from "./protocol.js";
import type { ThreadPullRequestsParams } from "./thread-request-tree.js";
import type { PullRequestTabParams } from "./pull-request-logic.js";

type OpenActions = Pick<WorkbenchActions, "openStageTab"> & Partial<Pick<WorkbenchActions, "openPage">>;

/** The pull-request tabs are desktop-only; a phone or tablet reads requests on the Reviews page. */
function compactClient(): boolean {
  return typeof document !== "undefined" && document.body.dataset.profile === "compact";
}

/** Opens a request's view on the stage, at its checks or guide with `focus`; the same request is always the same tab. */
export function openPullRequest(actions: OpenActions, request: Pick<ReviewRequest, "url" | "number" | "provider">, workspace?: string, focus?: "checks" | "guide", fromThread?: ThreadPullRequestsParams): string {
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
