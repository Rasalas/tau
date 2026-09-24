import { lazy, Suspense } from "react";
import { GitPullRequest, GitPullRequestArrow } from "lucide-react";
import { Spinner, type DesktopExtensionContext } from "tau";
import { createLinkDialogLayer, type LinkDialogs } from "./link-dialog.js";
import { linkPullRequestMenu } from "./link-menu.js";
import { PULL_REQUEST_TAB, PULL_REQUESTS_TAB, type ComposerContextChips } from "./protocol.js";
import { openPullRequest, openPullRequests } from "./pull-request-open.js";
import type { PullRequestClient } from "./pull-request-client.js";
import type { PullRequestsTabParams } from "./pull-request-list-view.js";
import { pullRequestTabParams, shortNoun, type PullRequestTabParams } from "./pull-request-logic.js";
import { PullRequestView, type PullRequestViewShared } from "./pull-request-view.js";
import type { RequestClient, RowRequests } from "./requests.js";

// The page is opened on demand; its code stays out of the kit's first evaluation.
const PullRequestListView = lazy(() => import("./pull-request-list-view.js"));

export { openPullRequest, openPullRequests } from "./pull-request-open.js";

/**
 * The pull-request view and the Pull Requests page as stage-tab kinds, the
 * link dialog, and the commands that open them for the thread on screen.
 */
export function registerPullRequestTab(
  plugin: DesktopExtensionContext,
  requests: RequestClient,
  rows: RowRequests,
  chips: () => ComposerContextChips | undefined,
  client: PullRequestClient,
  shared: PullRequestViewShared & { dialogs: LinkDialogs },
): () => void {
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
        return <PullRequestView params={parsed} handle={handle} actions={actions} client={client} chips={chips} rows={rows} shared={shared} />;
      },
      restore: (params) => pullRequestTabParams(params) !== undefined,
    }),
    plugin.registerStageTab<PullRequestsTabParams>({
      kind: PULL_REQUESTS_TAB,
      profiles: ["desktop"],
      title: () => "Pull requests",
      Icon: GitPullRequestArrow,
      render: (params, handle, actions) => (
        <Suspense fallback={<div className="stage-empty" role="status"><Spinner size="sm" label="Loading pull requests" /></div>}>
          <PullRequestListView
            params={params.scope === "all" ? { scope: "all" } : typeof params.workspace === "string" ? { workspace: params.workspace } : {}}
            handle={handle}
            actions={actions}
            client={client}
            open={(entry, workspace) => openPullRequest(actions, { url: entry.ref.url, number: entry.ref.number, provider: entry.ref.service }, workspace)}
          />
        </Suspense>
      ),
      restore: () => true,
    }),
    plugin.registerCommand({
      id: "review.pull-request.open",
      label: "Open the thread's pull request",
      group: "Project",
      access: "read",
      run: async (actions) => {
        const cwd = actions.activeThread()?.cwd;
        if (!cwd) { actions.notify("Open a thread in a project first."); return; }
        const request = await requests.request(cwd);
        if (!request) { actions.notify("This thread's branch has no pull or merge request."); return; }
        rows.set(cwd, request);
        openPullRequest(actions, request, cwd);
      },
    }),
    plugin.registerCommand({
      id: "review.pull-requests.open",
      label: "Pull requests",
      group: "Project",
      access: "read",
      run: (actions) => {
        const thread = actions.activeThread();
        openPullRequests(actions, thread?.workspaceId ?? thread?.cwd);
      },
    }),
    plugin.registerCommand({
      id: "review.pull-requests.all",
      label: "Pull requests in all projects",
      group: "Project",
      access: "read",
      run: (actions) => { openPullRequests(actions, "all"); },
    }),
    plugin.registerCommand({
      id: "review.pull-request.link",
      label: "Link pull request…",
      group: "Project",
      access: "write",
      // The palette picks from the open requests; a chord opens the dialog.
      submenu: linkPullRequestMenu(client, shared.links),
      run: (actions) => {
        const thread = actions.activeThread();
        if (!thread?.sessionId) { actions.notify("Open a thread first; a pull request is linked to a thread."); return; }
        shared.dialogs.show({ threadId: thread.sessionId, ...(thread.cwd ? { cwd: thread.cwd } : {}) });
      },
    }),
    plugin.registerRegion({ id: "review.link-dialog", placement: "title-bar", profiles: ["desktop"], Component: createLinkDialogLayer(shared.dialogs, client, shared.links) }),
  ];
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
