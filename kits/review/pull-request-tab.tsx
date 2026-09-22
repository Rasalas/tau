import { GitPullRequest } from "lucide-react";
import type { DesktopExtensionContext, UiReviewRequest, WorkbenchActions } from "tau";
import { PULL_REQUEST_TAB, type ComposerContextChips } from "./protocol.js";
import { pullRequestClient } from "./pull-request-client.js";
import { pullRequestTabParams, shortNoun, type PullRequestTabParams } from "./pull-request-logic.js";
import { PullRequestView } from "./pull-request-view.js";
import type { RequestClient, RowRequests } from "./requests.js";

/** Opens a request's view on the stage; the same request is always the same tab. */
export function openPullRequest(actions: Pick<WorkbenchActions, "openStageTab">, request: Pick<UiReviewRequest, "url" | "number" | "provider">, workspace?: string): string {
  const params: PullRequestTabParams = { url: request.url, number: request.number, service: request.provider, ...(workspace ? { workspace } : {}) };
  return actions.openStageTab(PULL_REQUEST_TAB, params, { key: request.url });
}

/**
 * The pull-request view as a stage-tab kind, and the command that opens the
 * request of the thread on screen.
 */
export function registerPullRequestTab(plugin: DesktopExtensionContext, requests: RequestClient, rows: RowRequests, chips: () => ComposerContextChips | undefined): () => void {
  const client = pullRequestClient(plugin.host);
  const disposers = [
    plugin.registerStageTab<PullRequestTabParams>({
      kind: PULL_REQUEST_TAB,
      // Claimed for the one client it was tried on.
      profiles: ["desktop"],
      title: (params) => `${shortNoun(params.service)} #${params.number}`,
      Icon: GitPullRequest,
      render: (params, handle, actions) => {
        const parsed = pullRequestTabParams(params);
        if (!parsed) return <div className="stage-empty" role="status">This tab names no pull request.</div>;
        return <PullRequestView params={parsed} handle={handle} actions={actions} client={client} chips={chips} rows={rows} />;
      },
      restore: (params) => pullRequestTabParams(params) !== undefined,
    }),
    plugin.registerCommand({
      id: "review.pull-request.open",
      label: "Open the thread's pull request",
      group: "Project",
      run: async (actions) => {
        const cwd = actions.activeThread()?.cwd;
        if (!cwd) { actions.notify("Open a thread in a project first."); return; }
        const request = await requests.request(cwd);
        if (!request) { actions.notify("This thread's branch has no pull or merge request."); return; }
        rows.set(cwd, request);
        openPullRequest(actions, request, cwd);
      },
    }),
  ];
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
