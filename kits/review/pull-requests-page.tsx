import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { Spinner, type PageProps } from "tau";
import type { ComposerContextChips } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { pullRequestTabParams } from "./pull-request-logic.js";
import { PullRequestView, type PullRequestViewShared } from "./pull-request-view.js";
import type { LinkDialogs } from "./link-dialog.js";
import type { RowRequests } from "./requests.js";
import type { ReviewDetailStore } from "./review-detail-store.js";
import { useCompactProfile } from "./compact-profile.js";

const PullRequestListView = lazy(() => import("./pull-request-list-view.js"));
const RemoteReviewDetail = lazy(() => import("./remote-review-detail.js").then((module) => ({ default: module.RemoteReviewDetail })));

/** The page has no tab to title; its bar names the request from the row. */
const NO_TAB = { setTitle: () => undefined };

export interface PullRequestsPageParts {
  client: PullRequestClient;
  chips: () => ComposerContextChips | undefined;
  rows: RowRequests;
  shared: PullRequestViewShared & { dialogs: LinkDialogs };
  /** What the review view (1e) tells the page's sidebar. */
  sidebar: ReviewDetailStore;
}

/**
 * The app's Pull Requests page: every project's requests, and a row's request
 * in the view its tab shows, as a view of the page. The list stays mounted
 * underneath, so Back finds its filters and scroll as they were.
 */
export function PullRequestsPage({ params, navigate, actions, parts }: PageProps & { parts: PullRequestsPageParts }) {
  const detail = useMemo(() => pullRequestTabParams(params), [params]);
  const phone = useCompactProfile();
  // What the page itself opened on: one project (`workspace`), or all of them.
  const [start] = useState(() => (!detail && typeof params.workspace === "string" ? { workspace: params.workspace } : { scope: "all" as const }));
  // The row a request opened from; hiding the list drops its focus, so back from the request it gets it again.
  const pane = useRef<HTMLDivElement>(null);
  const opened = useRef<HTMLElement>(undefined);
  useEffect(() => {
    if (detail || !opened.current) return;
    if (opened.current.isConnected) opened.current.focus({ preventScroll: true });
    opened.current = undefined;
  }, [detail]);
  return (
    <div className="pr-page">
      <div className="pr-page-pane" ref={pane} hidden={Boolean(detail)}>
        <Suspense fallback={<div className="stage-empty" role="status"><Spinner size="sm" label="Loading pull requests" /></div>}>
          <PullRequestListView
            surface="page"
            params={start}
            actions={actions}
            client={parts.client}
            open={(entry, workspace, focus) => {
              const row = document.activeElement;
              if (row instanceof HTMLElement && pane.current?.contains(row)) opened.current = row;
              navigate(
                { url: entry.ref.url, number: entry.ref.number, service: entry.ref.service, ...(workspace ? { workspace } : {}), ...(focus ? { focus } : {}) },
                { label: `#${entry.ref.number} ${entry.title}` },
              );
            }}
          />
        </Suspense>
      </div>
      {detail ? (
        <div className="pr-page-pane">
          {phone ? (
            <PullRequestView key={detail.url} params={detail} handle={NO_TAB} actions={actions} client={parts.client} chips={parts.chips} rows={parts.rows} shared={parts.shared} />
          ) : (
            <Suspense fallback={<div className="stage-empty" role="status"><Spinner size="sm" label="Loading the pull request" /></div>}>
              <RemoteReviewDetail key={detail.url} params={detail} actions={actions} client={parts.client} chips={parts.chips} rows={parts.rows} shared={parts.shared} sidebar={parts.sidebar} back={() => navigate({}, { root: true, replace: true })} />
            </Suspense>
          )}
        </div>
      ) : null}
    </div>
  );
}
