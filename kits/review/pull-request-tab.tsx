import { lazy, Suspense, useSyncExternalStore } from "react";
import { GitPullRequest, GitPullRequestArrow } from "lucide-react";
import { Spinner, type DesktopExtensionContext, type HostExtensionClient } from "tau";
import { createLinkDialogLayer, type LinkDialogs } from "./link-dialog.js";
import { linkPullRequestMenu } from "./link-menu.js";
import { PULL_REQUEST_TAB, PULL_REQUESTS_TAB, WORKSPACE_HOST_EXTENSION_ID, type ComposerContextChips } from "./protocol.js";
import { ReviewDetailStore } from "./review-detail-store.js";
import { needsYou, REVIEWS_PAGE } from "./local-reviews.js";
import { useLocalReviews, type LocalReviewsStore } from "./local-reviews-store.js";
import { ReviewsFilter } from "./reviews-filter.js";
import { openPullRequest, openPullRequests } from "./pull-request-open.js";
import type { PullRequestClient } from "./pull-request-client.js";
import type { PullRequestsTabParams } from "./pull-request-list-view.js";
import { pullRequestTabParams, shortNoun, type PullRequestTabParams } from "./pull-request-logic.js";
import { PullRequestView, type PullRequestViewShared } from "./pull-request-view.js";
import type { RequestClient, RowRequests } from "./requests.js";

// The list and the page are opened on demand; their code stays out of the kit's first evaluation.
const PullRequestListView = lazy(() => import("./pull-request-list-view.js"));
const ReviewsPage = lazy(() => import("./reviews-page.js"));
const ReviewsSidebar = lazy(() => import("./reviews-page.js").then((module) => ({ default: module.ReviewsSidebar })));

export { openPullRequest, openPullRequests } from "./pull-request-open.js";

/**
 * The pull-request view and a project's list as stage-tab kinds of a thread,
 * the Reviews page (local merge requests, and every project's remote ones
 * under Remote), the link dialog, and the commands that open them.
 */
export function registerPullRequestTab(
  plugin: DesktopExtensionContext,
  requests: RequestClient,
  rows: RowRequests,
  chips: () => ComposerContextChips | undefined,
  client: PullRequestClient,
  shared: PullRequestViewShared & { dialogs: LinkDialogs },
  reviews: { store: LocalReviewsStore; host: HostExtensionClient },
): () => void {
  const sidebar = new ReviewDetailStore();
  const pageParts = {
    store: reviews.store, host: reviews.host, rows, remote: { client, chips, rows, shared, sidebar }, filter: new ReviewsFilter(),
    detail: { store: sidebar, notes: shared.pending, workspace: plugin.hostExtension(WORKSPACE_HOST_EXTENSION_ID) },
  };
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
            open={(entry, workspace, focus) => openPullRequest(actions, { url: entry.ref.url, number: entry.ref.number, provider: entry.ref.service }, workspace, focus)}
          />
        </Suspense>
      ),
      // Every project's list is the page now; a tab kept from before names none.
      restore: (params) => params.scope !== "all",
    }),
    plugin.registerPage({
      id: REVIEWS_PAGE,
      label: "Reviews",
      // A phone's bottom navigation has it too, as a screen of its own.
      profiles: ["desktop", "compact"],
      Icon: GitPullRequest,
      order: 10,
      // The sidebar's foot leads with "Reviews N", as the design draws it.
      prominent: true,
      layout: "fill",
      keywords: ["merge requests", "pull requests", "local merge", "worktree branches", "rebase"],
      // What waits for the user: branches ready to merge or in conflict, and open remote requests of the rail's threads.
      useBadge: () => {
        const { counts } = useLocalReviews(reviews.store);
        const remote = useSyncExternalStore(rows.subscribe, rows.openCount);
        return needsYou(counts) + remote || undefined;
      },
      Component: (props) => (
        <Suspense fallback={<div className="stage-empty" role="status"><Spinner size="sm" label="Loading reviews" /></div>}>
          <ReviewsPage {...props} parts={pageParts} />
        </Suspense>
      ),
      // The states, projects and Remote in the thread list's place; the page keeps the table.
      Sidebar: (props) => <Suspense fallback={null}><ReviewsSidebar {...props} parts={pageParts} /></Suspense>,
    }),
    plugin.registerCommand({
      id: "review.reviews.open",
      label: "Reviews",
      group: "Project",
      access: "read",
      run: (actions) => actions.openPage?.(REVIEWS_PAGE),
    }),
    // The design's chord (2g); Rename moved to F2 for it.
    plugin.registerKeybinding({ keys: "mod+shift+r", commandId: "review.reviews.open" }),
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
        if (actions.openPage) actions.openPage(REVIEWS_PAGE, { tab: "remote" });
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
