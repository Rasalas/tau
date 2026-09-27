import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check, Copy, ExternalLink, GitBranch, Link2, Link2Off, MessageSquare, MessageSquarePlus, Pencil, RefreshCw, SquarePlus } from "lucide-react";
import { errorMessage, READ_ONLY_REASON, tooltipProps, type PreferencesStore, type StageTabHandle, type WorkbenchActions } from "tau";
import type { PendingReviewStore } from "./pending-review.js";
import { providerInfo, REVIEW_HOST_EXTENSION_ID, type ComposerContextChips, type PullRequestCheck, type PullRequestComment, type PullRequestDetail, type PullRequestFile, type PullRequestFiles, type PullRequestReviewEvent, type PullRequestThread } from "./protocol.js";
import type { PullRequestClient, PullRequestCommentInput } from "./pull-request-client.js";
import { LinkedThreadsControl, ThreadPicker, useLinkedThreads } from "./linked-threads.js";
import { PullRequestCode } from "./pull-request-code.js";
import { PullRequestHeaderActions, type HeaderMenuStep } from "./pull-request-header-actions.js";
import { useCompactProfile } from "./compact-profile.js";
import { PullRequestStackControl } from "./pull-request-stack.js";
import { asReviewRequest, checksRollup, checksSummary, hostName, relativeTime, shortNoun, timelineCounts, type PullRequestTabParams } from "./pull-request-logic.js";
import { handOver, RollupIcon } from "./pull-request-parts.js";
import { PullRequestSummary } from "./pull-request-summary.js";
import { ReviewComposer } from "./pull-request-review.js";
import { PullRequestTimeline } from "./pull-request-timeline.js";
import { usePullRequestWrites } from "./pull-request-writes.js";
import type { RowRequests } from "./requests.js";
import type { ThreadLinkRows } from "./thread-links-store.js";

/** The Review Kit option the local review reads too: one whitespace choice for every diff. */
export const WHITESPACE_OPTION_ID = "diff-ignore-whitespace";

/** What the view shares with the rest of the kit: the thread's links, held review comments and the options. */
export interface PullRequestViewShared {
  links: ThreadLinkRows;
  pending: PendingReviewStore;
  preferences: PreferencesStore;
}

/** The detail and checks are read again this often while the tab is on screen and the window visible. */
const POLL_MS = 60_000;
/** Checks that are still running are asked about more often. */
const CHECKS_POLL_MS = 20_000;
/** Coming back to the window reads again, but not more often than this. */
const FOCUS_MIN_MS = 10_000;

type Tab = "summary" | "timeline" | "code";

export interface PullRequestViewData {
  detail?: PullRequestDetail;
  detailError?: string;
  checks?: PullRequestCheck[];
  threads?: PullRequestThread[];
  threadsError?: string;
  files?: PullRequestFiles;
  filesError?: string;
}

/**
 * Reads one request and keeps it current while its tab is mounted: the
 * detail and checks on a timer and on window focus, the conversations and
 * the diff again whenever the detail says the request moved.
 */
function usePullRequest(client: PullRequestClient, url: string) {
  const [data, setData] = useState<PullRequestViewData>({});
  const alive = useRef(true);
  const updatedAt = useRef<string | undefined>(undefined);
  const filesWanted = useRef(false);
  const lastRead = useRef(0);
  const patch = useCallback((next: Partial<PullRequestViewData>) => { if (alive.current) setData((current) => ({ ...current, ...next })); }, []);

  const loadThreads = useCallback(async (fresh: boolean) => {
    try { patch({ threads: await client.threads(url, fresh), threadsError: undefined }); } catch (error) { patch({ threadsError: errorMessage(error) }); }
  }, [client, patch, url]);

  const loadFiles = useCallback(async (fresh: boolean) => {
    filesWanted.current = true;
    try { patch({ files: await client.files(url, fresh), filesError: undefined }); } catch (error) { patch({ filesError: errorMessage(error) }); }
  }, [client, patch, url]);

  const loadChecks = useCallback(async () => {
    try { patch({ checks: await client.checks(url) }); } catch { /* the detail's own checks stay */ }
  }, [client, patch, url]);

  const loadDetail = useCallback(async (fresh: boolean) => {
    try {
      const detail = await client.view(url, fresh);
      const moved = updatedAt.current !== undefined && detail.updatedAt !== updatedAt.current;
      updatedAt.current = detail.updatedAt;
      patch({ detail, detailError: undefined });
      if (moved) {
        void loadThreads(true);
        if (filesWanted.current) void loadFiles(true);
      }
    } catch (error) {
      patch({ detailError: errorMessage(error) });
    }
  }, [client, loadFiles, loadThreads, patch, url]);

  const refresh = useCallback((fresh: boolean) => {
    lastRead.current = Date.now();
    void loadDetail(fresh);
    void loadChecks();
    void loadThreads(fresh);
    if (filesWanted.current) void loadFiles(fresh);
  }, [loadChecks, loadDetail, loadFiles, loadThreads]);

  useEffect(() => {
    alive.current = true;
    refresh(false);
    const poll = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      lastRead.current = Date.now();
      void loadDetail(true);
      void loadChecks();
    }, POLL_MS);
    const onFocus = () => { if (Date.now() - lastRead.current > FOCUS_MIN_MS) refresh(true); };
    window.addEventListener("focus", onFocus);
    return () => { alive.current = false; window.clearInterval(poll); window.removeEventListener("focus", onFocus); };
  }, [loadChecks, loadDetail, refresh]);

  const checks = data.checks ?? data.detail?.checks ?? [];
  const running = checks.some((check) => check.status === "pending");
  useEffect(() => {
    if (!running) return;
    const poll = window.setInterval(() => { if (document.visibilityState === "visible") void loadChecks(); }, CHECKS_POLL_MS);
    return () => window.clearInterval(poll);
  }, [loadChecks, running]);

  const markViewed = useCallback((path: string, viewed: PullRequestFile["viewed"]) => {
    if (!alive.current) return;
    setData((current) => current.files
      ? { ...current, files: { ...current.files, files: current.files.files.map((file) => file.path === path ? { ...file, viewed } : file) } }
      : current);
  }, []);

  return { data, setData: patch, refresh, loadThreads, loadFiles, loadDetail, loadChecks, markViewed };
}

function useCopied(): [string | undefined, (key: string) => void] {
  const [copied, setCopied] = useState<string>();
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(undefined), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return [copied, setCopied];
}

export function PullRequestView({ params, handle, actions, client, chips, rows, shared }: {
  params: PullRequestTabParams;
  handle: Pick<StageTabHandle, "setTitle">;
  actions: WorkbenchActions;
  client: PullRequestClient;
  chips(): ComposerContextChips | undefined;
  rows: RowRequests;
  shared: PullRequestViewShared;
}) {
  const { data, setData, refresh, loadThreads, loadFiles, loadDetail, loadChecks, markViewed } = usePullRequest(client, params.url);
  const writes = usePullRequestWrites();
  const pending = useSyncExternalStore(shared.pending.subscribe, () => shared.pending.comments(params.url));
  useSyncExternalStore(shared.preferences.subscribe, shared.preferences.getSnapshot, shared.preferences.getSnapshot);
  const ignoreWhitespace = shared.preferences.optionValue(REVIEW_HOST_EXTENSION_ID, WHITESPACE_OPTION_ID, false) === true;
  const thread = actions.activeThread();
  const threadId = thread?.sessionId;
  const links = useSyncExternalStore(shared.links.subscribe, () => shared.links.get(threadId));
  useEffect(() => { if (threadId) shared.links.ensure(threadId); }, [shared.links, threadId]);
  const linked = links.some((link) => link.url === params.url);
  const candidates = useMemo(() => {
    let read: ReturnType<PullRequestClient["candidates"]> | undefined;
    return () => (read ??= client.candidates(params.url).catch((error: unknown) => { read = undefined; throw error; }));
  }, [client, params.url]);
  const [tab, setTab] = useState<Tab>("summary");
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set(["summary"]));
  const [oldestFirst, setOldestFirst] = useState(false);
  const [condensed, setCondensed] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [composing, setComposing] = useState(false);
  const [focusPath, setFocusPath] = useState<string>();
  const [copied, setCopied] = useCopied();
  const [picking, setPicking] = useState(false);
  const linkedThreads = useLinkedThreads(client, params.url);
  const phone = useCompactProfile();
  const noun = shortNoun(params.service);
  const host = hostName(params.service);
  const { capabilities } = providerInfo(params.service);
  const tabs = capabilities.files ? (["summary", "timeline", "code"] as const) : (["summary", "timeline"] as const);
  const { detail } = data;
  const checks = data.checks ?? detail?.checks ?? [];
  const threads = data.threads ?? [];

  useEffect(() => {
    if (!detail) return;
    const title = `${noun} #${detail.ref.number} ${detail.title}`;
    handle.setTitle(title.length > 48 ? `${title.slice(0, 47)}…` : title);
    if (params.workspace) rows.set(params.workspace, asReviewRequest(detail, checks));
  }, [checks, detail, handle, noun, params.workspace, rows]);

  const open = (next: Tab) => {
    setTab(next);
    setVisited((current) => current.has(next) ? current : new Set([...current, next]));
    setCondensed(false);
  };

  const comment = useCallback(async (input: PullRequestCommentInput) => {
    await client.comment(params.url, input);
    void loadThreads(true);
    void loadDetail(true);
  }, [client, loadDetail, loadThreads, params.url]);

  const update = useCallback(async (input: { title?: string; body?: string }) => {
    setData({ detail: await client.update(params.url, input) });
  }, [client, params.url, setData]);

  const canEdit = useCallback((target: PullRequestComment) => writes.editComment && capabilities.editComments.includes(target.kind) && Boolean(data.detail?.viewer) && target.author.login.toLowerCase() === data.detail!.viewer!.toLowerCase(), [capabilities, data.detail, writes.editComment]);
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

  const toggleLink = async () => {
    if (!threadId) return;
    try {
      if (linked) await client.unlink(threadId, params.url);
      else await client.link(threadId, params.url, thread?.cwd);
      await shared.links.load(threadId);
      actions.notify(linked ? `Unlinked #${params.number} from this thread.` : `Linked #${params.number} to this thread.`);
    } catch (error) {
      actions.notify(errorMessage(error));
    }
  };

  const copy = (key: string, value: string, done?: string) => {
    void actions.copyText(value).then(() => { setCopied(key); if (done) actions.notify(done); }, (error: unknown) => actions.notify(errorMessage(error)));
  };

  if (!detail) {
    return (
      <div className="pr-view" aria-label={`${noun} #${params.number}`}>
        {data.detailError ? (
          <div className="pr-unavailable" role="alert">
            <strong>Could not load the {providerInfo(params.service).noun}</strong>
            <p>{data.detailError}</p>
            <div className="pr-actions">
              <button className="mini-button" onClick={() => refresh(true)}>Retry</button>
              <button className="text-button" onClick={() => actions.openExternal(params.url)}>Open on {host}</button>
            </div>
          </div>
        ) : (
          <div className="pr-ghost" role="status" aria-label={`Loading ${noun} #${params.number}`}>
            <i /><i /><i /><i />
          </div>
        )}
      </div>
    );
  }

  const state = detail.state === "open" && detail.draft ? "draft" : detail.state;
  const rollup = checksRollup(checks);
  const counts = timelineCounts(detail, threads);
  const checkout = providerInfo(params.service).checkout?.(detail.ref.number);
  const addToComposer = () => handOver({ kind: "pull-request", payload: { number: detail.ref.number, title: detail.title, url: detail.ref.url, ...(detail.headRef ? { branch: detail.headRef } : {}) } }, chips(), actions);
  // A phone's header keeps the number, the state, the merge control and More; the rest moves into More.
  const phoneSteps: HeaderMenuStep[] = phone ? [
    { id: "view:refresh", label: "Refresh", icon: <RefreshCw size={13} />, run: () => refresh(true) },
    { id: "view:copy-link", label: "Copy link", icon: <Copy size={13} />, run: () => copy("link", detail.ref.url, "Copied the link.") },
    ...(detail.headRef ? [{ id: "view:copy-branch", label: "Copy branch name", icon: <GitBranch size={13} />, run: () => copy("branch", detail.headRef!, "Copied the branch name.") }] : []),
    ...(checkout ? [{ id: "view:copy-checkout", label: "Copy checkout command", icon: <Copy size={13} />, run: () => copy("checkout", checkout, "Copied the checkout command.") }] : []),
    { id: "view:composer", label: "Add to the composer", icon: <SquarePlus size={13} />, run: addToComposer },
    ...(threadId ? [{ id: "view:link", label: linked ? "Unlink from this thread" : "Link to this thread", icon: linked ? <Link2Off size={13} /> : <Link2 size={13} />, ...(!writes.link ? { disabled: true, description: READ_ONLY_REASON } : {}), run: () => void toggleLink() }] : []),
  ] : [];

  return (
    <div className="pr-view" aria-label={`${noun} #${detail.ref.number}`}>
      <header className={`pr-head ${condensed ? "condensed" : ""}`}>
        <div className="pr-head-row">
          <button className={`pr-number state-${state}`} title={`${state} · open on ${host}`} onClick={() => actions.openExternal(detail.ref.url)}>
            #{detail.ref.number}<ExternalLink size={10} aria-hidden="true" />
          </button>
          <span className={`pr-state state-${state}`}>{state}</span>
          {condensed ? <strong className="pr-head-title" title={detail.title}>{detail.title}</strong> : <span className="spacer" />}
          <PullRequestStackControl detail={detail} client={client} actions={actions} writes={writes} {...(params.workspace ? { workspace: params.workspace } : {})} onChanged={(next) => setData({ detail: next })} />
          <LinkedThreadsControl threadIds={linkedThreads} actions={actions} />
          {phone ? null : <>
            <button className="icon-button compact" aria-label={`Add ${noun} #${detail.ref.number} to the composer`} title="Add to the composer" onClick={addToComposer}>
              <SquarePlus size={13} />
            </button>
            {threadId ? (
              <button className={`icon-button compact ${linked ? "active" : ""}`} aria-label={linked ? "Unlink from this thread" : "Link to this thread"} aria-pressed={linked} disabled={!writes.link} {...tooltipProps(!writes.link ? READ_ONLY_REASON : linked ? "Linked to this thread · click to unlink" : "Link to this thread")} onClick={() => void toggleLink()}>
                {linked ? <Link2Off size={13} /> : <Link2 size={13} />}
              </button>
            ) : null}
            <button className="icon-button compact" aria-label="Copy link" title="Copy link" onClick={() => copy("link", detail.ref.url)}>
              {copied === "link" ? <Check size={13} /> : <Copy size={13} />}
            </button>
            <button className="icon-button compact" aria-label={`Refresh ${noun} #${detail.ref.number}`} title="Refresh" onClick={() => refresh(true)}>
              <RefreshCw size={13} />
            </button>
          </>}
          <PullRequestHeaderActions detail={detail} checks={checks} client={client} actions={actions} preferences={shared.preferences} threadId={threadId} writes={writes} extra={phoneSteps}
            onDetail={(next) => { setData({ detail: next }); void loadChecks(); }} onPickThread={() => setPicking(true)} />
        </div>
        {condensed ? null : (
          <div className="pr-fold">
            {editingTitle ? (
              <TitleEditor initial={detail.title} onSave={async (title) => { await update({ title }); setEditingTitle(false); }} onCancel={() => setEditingTitle(false)} />
            ) : (
              <div className="pr-title-row">
                <h1 className="pr-title">{detail.title}</h1>
                {capabilities.edit && writes.update ? <button className="icon-button compact pr-edit" aria-label="Edit title" title="Edit title" onClick={() => setEditingTitle(true)}><Pencil size={12} /></button> : null}
              </div>
            )}
            <div className="pr-meta">
              {detail.author ? <span><strong>{detail.author.name ?? detail.author.login}</strong> opened {relativeTime(detail.createdAt)}</span> : null}
              {detail.updatedAt ? <span>· updated {relativeTime(detail.updatedAt)}</span> : null}
              {checkout && !phone ? (
                <button className="pr-copyable" title="Copy the checkout command" onClick={() => copy("checkout", checkout)}>
                  {copied === "checkout" ? "Copied" : checkout}
                </button>
              ) : null}
            </div>
            <div className="pr-branches">
              <GitBranch size={12} aria-hidden="true" />
              <span className="pr-ref">{detail.baseRef}</span>
              <span aria-hidden="true">←</span>
              {detail.headRef && phone ? <span className="pr-ref">{detail.headRef}</span> : null}
              {detail.headRef && !phone ? <button className="pr-ref" title="Copy the branch name" onClick={() => copy("branch", detail.headRef!)}>{copied === "branch" ? "Copied" : detail.headRef}</button> : null}
              <span className="spacer" />
              {capabilities.files ? <span>{detail.changedFiles} {detail.changedFiles === 1 ? "file" : "files"}</span> : null}
              {detail.additions || detail.deletions ? <><span className="stat-add">+{detail.additions}</span><span className="stat-del">−{detail.deletions}</span></> : null}
            </div>
          </div>
        )}
      </header>

      <nav className="pr-tabs">
        <div className="toggle-group" role="tablist" aria-label={`${noun} sections`}>
          {tabs.map((entry) => (
            <button
              key={entry}
              role="tab"
              aria-selected={tab === entry}
              className={tab === entry ? "active" : ""}
              onMouseEnter={() => { if (entry === "code" && !data.files) void loadFiles(false); }}
              onClick={() => open(entry)}
            >{entry === "summary" ? "Summary" : entry === "timeline" ? "Timeline" : "Code"}</button>
          ))}
        </div>
        <span className="spacer" />
        {tab === "summary" ? (
          <span className="pr-tab-context" aria-label="Checks summary">
            {rollup ? <RollupIcon rollup={rollup} /> : null}
            {checksSummary(checks)}
          </span>
        ) : null}
        {tab === "timeline" ? (
          <span className="pr-tab-context">
            <span title="Comments"><MessageSquare size={11} aria-hidden="true" /> {data.threads || data.threadsError ? counts.comments : "…"}</span>
            <span title="Commits">{counts.commits} {counts.commits === 1 ? "commit" : "commits"}</span>
            <span title="Approvals"><Check size={11} aria-hidden="true" /> {counts.approvals}</span>
            <button className="text-button" onClick={() => setOldestFirst(!oldestFirst)}>{oldestFirst ? "Oldest first" : "Newest first"}</button>
          </span>
        ) : null}
      </nav>

      <div
        className="pr-body"
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          if (!condensed && top > 96) setCondensed(true);
          else if (condensed && top < 4) setCondensed(false);
        }}
      >
        {visited.has("summary") ? (
          <div hidden={tab !== "summary"}>
            <PullRequestSummary
              detail={detail}
              checks={checks}
              threads={threads}
              threadsError={data.threadsError}
              actions={actions}
              onSend={(chip) => handOver(chip, chips(), actions)}
              onSaveBody={capabilities.edit && writes.update ? (body) => update({ body }) : undefined}
              onRetry={() => void loadThreads(true)}
              onOpenPath={(path) => { setFocusPath(path); open("code"); }}
              canEdit={canEdit}
              onEdit={editComment}
              onReviewers={capabilities.reviewers && writes.reviewers ? async (change) => { setData({ detail: await client.reviewers(params.url, change) }); } : undefined}
              onLabels={capabilities.labels && writes.labels ? async (change) => { setData({ detail: await client.labels(params.url, change) }); } : undefined}
              showChecks={capabilities.checks}
              candidates={candidates}
            />
          </div>
        ) : null}
        {visited.has("timeline") ? (
          <div hidden={tab !== "timeline"}>
            <PullRequestTimeline detail={detail} oldestFirst={oldestFirst} actions={actions} />
          </div>
        ) : null}
        {visited.has("code") && capabilities.files ? (
          <div hidden={tab !== "code"} className="pr-code-frame">
            <PullRequestCode
              detail={detail}
              files={data.files}
              filesError={data.filesError}
              threads={threads}
              focusPath={focusPath}
              actions={actions}
              load={(fresh) => loadFiles(fresh)}
              onViewed={async (path, viewed) => markViewed(path, await client.viewed(params.url, path, viewed))}
              onComment={comment}
              onSend={(chip) => handOver(chip, chips(), actions)}
              ignoreWhitespace={ignoreWhitespace}
              onIgnoreWhitespace={(ignore) => shared.preferences.setOption(REVIEW_HOST_EXTENSION_ID, WHITESPACE_OPTION_ID, ignore)}
              reviewComments={pending}
              onPend={(held) => shared.pending.add(params.url, held)}
              onRemovePending={(id) => shared.pending.remove(params.url, id)}
              onResolve={resolve}
              canEdit={canEdit}
              onEdit={editComment}
              writes={writes}
            />
          </div>
        ) : null}
      </div>

      {picking ? (
        <ThreadPicker url={detail.ref.url} linkedThreads={linkedThreads ?? []} client={client} rows={shared.links} onClose={() => setPicking(false)} notify={(message) => actions.notify(message)} />
      ) : null}

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
      ) : phone ? (
        // A bar under the body instead of the button over it: on a phone that would cover the text it floats on.
        <footer className="pr-comment-bar">
          <button className="pr-comment-bar-button" disabled={!writes.comment && !writes.review} onClick={() => setComposing(true)}>
            <MessageSquarePlus size={18} aria-hidden="true" />
            <span>{pending.length > 0 ? `Review · ${pending.length} pending` : "Comment or review"}</span>
          </button>
          {!writes.comment && !writes.review ? <small className="pr-comment-bar-reason">{READ_ONLY_REASON}</small> : null}
        </footer>
      ) : (
        <button className="pr-comment-fab" aria-label={`Comment on or review ${noun} #${detail.ref.number}`} disabled={!writes.comment && !writes.review} {...tooltipProps(!writes.comment && !writes.review ? READ_ONLY_REASON : pending.length > 0 ? `Review · ${pending.length} pending` : "Comment or review")} onClick={() => setComposing(true)}>
          <MessageSquarePlus size={15} />
          {pending.length > 0 ? <span className="pr-fab-count">{pending.length}</span> : null}
        </button>
      )}
    </div>
  );
}

function TitleEditor({ initial, onSave, onCancel }: { initial: string; onSave(title: string): Promise<void>; onCancel(): void }) {
  const [title, setTitle] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    if (busy || !title.trim()) return;
    if (title.trim() === initial) { onCancel(); return; }
    setBusy(true);
    try { await onSave(title.trim()); } catch (reason) { setError(errorMessage(reason)); setBusy(false); }
  };
  return (
    <div className="pr-title-editor">
      <input
        autoFocus
        aria-label="Title"
        value={title}
        disabled={busy}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); void save(); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
        }}
      />
      <button className="text-button" disabled={busy} onClick={onCancel}>Cancel</button>
      <button className="mini-button" disabled={busy || !title.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
      {error ? <p className="pr-error" role="alert">The title could not be saved: {error}</p> : null}
    </div>
  );
}
