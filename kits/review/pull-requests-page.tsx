import { Suspense, lazy, useMemo, useState } from "react";
import { Spinner, type PageProps } from "tau";
import type { ComposerContextChips } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { pullRequestTabParams } from "./pull-request-logic.js";
import { PullRequestView, type PullRequestViewShared } from "./pull-request-view.js";
import type { LinkDialogs } from "./link-dialog.js";
import type { RowRequests } from "./requests.js";

const PullRequestListView = lazy(() => import("./pull-request-list-view.js"));

/** The page has no tab to title; its bar names the request from the row. */
const NO_TAB = { setTitle: () => undefined };

export interface PullRequestsPageParts {
  client: PullRequestClient;
  chips: () => ComposerContextChips | undefined;
  rows: RowRequests;
  shared: PullRequestViewShared & { dialogs: LinkDialogs };
}

/**
 * The app's Pull Requests page: every project's requests, and a row's request
 * in the view its tab shows, as a view of the page. The list stays mounted
 * underneath, so Back finds its filters and scroll as they were.
 */
export function PullRequestsPage({ params, navigate, actions, parts }: PageProps & { parts: PullRequestsPageParts }) {
  const detail = useMemo(() => pullRequestTabParams(params), [params]);
  // What the page itself opened on: one project (`workspace`), or all of them.
  const [start] = useState(() => (!detail && typeof params.workspace === "string" ? { workspace: params.workspace } : { scope: "all" as const }));
  return (
    <div className="pr-page">
      <div className="pr-page-pane" hidden={Boolean(detail)}>
        <Suspense fallback={<div className="stage-empty" role="status"><Spinner size="sm" label="Loading pull requests" /></div>}>
          <PullRequestListView
            surface="page"
            params={start}
            actions={actions}
            client={parts.client}
            open={(entry, workspace) => navigate(
              { url: entry.ref.url, number: entry.ref.number, service: entry.ref.service, ...(workspace ? { workspace } : {}) },
              { label: `#${entry.ref.number} ${entry.title}` },
            )}
          />
        </Suspense>
      </div>
      {detail ? (
        <div className="pr-page-pane">
          <PullRequestView key={detail.url} params={detail} handle={NO_TAB} actions={actions} client={parts.client} chips={parts.chips} rows={parts.rows} shared={parts.shared} />
        </div>
      ) : null}
    </div>
  );
}
