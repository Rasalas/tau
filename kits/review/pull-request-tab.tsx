import { lazy, Suspense, useSyncExternalStore } from "react";
import { GitPullRequest, GitPullRequestArrow } from "lucide-react";
import { Spinner, type DesktopExtensionContext } from "tau";
import { createLinkDialogLayer, type LinkDialogs } from "./link-dialog.js";
import { linkPullRequestMenu } from "./link-menu.js";
import { PULL_REQUEST_TAB, PULL_REQUESTS_PAGE, PULL_REQUESTS_TAB, type ComposerContextChips } from "./protocol.js";
import { openPullRequest, openPullRequests } from "./pull-request-open.js";
import type { PullRequestClient } from "./pull-request-client.js";
import type { PullRequestsTabParams } from "./pull-request-list-view.js";
import { pullRequestTabParams, shortNoun, type PullRequestTabParams } from "./pull-request-logic.js";
import { PullRequestView, type PullRequestViewShared } from "./pull-request-view.js";
import type { RequestClient, RowRequests } from "./requests.js";

// The list and the page are opened on demand; their code stays out of the kit's first evaluation.
const PullRequestListView = lazy(() => import("./pull-request-list-view.js"));
const PullRequestsPage = lazy(() => import("./pull-requests-page.js").then((module) => ({ default: module.PullRequestsPage })));

export { openPullRequest, openPullRequests } from "./pull-request-open.js";

/**
 * The pull-request view and a project's list as stage-tab kinds of a thread,
 * the Pull Requests page across projects, the link dialog, and the commands
 * that open them.
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
            params={typeof params.workspace === "string" ? { workspace: params.workspace } : {}}
            handle={handle}
            actions={actions}
            client={client}
            open={(entry, workspace) => openPullRequest(actions, { url: entry.ref.url, number: entry.ref.number, provider: entry.ref.service }, workspace)}
          />
        </Suspense>
      ),
      // Every project's list is the page now; a tab kept from before names none.
      restore: (params) => params.scope !== "all",
    }),
    plugin.registerPage({
      id: PULL_REQUESTS_PAGE,
      label: "Pull requests",
      description: "Every project's pull and merge requests, with their checks and reviews. Open one to read, review or merge it.",
      // A phone's bottom navigation has it too, as a screen of its own.
      profiles: ["desktop", "compact"],
      Icon: GitPullRequest,
      order: 10,
      layout: "fill",
      keywords: ["merge requests", "reviews"],
      // The count on its entry: open requests of the threads the rail knows.
      useBadge: () => useSyncExternalStore(rows.subscribe, rows.openCount) || undefined,
      Component: (props) => (
        <Suspense fallback={<div className="stage-empty" role="status"><Spinner size="sm" label="Loading pull requests" /></div>}>
          <PullRequestsPage {...props} parts={{ client, chips, rows, shared }} />
        </Suspense>
      ),
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
      run: (actions) => {
        if (actions.openPage) actions.openPage(PULL_REQUESTS_PAGE);
        else openPullRequests(actions, "all");
      },
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
