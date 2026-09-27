import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ExternalLink, FileDiff, GitCommitHorizontal, GitPullRequestArrow, MessageSquarePlus,
  RotateCw, Send, Sparkles, Upload, X,
} from "lucide-react";
import {
  ConfirmDialog, DiffView, Empty, errorMessage, MiddleTruncate, Popover, Spinner, tooltipProps, useHostCapabilities,
  type CommitResult, type DiffLineSlot, type DiffLoadOptions, type HostExtensionClient, type PanelProps, type PushResult,
  type UiChangedFile, type UiFileDiff, type UiWorkspaceChanges, type UiWorkspaceChangesPage, type WorkbenchActions, type WorkspaceInfo,
} from "tau";
import { commentLocation, lineNumber, type ReviewCommentStore } from "./comments.js";
import { handOffComments } from "./comment-views.js";
import {
  BRANCH, commitQuestion, countLabel, defaultSource, pushQuestion, READ_ONLY_REASON, requestQuestion, selectionLabel, sourceKey, sourceLabel,
  tapLine, turnEntries, WORKTREE, type ReviewSource, type TurnEntry,
} from "./compact-model.js";
import type { CompactReviewStore } from "./compact-store.js";
import { providerInfo, REVIEW_COMPACT_PANEL, WORKSPACE_CHECKPOINT_EVENT, type ReviewRequestStatus, type ReviewTurn } from "./protocol.js";
import type { RequestClient } from "./requests.js";
import type { WorkspaceChangesReader } from "./workspace.js";

/**
 * Review on a phone or a tablet, as a sheet over the thread: the diff of a
 * recorded turn, of the uncommitted changes or of the branch, one file at a
 * time with wrapped unified lines. A tap on a line starts a comment that goes
 * into the composer; commit, push and a new pull request each ask first, and
 * a device paired Read only sees them disabled with the reason.
 */
export interface CompactReviewDeps {
  reader: WorkspaceChangesReader;
  /** Workspace Kit's host entry: checkpoints, turn diffs, the branch and the Git writes. */
  workspace: HostExtensionClient;
  requests: RequestClient;
  comments: ReviewCommentStore;
  store: CompactReviewStore;
}

const HUNK_LIMIT = 40;
/** A turn lists at most this many files on a phone; more is a turn to read at a desk. */
const MAX_TURN_FILES = 2000;

type Loaded<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; error: string };

/**
 * One host read for what `key` names; `generation` asks again. A refresh keeps
 * the last answer on screen while it asks, another key starts from loading.
 */
function useLoaded<T>(load: (() => Promise<T>) | undefined, key: string | undefined, generation: number): Loaded<T> {
  const [state, setState] = useState<{ key?: string; loaded: Loaded<T> }>({ loaded: { status: "loading" } });
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    const run = latest.current;
    if (!run) return undefined;
    let cancelled = false;
    setState((current) => current.key === key && current.loaded.status === "ready" ? current : { key, loaded: { status: "loading" } });
    run().then(
      (value) => { if (!cancelled) setState({ key, loaded: { status: "ready", value } }); },
      (error: unknown) => { if (!cancelled) setState({ key, loaded: { status: "error", error: errorMessage(error) } }); },
    );
    return () => { cancelled = true; };
  }, [key, generation]);
  return state.key === key ? state.loaded : { status: "loading" };
}

async function turnFiles(workspace: HostExtensionClient, turn: ReviewTurn): Promise<UiWorkspaceChanges> {
  const count = turn.fileCount ?? turn.files.length;
  if (count <= turn.files.length) return turn;
  const files: UiChangedFile[] = [];
  let cursor: string | undefined;
  do {
    const page = await workspace.invoke("turn-files", { sessionId: turn.sessionId, checkpointId: turn.id, cursor, limit: 500 }) as UiWorkspaceChangesPage;
    files.push(...page.files);
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor && files.length < MAX_TURN_FILES);
  return { ...turn, files };
}

function loadDiff(deps: CompactReviewDeps, source: ReviewSource, changes: UiWorkspaceChanges, sessionId: string | undefined, path: string, options: DiffLoadOptions): Promise<UiFileDiff> {
  if (source.kind === "turn") {
    return deps.workspace.invoke("turn-file-diff", { sessionId, checkpointId: source.id, relPath: path, options }) as Promise<UiFileDiff>;
  }
  return deps.reader.fileDiff(path, source.kind === "branch"
    ? { ...options, scope: "branch", ...(changes.baseRef ? { baseRef: changes.baseRef } : {}), ...(changes.baseCommit ? { baseCommit: changes.baseCommit } : {}) }
    : options);
}

function IconButton({ label, onClick, disabled, children, pressed, buttonRef }: {
  label: string; onClick(): void; disabled?: boolean; children: ReactNode; pressed?: boolean; buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return <button
    ref={buttonRef}
    type="button"
    className="review-touch-icon"
    aria-label={label}
    {...(pressed === undefined ? {} : { "aria-expanded": pressed })}
    {...tooltipProps(label)}
    disabled={disabled}
    onClick={onClick}
  >{children}</button>;
}

type Common = { actions: WorkbenchActions; readOnly: boolean; refresh(): void };

const STATUS_MARK: Record<UiChangedFile["status"], string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U" };

function Stat({ added, removed }: { added: number; removed: number }) {
  return <span className="review-compact-stat"><span className="stat-add">+{added}</span> <span className="stat-del">−{removed}</span></span>;
}

export function createCompactReview(deps: CompactReviewDeps) {
  const { store, comments } = deps;
  return function CompactReviewPanel({ actions }: PanelProps) {
    const sessionId = actions.activeThread()?.sessionId;
    useEffect(() => { store.follow(sessionId); }, [sessionId]);
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const commentState = useSyncExternalStore(comments.subscribe, comments.getSnapshot, comments.getSnapshot);
    const { readOnly } = useHostCapabilities();
    const [generation, setGeneration] = useState(0);
    const refresh = useCallback(() => setGeneration((value) => value + 1), []);

    // A turn that just recorded its changes is the one a phone came to read.
    useEffect(() => deps.workspace.onEvent(WORKSPACE_CHECKPOINT_EVENT, (payload) => {
      const event = payload as { type?: string; sessionId?: string } | undefined;
      if (event?.type === "turn-checkpoint" && event.sessionId === sessionId) refresh();
    }), [refresh, sessionId]);

    const turnsLoad = useLoaded(sessionId
      ? async () => turnEntries(((await deps.workspace.invoke("checkpoints", { sessionId })) as { checkpoints?: ReviewTurn[] } | undefined)?.checkpoints ?? [])
      : undefined, sessionId, generation);
    const turns = useMemo(() => turnsLoad.status === "ready" ? turnsLoad.value : [], [turnsLoad]);
    // Without a recorded turn (or when the list failed) the working tree is what there is.
    const source = state.source ?? (turnsLoad.status === "loading" ? undefined : defaultSource(turns));
    const key = source ? sourceKey(source) : undefined;
    const turn = source?.kind === "turn" ? turns.find((entry) => entry.turn.id === source.id)?.turn : undefined;
    // A turn picked before the sheet opened (the pill over the composer) waits for the list that holds it.
    const waiting = source?.kind === "turn" && turnsLoad.status === "loading";
    const changesLoad = useLoaded<UiWorkspaceChanges>(source && !waiting
      ? () => source.kind === "turn"
        ? turn ? turnFiles(deps.workspace, turn) : Promise.reject(new Error("This turn's changes are no longer recorded."))
        : deps.reader.changes(source.kind === "branch" ? { scope: "branch" } : undefined)
      : undefined, key && !waiting ? `${sessionId}:${key}` : undefined, generation);
    const infoLoad = useLoaded(() => deps.workspace.invoke("workspace-info") as Promise<WorkspaceInfo>, sessionId, generation);
    const info = infoLoad.status === "ready" ? infoLoad.value : undefined;

    const choose = (next: ReviewSource) => store.update({ source: next, page: "files", path: undefined });
    const changes = changesLoad.status === "ready" ? changesLoad.value : undefined;

    if (!sessionId) {
      return <section className="panel-body review-compact">
        <Empty icon={<FileDiff size={20} />} title="No thread open" description="Open a thread to read what it changed." />
      </section>;
    }
    const draft = commentState.draft;
    const common = { actions, readOnly, refresh };
    if (state.page === "comment" && draft) return <CommentPage deps={deps} draft={draft} actions={actions} />;
    if (state.page === "diff" && state.path && source && key && changes) {
      return <DiffPage deps={deps} source={source} sourceKey={key} changes={changes} path={state.path} sessionId={sessionId} readOnly={readOnly} draftSource={state.draftSource} />;
    }
    if (state.page === "commit" && changes && source?.kind === "worktree") return <CommitPage deps={deps} changes={changes} info={info} {...common} />;
    if (state.page === "request" && source?.kind === "branch") return <RequestPage deps={deps} info={info} {...common} />;
    return <FilesPage
      deps={deps}
      source={source}
      turns={turns}
      changes={changesLoad}
      info={info}
      onChoose={choose}
      draftPending={Boolean(draft?.body.trim())}
      {...common}
    />;
  };
}

function FilesPage({ deps, source, turns, changes, info, onChoose, draftPending, actions, readOnly, refresh }: {
  deps: CompactReviewDeps;
  source?: ReviewSource;
  turns: readonly TurnEntry[];
  changes: Loaded<UiWorkspaceChanges>;
  info?: WorkspaceInfo;
  onChoose(source: ReviewSource): void;
  draftPending: boolean;
} & Common) {
  const [picking, setPicking] = useState(false);
  const picker = useRef<HTMLButtonElement>(null);
  const label = source ? sourceLabel(source, turns) : "Loading…";
  const pick = (next: ReviewSource) => { setPicking(false); onChoose(next); };
  const loaded = changes.status === "ready" ? changes.value : undefined;
  const draft = deps.comments.getSnapshot().draft;
  return <section className="panel-body review-compact">
    <header className="review-compact-header">
      <button
        ref={picker}
        type="button"
        className="review-compact-source"
        aria-haspopup="dialog"
        aria-expanded={picking}
        aria-label={`Diff: ${label}. Choose another diff`}
        onClick={() => setPicking((open) => !open)}
      ><span>{label}</span><ChevronDown size={16} aria-hidden="true" /></button>
      <IconButton label="Refresh" onClick={refresh}><RotateCw size={18} /></IconButton>
    </header>
    {picking ? <SourcePicker anchor={picker} source={source} turns={turns} onPick={pick} onClose={() => setPicking(false)} /> : null}
    {readOnly ? <p className="review-compact-notice" role="note">{READ_ONLY_REASON}</p> : null}
    {draftPending && draft ? <p className="review-compact-notice pending">
      <span>An unsent comment on {commentLocation(draft)}.</span>
      <button type="button" className="review-compact-link" onClick={() => deps.store.update({ page: "comment" })}>Continue</button>
    </p> : null}
    {changes.status === "loading" || !source
      ? <div className="review-compact-loading"><Spinner label="Loading the changes" /></div>
      : changes.status === "error"
        ? <Empty icon={<FileDiff size={20} />} title="Could not load the changes" description={changes.error}>
          <button type="button" className="review-compact-button" onClick={refresh}><RotateCw size={16} aria-hidden="true" />Try again</button>
        </Empty>
        : <FileList deps={deps} source={source} changes={changes.value} info={info} onPick={() => setPicking(true)} />}
    {loaded && source ? <ActionBar deps={deps} source={source} changes={loaded} info={info} actions={actions} readOnly={readOnly} refresh={refresh} /> : null}
  </section>;
}

function SourcePicker({ anchor, source, turns, onPick, onClose }: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  source?: ReviewSource;
  turns: readonly TurnEntry[];
  onPick(source: ReviewSource): void;
  onClose(): void;
}) {
  const current = source ? sourceKey(source) : undefined;
  const row = (next: ReviewSource, title: string, detail?: string) => <button
    key={sourceKey(next)}
    type="button"
    role="menuitemradio"
    aria-checked={current === sourceKey(next)}
    className="review-compact-menu-item"
    onClick={() => onPick(next)}
  ><strong>{title}</strong>{detail ? <small>{detail}</small> : null}</button>;
  return <Popover anchor={anchor} side="bottom" align="start" label="Choose a diff" className="review-compact-menu" onClose={onClose}>
    <div role="menu" aria-label="Choose a diff">
      {row(WORKTREE, "Uncommitted changes", "What is not committed yet")}
      {row(BRANCH, "Branch changes", "The branch against its base")}
      <p className="review-compact-menu-heading">Turns</p>
      {turns.length === 0
        ? <p className="review-compact-menu-empty">No turn of this thread changed files yet.</p>
        : turns.map((entry, index) => row(
          { kind: "turn", id: entry.turn.id },
          index === 0 ? `Latest turn (turn ${entry.number})` : `Turn ${entry.number}`,
          `${countLabel(entry.fileCount, "file")} · ${new Date(entry.turn.endedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
        ))}
    </div>
  </Popover>;
}

function FileList({ deps, source, changes, info, onPick }: {
  deps: CompactReviewDeps;
  source: ReviewSource;
  changes: UiWorkspaceChanges;
  info?: WorkspaceInfo;
  onPick(): void;
}) {
  const total = changes.fileCount ?? changes.files.length;
  const where = source.kind === "branch"
    ? `${changes.branch ?? info?.branch ?? "This branch"} against ${changes.baseRef ?? "its base"}`
    : source.kind === "worktree" ? `On ${info?.branch ?? changes.branch ?? "a detached head"}` : "What the agent changed in this turn";
  if (changes.files.length === 0) {
    const title = source.kind === "worktree" ? "No uncommitted changes" : source.kind === "branch" ? "No changes on this branch" : "This turn changed no files";
    return <Empty icon={<FileDiff size={20} />} title={title} description={changes.incompleteReason ?? "Another diff may have what you are looking for."}>
      <button type="button" className="review-compact-button" onClick={onPick}>Choose another diff</button>
    </Empty>;
  }
  return <>
    <p className="review-compact-summary">
      <span>{countLabel(total, "file")}</span>
      <Stat added={changes.added} removed={changes.removed} />
      <span className="review-compact-where">{where}</span>
    </p>
    {changes.completeness === "partial" ? <p className="review-compact-notice" role="note">{changes.incompleteReason ?? "Some changes may be missing from this diff."}</p> : null}
    {total > changes.files.length ? <p className="review-compact-notice" role="note">Showing {changes.files.length} of {total} files. The rest are in the review on the desktop.</p> : null}
    <ul className="review-compact-files" aria-label="Changed files">
      {changes.files.map((file) => <li key={file.path}>
        <button type="button" className="review-compact-file" onClick={() => deps.store.update({ page: "diff", path: file.path })}>
          <span className={`review-compact-mark status-${file.status}`} aria-label={file.status}>{STATUS_MARK[file.status]}</span>
          <span className="review-compact-file-name">
            <strong>{file.name}</strong>
            {file.directory ? <MiddleTruncate className="review-compact-file-dir" value={file.directory} /> : null}
            {file.note ? <small>{file.note}</small> : null}
          </span>
          <Stat added={file.added} removed={file.removed} />
        </button>
      </li>)}
    </ul>
  </>;
}

/** The writes a source offers, each behind a question; disabled with the reason on a Read-only device. */
function ActionBar({ deps, source, changes, info, actions, readOnly, refresh }: {
  deps: CompactReviewDeps;
  source: ReviewSource;
  changes: UiWorkspaceChanges;
  info?: WorkspaceInfo;
} & Common) {
  // A turn is history, and a clean working tree has nothing to commit.
  if (source.kind === "turn" || (source.kind === "worktree" && changes.files.length === 0)) return null;
  const request = changes.request;
  const buttons: ReactNode[] = [];
  if (source.kind === "worktree") {
    buttons.push(<button key="commit" type="button" className="review-compact-button primary" disabled={readOnly || changes.files.length === 0} onClick={() => deps.store.update({ page: "commit" })}>
      <GitCommitHorizontal size={16} aria-hidden="true" />Commit…
    </button>);
  } else {
    if ((info?.ahead ?? 0) > 0 && info?.hasRemote !== false) buttons.push(<PushButton key="push" info={info} disabled={readOnly} deps={deps} actions={actions} refresh={refresh} />);
    if (request) {
      buttons.push(<a key="open" className="review-compact-button" href={request.url} target="_blank" rel="noreferrer">
        <ExternalLink size={16} aria-hidden="true" />{providerInfo(request.provider).short} #{request.number}
      </a>);
    } else {
      buttons.push(<button key="request" type="button" className="review-compact-button primary" disabled={readOnly || changes.files.length === 0} onClick={() => deps.store.update({ page: "request" })}>
        <GitPullRequestArrow size={16} aria-hidden="true" />Pull request…
      </button>);
    }
  }
  return <footer className="review-compact-actions">
    {readOnly ? <p className="review-compact-reason">Read only: writes need a device with Full access.</p> : null}
    <div>{buttons}</div>
  </footer>;
}

function PushButton({ deps, info, disabled, actions, refresh }: { deps: CompactReviewDeps; info?: WorkspaceInfo; disabled: boolean; actions: WorkbenchActions; refresh(): void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const question = pushQuestion(info);
  return <>
    <button type="button" className="review-compact-button" disabled={disabled || busy} onClick={() => setAsking(true)}>
      <Upload size={16} aria-hidden="true" />{busy ? "Pushing…" : "Push"}
    </button>
    {asking ? <ConfirmDialog
      title={question.title}
      message={question.message}
      confirmLabel={question.confirm}
      onCancel={() => setAsking(false)}
      onConfirm={() => {
        setAsking(false);
        setBusy(true);
        void (deps.workspace.invoke("push") as Promise<PushResult>)
          .then((result) => { actions.notify(result.detail); refresh(); }, (error: unknown) => actions.notify(errorMessage(error)))
          .finally(() => setBusy(false));
      }}
    /> : null}
  </>;
}

function PageHeader({ title, onBack, backLabel, children }: { title: ReactNode; onBack(): void; backLabel: string; children?: ReactNode }) {
  return <header className="review-compact-header">
    <IconButton label={backLabel} onClick={onBack}><ChevronLeft size={20} /></IconButton>
    <div className="review-compact-title">{title}</div>
    {children}
  </header>;
}

function DiffPage({ deps, source, sourceKey: key, changes, path, sessionId, readOnly, draftSource }: {
  deps: CompactReviewDeps;
  source: ReviewSource;
  sourceKey: string;
  changes: UiWorkspaceChanges;
  path: string;
  sessionId?: string;
  readOnly: boolean;
  draftSource?: string;
}) {
  const { store, comments } = deps;
  const commentState = useSyncExternalStore(comments.subscribe, comments.getSnapshot, comments.getSnapshot);
  const [diff, setDiff] = useState<UiFileDiff>();
  const [error, setError] = useState<string>();
  const [discarding, setDiscarding] = useState(false);
  const index = changes.files.findIndex((file) => file.path === path);
  const previous = changes.files[index - 1];
  const next = changes.files[index + 1];

  useEffect(() => {
    let cancelled = false;
    setDiff(undefined);
    setError(undefined);
    loadDiff(deps, source, changes, sessionId, path, { hunkLimit: HUNK_LIMIT }).then((loaded) => {
      if (cancelled) return;
      comments.recordDiff(path, loaded, false);
      setDiff(loaded);
    }, (problem: unknown) => { if (!cancelled) setError(errorMessage(problem)); });
    return () => { cancelled = true; };
  }, [changes, path, key, sessionId]);

  const loadMore = () => {
    if (!diff?.truncated || diff.nextHunkOffset === undefined) return;
    void loadDiff(deps, source, changes, sessionId, path, { hunkLimit: HUNK_LIMIT, hunkOffset: diff.nextHunkOffset }).then((page) => {
      comments.recordDiff(path, page, true);
      setDiff((current) => current ? { ...page, hunks: [...current.hunks, ...page.hunks] } : page);
    }, (problem: unknown) => setError(errorMessage(problem)));
  };

  const draft = commentState.draft;
  const ours = draft && draftSource === key && draft.path === path ? draft : undefined;
  const lines = useMemo<DiffLineSlot | undefined>(() => readOnly ? undefined : {
    onAction: ({ path: linePath, line }) => {
      // A comment begun in another diff keeps its words and moves here.
      if (comments.getSnapshot().draft && store.getSnapshot().draftSource !== key) comments.lineAction(linePath, line, false);
      else tapLine(comments, linePath, line);
      store.update({ draftSource: key });
    },
    actionLabel: ({ line }) => line.newLine !== undefined ? `Select line ${line.newLine}` : `Select removed line ${line.oldLine}`,
    selected: ({ path: linePath, line }) => {
      if (!ours || ours.path !== linePath) return false;
      const number = lineNumber(line, ours.side);
      return number !== undefined && number >= ours.startLine && number <= ours.endLine;
    },
  }, [key, ours, readOnly]);

  const go = (file: UiChangedFile | undefined) => { if (file) store.update({ path: file.path }); };
  const name = path.split("/").at(-1) ?? path;
  return <section className="panel-body review-compact review-compact-diff">
    <PageHeader backLabel="Back to the files" onBack={() => store.update({ page: "files" })} title={<>
      <strong>{name}</strong>
      <MiddleTruncate className="review-compact-file-dir" value={path} />
    </>}>
      <IconButton label="Previous file" disabled={!previous} onClick={() => go(previous)}><ArrowUp size={18} /></IconButton>
      <IconButton label="Next file" disabled={!next} onClick={() => go(next)}><ArrowDown size={18} /></IconButton>
    </PageHeader>
    {error
      ? <Empty icon={<FileDiff size={20} />} title="Could not load this diff" description={error} />
      : <div className="review-compact-diff-body">
        <DiffView diff={diff} mode="unified" path={path} wrap {...(lines ? { lines } : {})} {...(diff?.truncated ? { onLoadMore: loadMore } : {})} />
      </div>}
    {ours ? <div className="review-compact-selection" role="toolbar" aria-label="Selected lines">
      <button type="button" className="review-compact-button primary" onClick={() => store.update({ page: "comment" })}>
        <MessageSquarePlus size={16} aria-hidden="true" />{ours.body.trim() ? `Edit comment (${selectionLabel(ours).replace(/^Comment on /u, "")})` : selectionLabel(ours)}
      </button>
      <IconButton label="Clear the selection" onClick={() => { if (ours.body.trim()) setDiscarding(true); else comments.cancelDraft(); }}><X size={18} /></IconButton>
    </div> : readOnly ? null : <p className="review-compact-hint">Tap a line to comment on it; tap another to cover a range.</p>}
    {discarding ? <ConfirmDialog
      title="Discard the comment?"
      message="What you wrote about these lines is not sent anywhere yet."
      confirmLabel="Discard"
      destructive
      onCancel={() => setDiscarding(false)}
      onConfirm={() => { setDiscarding(false); comments.cancelDraft(); }}
    /> : null}
  </section>;
}

function CommentPage({ deps, draft, actions }: {
  deps: CompactReviewDeps;
  draft: NonNullable<ReturnType<ReviewCommentStore["getSnapshot"]>["draft"]>;
  actions: WorkbenchActions;
}) {
  const { store, comments } = deps;
  const back = () => store.update({ page: store.getSnapshot().path ? "diff" : "files" });
  const send = () => {
    const comment = comments.takeDraft();
    if (!comment) return;
    store.update({ page: "diff" });
    actions.closePanel?.(REVIEW_COMPACT_PANEL);
    // Text, not a chip: the compact composer has no chip strip to take one.
    handOffComments([comment], { actions, remove: () => undefined });
  };
  return <section className="panel-body review-compact review-compact-comment">
    <PageHeader backLabel="Back to the diff (the comment is kept)" onBack={back} title={<strong>{selectionLabel(draft)}</strong>} />
    <div className="review-compact-form">
      <small className="review-compact-location">{commentLocation(draft)}</small>
      {draft.code.length > 0 ? <pre className="review-compact-code" aria-label="The lines the comment is about">{draft.code.map((line, index) => <span
        key={index}
        className={line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : ""}
      >{line}{"\n"}</span>)}</pre> : null}
      <label className="review-compact-label" htmlFor="review-compact-comment-body">Comment</label>
      <textarea
        id="review-compact-comment-body"
        className="review-compact-field"
        autoFocus
        rows={5}
        placeholder="What should the agent change here?"
        value={draft.body}
        onChange={(event) => comments.setDraftBody(event.target.value)}
      />
    </div>
    <footer className="review-compact-actions">
      <div>
        <button type="button" className="review-compact-button primary" disabled={!draft.body.trim()} onClick={send}>
          <Send size={16} aria-hidden="true" />Add to the composer
        </button>
      </div>
    </footer>
  </section>;
}

function CommitPage({ deps, changes, info, actions, readOnly, refresh }: { deps: CompactReviewDeps; changes: UiWorkspaceChanges; info?: WorkspaceInfo } & Common) {
  const { store } = deps;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [asking, setAsking] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const message = state.commitMessage;
  const canPush = Boolean(info?.upstream) || info?.hasRemote === true;
  const question = asking === undefined ? undefined : commitQuestion(changes, info, message, asking);
  const commit = (push: boolean) => {
    setAsking(undefined);
    setBusy(true);
    setError(undefined);
    void (deps.workspace.invoke("commit", { message: message.trim(), push }) as Promise<CommitResult>).then((result) => {
      actions.notify(result.detail);
      store.update({ commitMessage: "", page: "files" });
      refresh();
    }, (problem: unknown) => setError(errorMessage(problem))).finally(() => setBusy(false));
  };
  const disabled = readOnly || busy || !message.trim();
  return <section className="panel-body review-compact review-compact-commit">
    <PageHeader backLabel="Back to the files (the message is kept)" onBack={() => store.update({ page: "files" })} title={<strong>Commit</strong>} />
    <div className="review-compact-form">
      {readOnly ? <p className="review-compact-notice" role="note">{READ_ONLY_REASON}</p> : null}
      <p className="review-compact-summary">
        <span>{countLabel(changes.fileCount ?? changes.files.length, "file")}</span>
        <Stat added={changes.added} removed={changes.removed} />
        <span className="review-compact-where">On {info?.branch ?? changes.branch ?? "a detached head"}</span>
      </p>
      <label className="review-compact-label" htmlFor="review-compact-commit-message">Message</label>
      <textarea
        id="review-compact-commit-message"
        className="review-compact-field"
        rows={4}
        placeholder={changes.proposedMessage ?? "Describe the change"}
        value={message}
        disabled={readOnly}
        onChange={(event) => store.update({ commitMessage: event.target.value })}
      />
      {changes.proposedMessage && !message ? <button type="button" className="review-compact-link" disabled={readOnly} onClick={() => store.update({ commitMessage: changes.proposedMessage ?? "" })}>Use “{changes.proposedMessage}”</button> : null}
      {error ? <p role="alert" className="review-compact-error">{error}</p> : null}
    </div>
    <footer className="review-compact-actions">
      {readOnly ? <p className="review-compact-reason">Read only: committing needs a device with Full access.</p> : null}
      <div>
        {canPush ? <button type="button" className="review-compact-button" disabled={disabled} onClick={() => setAsking(true)}><Upload size={16} aria-hidden="true" />Commit and push…</button> : null}
        <button type="button" className="review-compact-button primary" disabled={disabled} onClick={() => setAsking(false)}>
          <GitCommitHorizontal size={16} aria-hidden="true" />{busy ? "Committing…" : "Commit…"}
        </button>
      </div>
    </footer>
    {question ? <ConfirmDialog title={question.title} message={question.message} confirmLabel={question.confirm} onCancel={() => setAsking(undefined)} onConfirm={() => commit(asking === true)} /> : null}
  </section>;
}

function RequestPage({ deps, info, actions, readOnly, refresh }: { deps: CompactReviewDeps; info?: WorkspaceInfo } & Common) {
  const { store, requests } = deps;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const status = useLoaded<ReviewRequestStatus>(() => requests.status(), "status", 0);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<"writing" | "opening">();
  const [error, setError] = useState<string>();
  const fields = state.request;
  const set = (patch: Partial<typeof fields>) => store.update({ request: { ...fields, ...patch } });
  const ready = status.status === "ready" ? status.value : undefined;
  const provider = ready ? providerInfo(ready.service) : undefined;
  const blocked = ready?.problem ?? (provider && !provider.capabilities.create ? `${provider.name} does not let Tau open a ${provider.noun}; open it on the website.` : undefined);
  const write = () => {
    setBusy("writing");
    setError(undefined);
    void requests.draft(undefined, ready?.base).then((draft) => set({ title: draft.title, body: draft.body }), (problem: unknown) => setError(errorMessage(problem))).finally(() => setBusy(undefined));
  };
  const open = () => {
    if (!ready) return;
    setAsking(false);
    setBusy("opening");
    setError(undefined);
    void requests.create({ title: fields.title.trim(), body: fields.body, base: ready.base, draft: fields.draft }).then((result) => {
      actions.notify(result.url ? `Opened ${result.url}` : `Opened the ${provider?.noun ?? "request"}.`);
      store.update({ request: { title: "", body: "", draft: false }, page: "files" });
      refresh();
    }, (problem: unknown) => setError(errorMessage(problem))).finally(() => setBusy(undefined));
  };
  const question = ready && provider ? requestQuestion({ title: fields.title, base: ready.base, branch: ready.branch ?? info?.branch, draft: fields.draft, noun: provider.noun, host: provider.name }) : undefined;
  const disabled = readOnly || Boolean(busy) || Boolean(blocked) || !ready;
  return <section className="panel-body review-compact review-compact-request">
    <PageHeader backLabel="Back to the files (the text is kept)" onBack={() => store.update({ page: "files" })} title={<strong>{provider ? `New ${provider.noun}` : "New pull request"}</strong>} />
    <div className="review-compact-form">
      {readOnly ? <p className="review-compact-notice" role="note">{READ_ONLY_REASON}</p> : null}
      {status.status === "loading" ? <Spinner label="Reading the branch" /> : null}
      {status.status === "error" ? <p role="alert" className="review-compact-error">{status.error}</p> : null}
      {ready ? <p className="review-compact-summary"><span className="review-compact-where">{ready.branch ?? info?.branch ?? "This branch"} into {ready.base}{provider ? ` on ${provider.name}` : ""}</span></p> : null}
      {blocked ? <p className="review-compact-notice" role="note">{blocked}</p> : null}
      <label className="review-compact-label" htmlFor="review-compact-request-title">Title</label>
      <input id="review-compact-request-title" className="review-compact-field" value={fields.title} disabled={readOnly} onChange={(event) => set({ title: event.target.value })} />
      <label className="review-compact-label" htmlFor="review-compact-request-body">Description</label>
      <textarea id="review-compact-request-body" className="review-compact-field" rows={6} value={fields.body} disabled={readOnly} onChange={(event) => set({ body: event.target.value })} />
      {provider?.capabilities.draft ? <label className="review-compact-check">
        <input type="checkbox" checked={fields.draft} disabled={readOnly} onChange={(event) => set({ draft: event.target.checked })} />
        Open as a draft
      </label> : null}
      <button type="button" className="review-compact-link" disabled={disabled} onClick={write}>
        <Sparkles size={16} aria-hidden="true" />{busy === "writing" ? "Writing…" : "Write title and description from the commits"}
      </button>
      {error ? <p role="alert" className="review-compact-error">{error}</p> : null}
    </div>
    <footer className="review-compact-actions">
      {readOnly ? <p className="review-compact-reason">Read only: opening a {provider?.noun ?? "pull request"} needs a device with Full access.</p> : null}
      <div>
        <button type="button" className="review-compact-button primary" disabled={disabled || !fields.title.trim()} onClick={() => setAsking(true)}>
          <GitPullRequestArrow size={16} aria-hidden="true" />{busy === "opening" ? "Opening…" : `Open ${provider?.short ?? "PR"}…`}
        </button>
      </div>
    </footer>
    {asking && question ? <ConfirmDialog title={question.title} message={question.message} confirmLabel={question.confirm} onCancel={() => setAsking(false)} onConfirm={open} /> : null}
  </section>;
}
