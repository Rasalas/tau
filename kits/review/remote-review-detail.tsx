import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Copy, ExternalLink, GitBranch, MessageSquare, RefreshCw, SquarePlus } from "lucide-react";
import { errorMessage, Markdown, READ_ONLY_REASON, tooltipProps, type WorkbenchActions } from "tau";
import { currentDiffWordWrap } from "./diff-settings.js";
import { githubHtml } from "./github-html.js";
import { LinkedThreadsControl, ThreadPicker, useLinkedThreads } from "./linked-threads.js";
import { providerInfo, REVIEW_HOST_EXTENSION_ID, type ComposerContextChips, type PullRequestComment, type PullRequestDetail, type PullRequestFile, type PullRequestReviewEvent, type PullRequestThread } from "./protocol.js";
import type { PullRequestClient, PullRequestCommentInput } from "./pull-request-client.js";
import { hideWhitespace } from "./pull-request-diff.js";
import { PullRequestHeaderActions, type HeaderMenuStep } from "./pull-request-header-actions.js";
import { usePullRequestLines } from "./pull-request-lines.js";
import { asReviewRequest, checksRollup, checksSummary, orderFiles, relativeTime, shortNoun, type PullRequestTabParams } from "./pull-request-logic.js";
import { handOver, RollupIcon } from "./pull-request-parts.js";
import { ChecksMini, ChecksPipeline } from "./pipeline-view.js";
import { ReviewComposer } from "./pull-request-review.js";
import { PullRequestStackControl } from "./pull-request-stack.js";
import { PullRequestTimeline } from "./pull-request-timeline.js";
import { usePullRequest, WHITESPACE_OPTION_ID, type PullRequestViewShared } from "./pull-request-view.js";
import { usePullRequestWrites } from "./pull-request-writes.js";
import { RequestStateIcon } from "./request-state-icon.js";
import type { RowRequests } from "./requests.js";
import { LayoutToggle, ReviewDetailFrame, useBackKeys, type FrameTab } from "./review-detail-frame.js";
import type { DetailNote, DetailState, ReviewDetailStore } from "./review-detail-store.js";
import { ReviewDiffStack, type StackFile } from "./review-diff-stack.js";
import { baseName } from "./review-lines.js";
import { plural } from "./review-words.js";

type Tab = "changes" | "timeline" | "checks";

interface RemoteProps {
  params: PullRequestTabParams;
  actions: WorkbenchActions;
  client: PullRequestClient;
  chips(): ComposerContextChips | undefined;
  rows: RowRequests;
  shared: PullRequestViewShared;
  /** The store the sidebar reads. */
  sidebar: ReviewDetailStore;
  back(): void;
}

/**
 * A pull or merge request in the review view of design 1e: the same frame a
 * local review has, with the request's own facts and actions, its files
 * under each other with their conversations on the lines, the timeline and
 * the checks. Line comments wait in the sidebar for the review.
 */
export function RemoteReviewDetail(props: RemoteProps) {
  const { params, actions, client } = props;
  const pr = usePullRequest(client, params.url);
  const { data, refresh } = pr;
  const noun = shortNoun(params.service);
  if (data.detail) return <RemoteBody {...props} pr={pr} detail={data.detail} />;
  return (
    <div className="rvd rvd-loading-page" aria-label={`${noun} #${params.number}`}>
      {data.detailError ? (
        <div className="pr-unavailable" role="alert">
          <strong>Could not load the {providerInfo(params.service).noun}</strong>
          <p>{data.detailError}</p>
          <div className="pr-actions">
            <button className="mini-button" onClick={() => refresh(true)}>Retry</button>
            <button className="text-button" onClick={() => actions.openExternal(params.url)}>Open on {providerInfo(params.service).name}</button>
          </div>
        </div>
      ) : <div className="pr-ghost" role="status" aria-label={`Loading ${noun} #${params.number}`}><i /><i /><i /><i /></div>}
    </div>
  );
}

function RemoteBody({ params, actions, client, chips, rows, shared, sidebar: side, back, pr, detail }: RemoteProps & { pr: ReturnType<typeof usePullRequest>; detail: PullRequestDetail }) {
  const { data, setData, refresh, loadThreads, loadFiles, loadDetail, loadChecks, markViewed } = pr;
  const writes = usePullRequestWrites();
  const pending = useSyncExternalStore(shared.pending.subscribe, () => shared.pending.comments(params.url));
  useSyncExternalStore(shared.preferences.subscribe, shared.preferences.getSnapshot, shared.preferences.getSnapshot);
  const ignoreWhitespace = shared.preferences.optionValue(REVIEW_HOST_EXTENSION_ID, WHITESPACE_OPTION_ID, false) === true;
  const thread = actions.activeThread();
  const threadId = thread?.sessionId;
  const [tab, setTab] = useState<Tab>(params.focus ?? "changes");
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [oldestFirst, setOldestFirst] = useState(false);
  const [composing, setComposing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [active, setActive] = useState<string>();
  const [jump, setJump] = useState<{ path: string; at: number }>();
  const jumps = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const linkedThreads = useLinkedThreads(client, params.url);
  const { capabilities } = providerInfo(params.service);
  const noun = shortNoun(params.service);
  const checks = data.checks ?? detail?.checks ?? [];
  const threads = data.threads ?? [];
  useBackKeys(back);

  useEffect(() => { if (capabilities.files && !data.files && !data.filesError) void loadFiles(false); }, [capabilities.files, data.files, data.filesError, loadFiles]);
  useEffect(() => {
    if (detail && params.workspace) rows.set(params.workspace, asReviewRequest(detail, checks));
  }, [checks, detail, params.workspace, rows]);

  const comment = useCallback(async (input: PullRequestCommentInput) => {
    await client.comment(params.url, input);
    void loadThreads(true);
    void loadDetail(true);
  }, [client, loadDetail, loadThreads, params.url]);
  const canEdit = useCallback((target: PullRequestComment) => writes.editComment && capabilities.editComments.includes(target.kind) && Boolean(detail?.viewer) && target.author.login.toLowerCase() === detail!.viewer!.toLowerCase(), [capabilities, detail, writes.editComment]);
  const editComment = useCallback(async (target: PullRequestComment, body: string) => {
    await client.editComment(params.url, target, body);
    void loadThreads(true);
    void loadDetail(true);
  }, [client, loadDetail, loadThreads, params.url]);
  const resolve = useCallback(async (target: PullRequestThread, resolved: boolean) => {
    setData({ threads: await client.resolve(params.url, target.id, resolved) });
  }, [client, params.url, setData]);
  const review = useCallback(async (event: PullRequestReviewEvent, body: string) => {
    const next = await client.review(params.url, { event, body, comments: shared.pending.comments(params.url) });
    shared.pending.clear(params.url);
    setData({ detail: next });
    void loadThreads(true);
  }, [client, loadThreads, params.url, setData, shared.pending]);

  const ordered = useMemo(() => orderFiles(data.files?.files ?? []), [data.files]);
  const diffs = useMemo(() => ignoreWhitespace ? (data.files?.diffs ?? []).map(hideWhitespace) : data.files?.diffs ?? [], [data.files, ignoreWhitespace]);
  const diffByPath = useMemo(() => new Map(diffs.map((diff) => [diff.path, diff])), [diffs]);
  const stackFiles = useMemo<StackFile[]>(() => ordered.map((file) => ({ path: file.path, added: file.added, removed: file.removed, ...(file.previousPath ? { previousPath: file.previousPath } : {}) })), [ordered]);
  const lines = usePullRequestLines({
    detail, threads, diffs, reviewComments: pending, writes, onComment: comment,
    onSend: (chip) => handOver(chip, chips(), actions),
    onPend: (held) => shared.pending.add(params.url, held),
    onRemovePending: (id) => shared.pending.remove(params.url, id),
    onResolve: resolve, canEdit, onEdit: editComment,
  });

  // A complete file list is what the sidebar shows, so the header and the tab count from it; the host's totals otherwise.
  const listed = data.files && ordered.length >= detail.changedFiles;
  const totals = useMemo(() => listed
    ? { files: ordered.length, added: ordered.reduce((sum, file) => sum + file.added, 0), removed: ordered.reduce((sum, file) => sum + file.removed, 0) }
    : { files: detail.changedFiles, added: detail.additions, removed: detail.deletions }, [detail, listed, ordered]);
  const notes = useMemo<DetailNote[]>(() => pending.map((entry) => ({ id: entry.id, label: `${baseName(entry.path)}:${entry.line}`, text: entry.body })), [pending]);
  const state = useMemo<DetailState>(() => ({
    key: params.url,
    kind: "remote",
    files: ordered.map((file) => ({ path: file.path, added: file.added, removed: file.removed })),
    moreFiles: data.files ? Math.max(0, totals.files - ordered.length) : 0,
    turnsHeading: "Commits",
    turns: detail.commits.map((commit) => commit.headline || "Untitled commit"),
    notes,
    sendLabel: "Submit review",
    ...(!writes.review && !writes.comment ? { sendDisabled: READ_ONLY_REASON } : {}),
    ...(active ? { active } : {}),
  }), [active, data.files, detail.commits, notes, ordered, params.url, totals.files, writes.comment, writes.review]);
  useEffect(() => {
    side.publish(state, {
      jump: (path) => { setTab("changes"); setJump({ path, at: ++jumps.current }); },
      sendAll: () => setComposing(true),
      removeNote: (id) => shared.pending.remove(params.url, id),
    });
  }, [params.url, shared.pending, side, state]);
  useEffect(() => () => side.retire(params.url), [params.url, side]);

  const toggleViewed = async (file: PullRequestFile) => {
    try { markViewed(file.path, await client.viewed(params.url, file.path, file.viewed !== "viewed")); } catch (error) { actions.notify(`Could not update viewed files: ${errorMessage(error)}`); }
  };

  const shownState = detail.state === "open" && detail.draft ? "draft" : detail.state;
  const rollup = checksRollup(checks);
  const checkout = providerInfo(params.service).checkout?.(detail.ref.number);
  const copy = (value: string, done: string) => {
    void actions.copyText(value).then(() => actions.notify(done), (error: unknown) => actions.notify(errorMessage(error)));
  };
  const menuSteps: HeaderMenuStep[] = [
    { id: "view:refresh", label: "Refresh", icon: <RefreshCw size={13} />, run: () => refresh(true) },
    { id: "view:host", label: `Open on ${providerInfo(params.service).name}`, icon: <ExternalLink size={13} />, run: () => actions.openExternal(detail.ref.url) },
    { id: "view:copy-link", label: "Copy link", icon: <Copy size={13} />, run: () => copy(detail.ref.url, "Copied the link.") },
    ...(detail.headRef ? [{ id: "view:copy-branch", label: "Copy branch name", icon: <GitBranch size={13} />, run: () => copy(detail.headRef!, "Copied the branch name.") }] : []),
    ...(checkout ? [{ id: "view:copy-checkout", label: "Copy checkout command", icon: <Copy size={13} />, run: () => copy(checkout, "Copied the checkout command.") }] : []),
    { id: "view:composer", label: "Add to the composer", icon: <SquarePlus size={13} />, run: () => handOver({ kind: "pull-request", payload: { number: detail.ref.number, title: detail.title, url: detail.ref.url, ...(detail.headRef ? { branch: detail.headRef } : {}) } }, chips(), actions) },
  ];
  const tabs: FrameTab<Tab>[] = [
    ...(capabilities.files ? [{ id: "changes" as const, label: "Changes", aside: String(totals.files) }] : []),
    { id: "timeline", label: "Timeline" },
    ...(capabilities.checks ? [{ id: "checks" as const, label: "Checks", aside: <>· {rollup ? <RollupIcon rollup={rollup} /> : null}{checksSummary(checks)}</> }] : []),
  ];
  const shownTab: Tab = tabs.some((entry) => entry.id === tab) ? tab : "timeline";

  const meta = (
    <>
      <button type="button" className="rvd-link" {...tooltipProps(`Open on ${providerInfo(params.service).name}`)} onClick={() => actions.openExternal(detail.ref.url)}>#{detail.ref.number}<ExternalLink size={10} aria-hidden="true" /></button>
      <RequestStateIcon state={shownState} />
      {detail.headRef ? <><span className="rvd-mono">{detail.headRef}</span><span aria-hidden="true">→</span></> : null}
      <span className="rvd-mono">{detail.baseRef}</span>
      {capabilities.files ? <><span aria-hidden="true">·</span><span>{plural(totals.files, "file")}</span></> : null}
      {totals.added || totals.removed ? <><span className="stat-add">+{totals.added}</span><span className="stat-del">−{totals.removed}</span></> : null}
      {detail.author ? <><span aria-hidden="true">·</span><span><strong>{detail.author.name ?? detail.author.login}</strong> opened {relativeTime(detail.createdAt)}</span></> : null}
    </>
  );

  const buttons = (
    <>
      <PullRequestStackControl detail={detail} client={client} actions={actions} writes={writes} {...(params.workspace ? { workspace: params.workspace } : {})} onChanged={(next) => setData({ detail: next })} />
      <LinkedThreadsControl threadIds={linkedThreads} actions={actions} />
      {detail.state === "open" && (writes.comment || writes.review) ? (
        <button type="button" className="rvd-ghost" onClick={() => setComposing(true)}><MessageSquare size={12} aria-hidden="true" /> Request changes</button>
      ) : null}
      <PullRequestHeaderActions detail={detail} checks={checks} client={client} actions={actions} preferences={shared.preferences} threadId={threadId} writes={writes} extra={menuSteps} intoBase
        onDetail={(next) => { setData({ detail: next }); void loadChecks(); }} onPickThread={() => setPicking(true)} />
    </>
  );

  const toolbar = shownTab === "changes" ? (
    <>
      <label className="rvd-whitespace" title="Show lines that changed only in whitespace as unchanged">
        <input type="checkbox" checked={ignoreWhitespace} onChange={(event) => shared.preferences.setOption(REVIEW_HOST_EXTENSION_ID, WHITESPACE_OPTION_ID, event.target.checked)} /> Hide whitespace
      </label>
      <LayoutToggle layout={layout} onChange={setLayout} />
    </>
  ) : shownTab === "timeline" ? (
    <button type="button" className="text-button" onClick={() => setOldestFirst(!oldestFirst)}>{oldestFirst ? "Oldest first" : "Newest first"}</button>
  ) : null;

  const files = data.files;
  return (
    <>
      <ReviewDetailFrame<Tab>
        label={`${noun} #${detail.ref.number}`}
        title={detail.title}
        beside={capabilities.checks ? <ChecksMini client={client} url={params.url} checks={checks} onOpen={() => setTab("checks")} /> : null}
        meta={meta}
        actions={buttons}
        summary={detail.body.trim() ? <div className="pr-comment-body"><Markdown html={githubHtml}>{detail.body}</Markdown></div> : <p className="rvd-muted">No description.</p>}
        tabs={tabs}
        tab={shownTab}
        onTab={setTab}
        toolbar={toolbar}
        scrollRef={scroll}
      >
        {shownTab === "changes" ? (
          data.filesError && !files ? (
            <div className="pr-unavailable" role="alert"><strong>Could not load the diff</strong><p>{data.filesError}</p><button className="mini-button" onClick={() => void loadFiles(true)}>Retry</button></div>
          ) : !files ? <p className="rvd-empty" role="status">Loading the diff…</p>
          : ordered.length === 0 ? <p className="rvd-empty">This {providerInfo(params.service).noun} has no file changes.</p>
          : (
            <ReviewDiffStack
              files={stackFiles}
              layout={layout}
              wrap={currentDiffWordWrap()}
              diffs={diffByPath}
              lines={lines.slotFor}
              extra={(file) => {
                const entry = ordered.find((candidate) => candidate.path === file.path);
                if (!entry) return null;
                return (
                  <label className={`rvd-viewed${entry.viewed === "dismissed" ? " dismissed" : ""}`} {...tooltipProps(!writes.viewed ? READ_ONLY_REASON : entry.viewed === "dismissed" ? "This file has been pushed to since you marked it viewed." : undefined)}>
                    <input type="checkbox" checked={entry.viewed === "viewed"} disabled={!writes.viewed} onChange={() => void toggleViewed(entry)} />
                    {entry.viewed === "dismissed" ? "Changed" : "Viewed"}
                  </label>
                );
              }}
              jump={jump}
              onActive={setActive}
              scroll={scroll}
            />
          )
        ) : shownTab === "timeline" ? (
          <PullRequestTimeline detail={detail} oldestFirst={oldestFirst} actions={actions} />
        ) : (
          <div className="rvd-pad"><ChecksPipeline client={client} url={params.url} checks={checks} actions={actions} /></div>
        )}
      </ReviewDetailFrame>
      {picking ? <ThreadPicker url={detail.ref.url} linkedThreads={linkedThreads ?? []} client={client} rows={shared.links} onClose={() => setPicking(false)} notify={(message) => actions.notify(message)} /> : null}
      {composing && (writes.comment || writes.review) ? (
        <ReviewComposer
          service={params.service}
          events={capabilities.reviewEvents}
          pending={pending}
          onRemovePending={(id) => shared.pending.remove(params.url, id)}
          onComment={async (text) => { await comment({ body: text }); setComposing(false); actions.notify(`Commented on ${noun} #${detail.ref.number}.`); }}
          onReview={async (event, text) => { await review(event, text); setComposing(false); actions.notify(`Review submitted on ${noun} #${detail.ref.number}.`); }}
          onCancel={() => setComposing(false)}
        />
      ) : null}
    </>
  );
}
