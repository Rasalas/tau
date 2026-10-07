import { PullRequestWatchControl } from "./pr-watch-control.js";
import type { PullRequestWatchFeed } from "./pr-watch-client.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { useHostCapabilities, type RegionProps } from "tau";
import { openLocalPullRequest } from "./local-request-tab.js";
import { openPullRequest } from "./pull-request-open.js";
import { RequestStateIcon } from "./request-state-icon.js";
import { providerInfo, type WorkspaceStoreApi } from "./protocol.js";
import type { RowRequests } from "./requests.js";
import { stripRequests, type StripRequest } from "./pull-request-strip-logic.js";
import type { ThreadLinkRows } from "./thread-links-store.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { WorkspaceRequestChecks } from "./workspace-request-checks.js";
import { useRequestLifecycle } from "./request-lifecycle.js";

/** The checkout's request and its thread's links, owned by Review Kit inside the workspace card. */
export function createWorkspaceRequestSummary(store: WorkspaceStoreApi, rows: RowRequests, links: ThreadLinkRows, client?: PullRequestClient, watches?: PullRequestWatchFeed) {
  return function WorkspaceRequestSummary({ actions }: RegionProps) {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const { readOnly } = useHostCapabilities();
    const threadId = actions.activeThread()?.sessionId;
    const workspace = state.workspaceId ?? state.cwd;
    const branch = state.workspace?.branch;
    useRequestLifecycle(rows, links, branch ? workspace : undefined, threadId);
    const [expanded, setExpanded] = useState(false);
    const followed = useRef<{ workspace: string; branch: string } | undefined>(undefined);
    useEffect(() => {
      setExpanded(false);
      if (!workspace || !branch) return;
      const previous = followed.current;
      const cachedHead = rows.get(workspace)?.headRef;
      const moved = previous?.workspace === workspace && previous.branch !== branch;
      followed.current = { workspace, branch };
      rows.ensure(workspace, moved || Boolean(cachedHead && cachedHead !== branch));
    }, [workspace, branch]);
    useEffect(() => { if (threadId) links.ensure(threadId); }, [threadId]);
    const cached = useSyncExternalStore(rows.subscribe, () => workspace && branch ? rows.get(workspace) : undefined);
    const request = cached?.headRef && cached.headRef !== branch ? undefined : cached;
    const linked = useSyncExternalStore(links.subscribe, () => links.get(threadId));
    const found = stripRequests(request, linked);
    if (!workspace || !branch) return null;
    const open = (entry: StripRequest, focus?: "checks") => { openPullRequest(actions, { url: entry.url, number: entry.number, provider: entry.service }, workspace, focus); };
    const create = () => { openLocalPullRequest(actions); };
    const activeBranchRequest = request && request.state !== "merged" && request.state !== "closed";
    return <div className="workspace-request-summary" aria-label="Pull request">
      {found ? <>
        <div className={`workspace-card-row workspace-card-split workspace-request-heading state-${found.primary.state}`}>
          <button type="button" className="workspace-request-title workspace-card-split-main" onClick={() => open(found.primary)} title={found.primary.title}>
            <span className="workspace-card-icon"><RequestStateIcon state={found.primary.state} size={16} /></span>
            <span className="workspace-card-label">{providerInfo(found.primary.service).short} #{found.primary.number}{found.primary.title ? ` · ${found.primary.title}` : ""}</span>
          </button>
          {watches && threadId ? <PullRequestWatchControl feed={watches} threadId={threadId} request={found.primary} /> : null}
          <WorkspaceRequestChecks key={`${workspace}:${found.primary.url}`} request={found.primary} client={client} actions={actions} details={() => open(found.primary, "checks")} />
        </div>
        {found.others.length > 0 ? <>
          <button type="button" className="workspace-card-row workspace-request-more" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><Plus className="workspace-card-icon" size={16} /><span className="workspace-card-label">{expanded ? "Show less" : `Show ${found.others.length} more`}</span><span className="workspace-card-tail"><ChevronRight className="workspace-card-chevron" size={16} /></span></button>
          {expanded ? found.others.map((entry) => <button key={entry.url} type="button" className="workspace-card-row" onClick={() => open(entry)}><span className="workspace-card-icon"><RequestStateIcon state={entry.state} size={16} /></span><span className="workspace-card-label">{providerInfo(entry.service).short} #{entry.number}{entry.title ? ` · ${entry.title}` : ""}</span><span className="workspace-card-tail"><ChevronRight className="workspace-card-chevron" size={16} /></span></button>) : null}
        </> : null}
      </> : null}
      {!readOnly && !activeBranchRequest ? <button type="button" className="workspace-card-row workspace-request-create" onClick={create}><Plus className="workspace-card-icon" size={16} /><span className="workspace-card-label">Create PR…</span><span className="workspace-card-tail"><ChevronRight className="workspace-card-chevron" size={16} /></span></button> : null}
    </div>;
  };
}
