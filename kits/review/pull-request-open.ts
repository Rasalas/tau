import type { WorkbenchActions } from "tau";
import { PULL_REQUEST_TAB, PULL_REQUESTS_TAB, type ReviewRequest } from "./protocol.js";
import type { PullRequestTabParams } from "./pull-request-logic.js";

/** Opens a request's view on the stage, at its checks with `focus`; the same request is always the same tab. */
export function openPullRequest(actions: Pick<WorkbenchActions, "openStageTab">, request: Pick<ReviewRequest, "url" | "number" | "provider">, workspace?: string, focus?: "checks"): string {
  const params: PullRequestTabParams = { url: request.url, number: request.number, service: request.provider, ...(workspace ? { workspace } : {}), ...(focus ? { focus, at: Date.now() } : {}) };
  return actions.openStageTab(PULL_REQUEST_TAB, params, { key: request.url });
}

/** Opens the Pull Requests page: one project's, or every project's with `"all"`; one tab per scope. */
export function openPullRequests(actions: Pick<WorkbenchActions, "openStageTab">, workspace?: string | "all"): string {
  const params = workspace === "all" ? { scope: "all" } : workspace ? { workspace } : {};
  return actions.openStageTab(PULL_REQUESTS_TAB, params, { key: `pull-requests:${workspace ?? ""}` });
}
