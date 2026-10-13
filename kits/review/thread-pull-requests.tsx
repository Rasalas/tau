import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CircleCheck, CircleDashed, CircleX, GitPullRequest, Layers, RefreshCw } from "lucide-react";
import { Empty, Spinner, tooltipProps, useThreadStore, type StageTabHandle, type WorkbenchActions } from "tau";
import type { PullRequestClient } from "./pull-request-client.js";
import { providerInfo, type PullRequestDetail, type ThreadPullRequestLink } from "./protocol.js";
import { parseRequestUrl } from "./pull-request-json.js";
import { openPullRequest } from "./pull-request-open.js";
import { checksRollup, checksSummary, relativeTime } from "./pull-request-logic.js";
import { RequestStateIcon } from "./request-state-icon.js";
import type { ThreadLinkRows } from "./thread-links-store.js";
import { threadRequestTree, type ThreadRequestNode, type ThreadPullRequestsParams } from "./thread-request-tree.js";

type Request = ThreadPullRequestLink & { detail?: PullRequestDetail };

const requestCount = (nodes: ThreadRequestNode<Request>[]): number => nodes.reduce((total, node) => total + 1 + requestCount(node.children), 0);

function RequestRows({ nodes, actions, workspace, onOpen, nested = false }: { nodes: ThreadRequestNode<Request>[]; actions: WorkbenchActions; workspace?: string; onOpen?: (request: ThreadPullRequestLink, focus?: "checks") => void; nested?: boolean }) {
  return <ul className="thread-pr-tree" aria-label="Pull requests">
    {nodes.map(({ request, children }) => {
      const { detail } = request;
      const info = providerInfo(request.service);
      const state = request.state === "merged" || request.state === "closed" ? request.state : request.draft ? "draft" : request.state;
      const branch = [request.headRef, request.baseRef].filter(Boolean).join(" → ");
      const checks = detail?.checks.length ? checksRollup(detail.checks) : undefined;
      const CheckIcon = checks === "passing" ? CircleCheck : checks === "failing" ? CircleX : CircleDashed;
      const stackSize = request.stack?.size ?? (!nested && children.length ? 1 + requestCount(children) : undefined);
      const stackLabel = request.stack ? `Stack #${request.stack.number}, ${stackSize} requests` : `${stackSize} requests in this branch stack`;
      const open = (focus?: "checks") => onOpen ? onOpen(request, focus) : openPullRequest(actions, { url: request.url, number: request.number, provider: request.service }, workspace, focus);
      return <li key={request.url}>
        <div className="thread-pr-row">
          <button type="button" className="pr-row" aria-label={`${info.short} ${info.sign}${request.number} ${request.title ?? request.repo}`} onClick={(event) => { if (event.metaKey || event.ctrlKey) actions.openExternal(request.url); else open(); }}>
            <span className="pr-row-glyphs">{state ? <RequestStateIcon state={state} size={16} /> : <GitPullRequest size={16} aria-label="State unavailable" />}</span>
            <span className="pr-row-lines">
              <span className="pr-row-line"><span className="pr-row-number">{info.sign}{request.number}</span><span className="pr-row-title" {...tooltipProps(request.title)}>{request.title ?? request.repo}</span></span>
              <span className="pr-row-line meta">
                {stackSize ? <span className="pr-row-stack" aria-label={stackLabel} {...tooltipProps(stackLabel)}><Layers size={10} aria-hidden="true" />{stackSize}</span> : null}
                {detail?.author ? <span className="pr-row-author">{detail.author.login}</span> : null}
                <span className="pr-row-repo" {...tooltipProps(`${info.name} · ${request.host}/${request.repo}`)}>{request.repo}</span>
                {branch ? <span className="pr-row-branch" {...tooltipProps(branch)}>{branch}</span> : null}
              </span>
            </span>
          </button>
          <span className="thread-pr-end">
            {detail?.updatedAt ? <time className="pr-row-time" dateTime={detail.updatedAt} {...tooltipProps(detail.updatedAt)}>{relativeTime(detail.updatedAt)}</time> : null}
            {checks ? <button type="button" className={`thread-pr-checks pr-row-checks ${checks}`} aria-label={`Checks for ${info.short} ${info.sign}${request.number}: ${checksSummary(detail!.checks)}`} {...tooltipProps(checksSummary(detail!.checks))} onClick={() => open("checks")}><CheckIcon size={12} aria-hidden="true" /></button> : null}
          </span>
        </div>
        {children.length ? <RequestRows nodes={children} actions={actions} workspace={workspace} onOpen={onOpen} nested /> : null}
      </li>;
    })}
  </ul>;
}

/** Only this thread's requests, immediately from its links, enriched through the existing cached detail reader. */
export default function ThreadPullRequests({ params, handle, actions, client, links, onOpen }: {
  params: ThreadPullRequestsParams;
  handle?: Pick<StageTabHandle, "setTitle">;
  actions: WorkbenchActions;
  client: PullRequestClient;
  links: ThreadLinkRows;
  onOpen?: (request: ThreadPullRequestLink, focus?: "checks") => void;
}) {
  const { threadId, workspace, branchUrl } = params;
  const body = useRef<HTMLDivElement>(null);
  const restored = useRef<string | undefined>(undefined);
  const store = useThreadStore();
  const title = useSyncExternalStore(store.subscribe, () => store.getSnapshot().threads.find((thread) => thread.id === threadId)?.title);
  const linked = useSyncExternalStore(links.subscribe, () => links.get(threadId));
  const requests = useMemo(() => {
    const ref = branchUrl ? parseRequestUrl(branchUrl) : undefined;
    return ref && !linked.some((link) => link.url === ref.url) ? [...linked, { ...ref, source: "discovered" as const, linkedAt: 0 }] : linked;
  }, [linked, branchUrl]);
  const [loaded, setLoaded] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [read, setRead] = useState<{ threadId: string; details: Map<string, PullRequestDetail>; failures: number }>();
  useLayoutEffect(() => {
    const key = JSON.stringify([threadId, params.scrollTop]);
    if (!body.current || !requests.length || restored.current === key) return;
    const wanted = params.scrollTop ?? 0;
    body.current.scrollTop = wanted;
    // Enrichment can grow the rows; do not finish while a still-short list clamps the position.
    if (Math.abs(body.current.scrollTop - wanted) < 1 || (read?.threadId === threadId && read.details.size + read.failures === requests.length)) restored.current = key;
  }, [threadId, params.scrollTop, requests.length, read]);
  useEffect(() => { handle?.setTitle("Pull requests"); }, [handle]);
  useEffect(() => {
    let live = true;
    const stop = links.watch(threadId);
    void links.load(threadId).then(() => { if (live) setLoaded(threadId); });
    return () => { live = false; stop(); };
  }, [links, threadId]);
  useEffect(() => {
    if (refreshing) return;
    let live = true;
    let next = 0;
    let failures = 0;
    const details = new Map<string, PullRequestDetail>();
    const work = async () => {
      while (next < requests.length) {
        if (!live) return;
        const request = requests[next++]!;
        try { details.set(request.url, await client.view(request.url)); } catch { failures += 1; }
        if (live) setRead({ threadId, details: new Map(details), failures });
      }
    };
    setRead({ threadId, details, failures: 0 });
    void Promise.all(Array.from({ length: Math.min(4, requests.length) }, work));
    return () => { live = false; };
  }, [client, requests, threadId, refreshing]);
  const details = read?.threadId === threadId ? read.details : undefined;
  const nodes = threadRequestTree(requests.map((request): Request => {
    const detail = details?.get(request.url);
    // A watch may have settled the link after this detail entered the reader's cache.
    const ended = request.state === "merged" || request.state === "closed";
    return detail ? { ...request, title: detail.title, state: ended ? request.state : detail.state, draft: detail.draft, headRef: detail.headRef, baseRef: detail.baseRef, detail } : request;
  }));
  const refresh = async () => {
    setRefreshing(true);
    try { await links.load(threadId, "force"); setLoaded(threadId); } finally { setRefreshing(false); }
  };
  const open = (request: ThreadPullRequestLink, focus?: "checks") => onOpen ? onOpen(request, focus) : openPullRequest(actions, { url: request.url, number: request.number, provider: request.service }, workspace, focus, { ...params, scrollTop: body.current?.scrollTop ?? 0 });
  return <div className="pr-list-view thread-pr-view" aria-label="Thread pull requests">
    <header className="pr-list-head">
      <div className="pr-list-title"><h1>Pull requests</h1><span className="pr-list-count">{requests.length}</span><span className="spacer" /><button type="button" className="icon-button" aria-label="Refresh thread pull requests" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" /></button></div>
      <p className="thread-pr-caption">{title ?? "This thread"}</p>
    </header>
    <div className="pr-list-body" ref={body}>
      {read?.threadId === threadId && read.failures > 0 ? <p className="thread-pr-note" role="status">Some request details could not be loaded. Showing saved links.</p> : null}
      {requests.length ? <RequestRows nodes={nodes} actions={actions} workspace={workspace} onOpen={open} /> : loaded !== threadId ? <Spinner size="sm" label="Loading thread pull requests" /> : <Empty icon={<GitPullRequest size={18} />} title={links.has(threadId) ? "No linked pull requests" : "Pull requests unavailable"} description={links.has(threadId) ? "Requests linked to this thread appear here." : "The thread's saved links could not be loaded. Try refreshing."} />}
    </div>
  </div>;
}
