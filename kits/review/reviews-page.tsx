import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import {
  ChevronRight,
  CircleCheck,
  CircleX,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  DiffView,
  Empty,
  errorMessage,
  FileKindIcon,
  formatCost,
  Markdown,
  ProjectIcon,
  ProviderIconStack,
  READ_ONLY_REASON,
  SettingsPageAction,
  Skeleton,
  Spinner,
  tooltipProps,
  useCommandAllowed,
  useModelName,
  useThreadStore,
  type HostExtensionClient,
  type PageProps,
  type UiFileDiff,
  type WorkbenchActions,
} from "tau";
import { useCompactProfile } from "./compact-profile.js";
import { mergeBlocker, mergedThisMonth, type LocalReview, type ReviewCounts, type ReviewState } from "./local-reviews.js";
import { useLocalReviews, type LocalReviewsStore } from "./local-reviews-store.js";
import { REVIEW_HOST_EXTENSION_ID } from "./protocol.js";
import type { PullRequestsPageParts } from "./pull-requests-page.js";
import type { ReviewsFilter } from "./reviews-filter.js";
import type { RowRequests } from "./requests.js";

const PullRequestsPage = lazy(() => import("./pull-requests-page.js").then((module) => ({ default: module.PullRequestsPage })));

export type ReviewTab = ReviewState | "remote";
const TABS: readonly ReviewTab[] = ["ready", "requested", "conflicts", "merged", "remote"];
const TAB_LABELS: Record<ReviewTab, { nav: string; short: string; section: string }> = {
  ready: { nav: "Ready to merge", short: "Ready", section: "Ready to merge" },
  requested: { nav: "Changes requested", short: "Requested", section: "Changes requested" },
  conflicts: { nav: "Conflicts", short: "Conflicts", section: "Conflicts" },
  merged: { nav: "Merged", short: "Merged", section: "Merged" },
  remote: { nav: "Remote", short: "Remote", section: "Remote pull requests" },
};
const TAB_ICONS: Record<ReviewTab, typeof GitPullRequest> = {
  ready: GitPullRequest,
  requested: MessageSquare,
  conflicts: RefreshCw,
  merged: GitMerge,
  remote: GitPullRequestArrow,
};

export interface ReviewsPageParts {
  store: LocalReviewsStore;
  host: HostExtensionClient;
  rows: RowRequests;
  remote: PullRequestsPageParts;
  /** "Filter reviews": in the sidebar while it shows, in the page's head otherwise. */
  filter: ReviewsFilter;
}

const tabOf = (value: unknown): ReviewTab => TABS.includes(value as ReviewTab) ? value as ReviewTab : "ready";
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

/** "4m", "22m", "1d": the age the list shows. */
export function shortAge(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 60 ? `${days}d` : new Date(at).toISOString().slice(0, 10);
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

function ProjectTile({ project }: { project: LocalReview["project"] }) {
  return <ProjectIcon project={{ path: project.root, name: project.name, workspaceId: project.key, icon: project.icon }} className="rv-tile" />;
}

function Changes({ review, files = true }: { review: LocalReview; files?: boolean }) {
  return (
    <span className="rv-changes">
      {files ? <span className="rv-files">{plural(review.files, "file")}</span> : null}
      <span className="stat-add">+{review.added}</span>
      <span className="stat-del">−{review.removed}</span>
    </span>
  );
}

function Checks({ review }: { review: LocalReview }) {
  const checks = review.checks;
  if (!checks) return <span className="rv-checks none">no checks</span>;
  const names = checks.names.join(", ");
  if (checks.running > 0) return <span className="rv-checks running" {...tooltipProps(names)}><LoaderCircle size={12} aria-hidden="true" /> {checks.running} running</span>;
  if (checks.failed > 0) return <span className="rv-checks failed" {...tooltipProps(names)}><CircleX size={12} aria-hidden="true" /> {checks.failed} failed</span>;
  return <span className="rv-checks passed" {...tooltipProps(names)}><CircleCheck size={12} aria-hidden="true" /> {checks.passed} passed</span>;
}

function Model({ review, name = true }: { review: LocalReview; name?: boolean }) {
  const catalog = useModelName(review.backendKind, review.model, review.modelProvider);
  const label = catalog ?? review.model;
  return (
    <span className="rv-model">
      <ProviderIconStack modelProvider={review.modelProvider} runtimeProvider={review.backendKind} runtimeMark={false} {...(label ? { modelName: label } : {})} hint={{ side: "top" }} />
      {name && label ? <span className="rv-model-name">{label}</span> : null}
    </span>
  );
}

/** Where Merge lands; a target other than the default branch says so. */
function Into({ review }: { review: LocalReview }) {
  if (!review.target) return null;
  const off = review.offDefault;
  return <span className="rv-into" data-off={off ? "" : undefined} {...(off ? tooltipProps(`Not ${off}: Merge lands on the branch the project's checkout has out.`) : {})}> into {review.target}</span>;
}

/** Why a branch counts as merged without a merge of its own commits. */
const ALREADY: Record<NonNullable<LocalReview["mergedBy"]>, string> = {
  patches: "every commit's change is there already, under other commits (a cherry-pick, a rebase or rewritten history).",
  tree: "merging would change nothing (a squash merge).",
  request: "its pull request was merged on the host.",
};

/** A thread here to write to, or its link to one on another machine. */
const askable = (review: LocalReview) => Boolean(review.threadId || review.remote);
/** Why the thread cannot be asked to rebase: one on another machine does not see this checkout's branch. */
const rebaseBlocker = (review: LocalReview, mayAsk: boolean) => !mayAsk ? READ_ONLY_REASON
  : review.remote ? `The thread runs on ${review.remote.machine}, where ${review.target} is not this checkout's; merge it by hand or send a note.`
  : !review.threadId ? "No thread works on this branch any more."
  : undefined;

const cost = (review: LocalReview) => review.costUsd === undefined ? "—" : formatCost(review.costUsd) ?? "$0.00";

/** What a row says in its last column when it has no button: the open ask, or where it was merged. */
function Aside({ review }: { review: LocalReview }) {
  if (review.state === "merged") return <span className="rv-aside">{review.mergedBy === "request" ? "Pull request merged" : review.mergedBy ? `Already in ${review.target}` : `into ${review.target}`}</span>;
  if (review.ask?.kind === "note") return <span className="rv-aside" {...tooltipProps(review.ask.text)}><MessageSquare size={12} aria-hidden="true" /> Your note: {review.ask.text}</span>;
  if (review.ask) return <span className="rv-aside"><RefreshCw size={12} aria-hidden="true" /> Rebase asked</span>;
  return null;
}

interface RowActions {
  merge(review: LocalReview): void;
  rebase(review: LocalReview): void;
  remove(review: LocalReview): void;
  busy: string | undefined;
  mayMerge: boolean;
  mayRemove: boolean;
  mayAsk: boolean;
}

function RowAction({ review, act }: { review: LocalReview; act: RowActions }) {
  if (review.state === "ready") {
    const blocked = !act.mayMerge ? READ_ONLY_REASON : mergeBlocker(review);
    return (
      <button type="button" className="rv-merge" disabled={Boolean(blocked) || act.busy === review.key} {...tooltipProps(blocked ?? `Merge ${review.branch} into ${review.target}`)} onClick={() => act.merge(review)}>
        <GitMerge size={13} aria-hidden="true" /> {act.busy === review.key ? "Merging…" : "Merge"}
      </button>
    );
  }
  if (review.state === "conflicts") {
    return (
      <button type="button" className="rv-ask" disabled={Boolean(rebaseBlocker(review, act.mayAsk)) || act.busy === review.key} {...tooltipProps(rebaseBlocker(review, act.mayAsk) ?? `Asks the thread to rebase onto ${review.target}`)} onClick={() => act.rebase(review)}>
        <RefreshCw size={13} aria-hidden="true" /> Ask thread to rebase
      </button>
    );
  }
  return <Aside review={review} />;
}

function ReviewRow({ review, open, act }: { review: LocalReview; open(review: LocalReview): void; act: RowActions }) {
  return (
    <li className="rv-row" data-state={review.state}>
      <button type="button" className="rv-row-open" onClick={() => open(review)} aria-label={`${review.title}, ${review.branch}`}>
        <ProjectTile project={review.project} />
        <span className="rv-thread">
          <span className="rv-title">{review.title}</span>
          <span className="rv-branch">{review.remote ? `${review.remote.machine}: ` : ""}{review.branch}<Into review={review} /></span>
        </span>
        <Changes review={review} />
        <Checks review={review} />
        <span className="rv-cost-cell"><Model review={review} /><span className="rv-cost">{cost(review)}</span></span>
        <span className="rv-age">{shortAge(review.at)}</span>
      </button>
      <span className="rv-row-action"><RowAction review={review} act={act} /></span>
    </li>
  );
}

/** A phone's row (1p): branch and age, the title, then changes, checks, cost and the model's mark. */
function ReviewCard({ review, open }: { review: LocalReview; open(review: LocalReview): void }) {
  return (
    <li className="rv-card" data-state={review.state}>
      <button type="button" onClick={() => open(review)}>
        <span className="rv-card-line">
          <ProjectTile project={review.project} />
          <span className="rv-branch">{review.branch}<Into review={review} /></span>
          <span className="rv-age">{shortAge(review.at)}</span>
        </span>
        <span className="rv-title">{review.title}</span>
        <span className="rv-card-line">
          <Changes review={review} files={false} />
          {review.state === "merged" ? <Aside review={review} /> : review.ask ? <Aside review={review} /> : <Checks review={review} />}
          <span className="rv-cost">{cost(review)}</span>
          <Model review={review} name={false} />
        </span>
      </button>
    </li>
  );
}

/** The tabs of a phone and of a narrow page: the states with their counts, then Remote. */
function Tabs({ tab, count, select }: { tab: ReviewTab; count(tab: ReviewTab): number; select(tab: ReviewTab): void }) {
  return (
    <nav className="rv-tabs" aria-label="Reviews">
      {TABS.map((entry) => (
        <button key={entry} type="button" className={entry === tab ? "active" : undefined} aria-current={entry === tab ? "page" : undefined} onClick={() => select(entry)}>
          {TAB_LABELS[entry].short}{count(entry) ? <span className="rv-count">{count(entry)}</span> : null}
        </button>
      ))}
    </nav>
  );
}

/** Arrows move through a column's buttons, Home and End to its ends; Enter presses the one with the focus. */
function moveFocus(event: KeyboardEvent<HTMLElement>, list: HTMLElement | null) {
  if (!list || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const buttons = [...list.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  if (buttons.length === 0) return;
  event.preventDefault();
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0
    : event.key === "End" ? buttons.length - 1
    : at < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1)
    : Math.min(buttons.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)));
  buttons[next]?.focus();
}

/**
 * The page's sidebar (1i), in Settings' column: the filter, the states with
 * their counts, the projects with their open reviews, and Remote.
 */
export function ReviewsSidebar({ params, navigate, parts }: PageProps & { parts: ReviewsPageParts }) {
  const { counts } = useLocalReviews(parts.store);
  const remoteCount = useSyncExternalStore(parts.rows.subscribe, parts.rows.openCount);
  const filter = useSyncExternalStore(parts.filter.subscribe, parts.filter.getSnapshot);
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const tab = tabOf(params.tab);
  const project = text(params.project);
  const inDetail = Boolean(params.review) || Boolean(params.url);
  const count = (entry: ReviewTab) => entry === "remote" ? remoteCount : counts[entry];
  // Out of a detail, into what the page lists.
  const select = (next: ReviewTab, nextProject?: string) => navigate({ tab: next, ...(nextProject ? { project: nextProject } : {}) }, { root: true, replace: true });
  const item = (key: string, active: boolean, label: string, icon: ReactNode, figure: number, onSelect: () => void, hint?: string) => (
    <button key={key} type="button" className={active ? "active" : undefined} aria-current={active ? "page" : undefined} {...(hint ? tooltipProps(hint, { side: "right" }) : {})} onClick={onSelect}>
      {icon}<span>{label}</span>{figure ? <small className="rv-nav-count">{figure}</small> : null}
    </button>
  );
  return (
    <>
      <label className="settings-nav-search">
        <Search size={14} aria-hidden="true" />
        <input
          ref={field}
          type="search"
          value={filter}
          placeholder="Filter reviews"
          aria-label="Filter reviews"
          onChange={(event) => {
            parts.filter.set(event.target.value);
            if (inDetail || tab === "remote") select(tab === "remote" ? "ready" : tab, project);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && filter) { event.preventDefault(); event.stopPropagation(); parts.filter.set(""); return; }
            if (event.key === "ArrowDown") { event.preventDefault(); list.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
          }}
        />
        {filter ? <button type="button" className="settings-nav-search-clear" aria-label="Clear the filter" onClick={() => { parts.filter.set(""); field.current?.focus(); }}><X size={12} /></button> : null}
      </label>
      <div className="settings-nav-list rv-sidebar" ref={list} onKeyDown={(event) => moveFocus(event, list.current)}>
        <div className="settings-nav-group" role="group" aria-label="Reviews">
          <h2 className="settings-nav-heading">Reviews</h2>
          {TABS.filter((entry) => entry !== "remote").map((entry) => {
            const Icon = TAB_ICONS[entry];
            return item(entry, entry === tab && !project, TAB_LABELS[entry].nav, <Icon size={14} aria-hidden="true" />, count(entry), () => select(entry));
          })}
        </div>
        {counts.projects.length > 0 ? (
          <div className="settings-nav-group" role="group" aria-label="Projects">
            <h2 className="settings-nav-heading">Projects</h2>
            {counts.projects.map((entry) => item(entry.key, project === entry.key, entry.name, <ProjectTile project={entry} />, entry.open, () => select(tab === "remote" ? "ready" : tab, entry.key)))}
          </div>
        ) : null}
        <div className="settings-nav-group" role="group" aria-label="Elsewhere">
          <h2 className="settings-nav-heading">Elsewhere</h2>
          {item("remote", tab === "remote", "Remote pull requests", <GitPullRequestArrow size={14} aria-hidden="true" />, count("remote"), () => select("remote"), "Pull and merge requests on the projects' Git hosts")}
        </div>
      </div>
    </>
  );
}

/** A narrow page's project filter beside the tabs, with the open reviews of each. */
function ProjectFilter({ project, counts, select }: { project?: string; counts: ReviewCounts; select(project?: string): void }) {
  if (counts.projects.length < 2 && !project) return null;
  return (
    <select className="rv-project-filter" aria-label="Project" value={project ?? ""} onChange={(event) => select(event.target.value || undefined)}>
      <option value="">All projects</option>
      {counts.projects.map((entry) => <option key={entry.key} value={entry.key}>{entry.name}{entry.open ? ` · ${entry.open}` : ""}</option>)}
    </select>
  );
}

function Section({ state, title, count, children }: { state: ReviewState; title?: string; count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="rv-section" aria-label={title ?? TAB_LABELS[state].section}>
      {title ? <h3>{title} · {count}</h3> : null}
      <ul>{children}</ul>
    </section>
  );
}

const INTRO = "Finished work of threads that ran in a worktree of their own, ready to merge into the project's checkout here; Remote pull requests are the ones on GitHub and other hosts.";
const EMPTY_TEXT: Record<ReviewState, { title: string; description: string }> = {
  ready: { title: "Nothing to review", description: INTRO },
  requested: { title: "No changes requested", description: "A note or a rebase you send back to a thread waits here until the thread commits again." },
  conflicts: { title: "No conflicts", description: "A branch that would not merge cleanly into its main checkout shows here, to ask its thread to rebase." },
  merged: { title: "Nothing merged yet", description: "Merging keeps the thread; its branch just stops appearing under Ready." },
};

/**
 * One review (1q): what the thread said it did, the files with their diffs,
 * and Merge, Ask thread to rebase and a note back to the thread.
 */
function ReviewDetail({ review, parts, act, actions, compact }: { review: LocalReview; parts: ReviewsPageParts; act: RowActions; actions: WorkbenchActions; compact: boolean }) {
  const [summary, setSummary] = useState<{ summary?: string; turns?: number }>();
  const [open, setOpen] = useState<string>();
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [removing, setRemoving] = useState(false);
  let threads: ReturnType<typeof useThreadStore> | undefined;
  try { threads = useThreadStore(); } catch { threads = undefined; }
  useEffect(() => {
    let live = true;
    setSummary(undefined);
    parts.store.summary(review).then((answer) => { if (live) setSummary(answer); }, () => { if (live) setSummary({}); });
    return () => { live = false; };
  }, [parts.store, review.key, review.tip]); // eslint-disable-line react-hooks/exhaustive-deps
  const blocked = !act.mayMerge ? READ_ONLY_REASON : mergeBlocker(review);
  const thread = review.threadId ? threads?.getThread(review.threadId) : undefined;
  const sendNote = async () => {
    if (!note.trim()) return;
    setSending(true);
    try {
      await parts.store.ask(review, "note", note);
      setNote("");
      setNoting(false);
      actions.toast?.({ type: "success", title: "Note sent to the thread", description: review.title });
    } catch (error) {
      actions.toast?.({ type: "error", title: "The note was not sent", description: errorMessage(error) });
    } finally {
      setSending(false);
    }
  };
  return (
    <article className="rv-detail" aria-label={review.title}>
      <p className="rv-detail-sub">
        <span className="rv-branch">{review.branch}<Into review={review} /></span>
        <span aria-hidden="true">·</span>
        <Changes review={review} files={false} />
        <span aria-hidden="true">·</span>
        <Model review={review} />
        {review.costUsd !== undefined ? <><span aria-hidden="true">·</span><span className="rv-cost">{cost(review)}</span></> : null}
      </p>
      {summary === undefined ? <Skeleton className="rv-summary-skeleton" /> : summary.summary ? <div className="rv-summary"><Markdown>{summary.summary}</Markdown></div> : <p className="rv-summary muted">The thread left no summary.</p>}
      <p className="rv-meta">
        <strong>{plural(review.files, "file")}</strong>
        {summary?.turns ? <span>{plural(summary.turns, "turn")}</span> : null}
        <Checks review={review} />
        {review.uncommitted ? <span className="warn">{review.uncommitted} not committed</span> : null}
        {review.behind ? <span>{plural(review.behind, "commit")} behind {review.target}</span> : null}
      </p>
      {review.ask ? (
        <div className="rv-ask-open" role="status">
          {review.ask.kind === "note" ? <MessageSquare size={13} aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
          <span>{review.ask.kind === "note" ? <>Your note: {review.ask.text}</> : "You asked the thread to rebase."} It shows here until the thread commits again.</span>
          <button type="button" disabled={!act.mayAsk} onClick={() => { void parts.store.withdraw(review).catch((error) => actions.notify(errorMessage(error))); }}>Withdraw</button>
        </div>
      ) : null}
      {review.mergedBy ? <p className="rv-already" role="status"><GitMerge size={13} aria-hidden="true" /> Already in {review.target}: {ALREADY[review.mergedBy]}</p> : null}
      {review.conflicts.length > 0 ? (
        <p className="rv-conflicts" role="status"><TriangleAlert size={13} aria-hidden="true" /> Conflicts with {review.target} in {review.conflicts.slice(0, 6).join(", ")}{review.conflicts.length > 6 ? " …" : ""}</p>
      ) : null}
      <ul className="rv-files-list" aria-label="Files">
        {review.paths.map((file) => (
          <li key={file.path} className={open === file.path ? "open" : undefined}>
            <button type="button" aria-expanded={open === file.path} onClick={() => setOpen(open === file.path ? undefined : file.path)} disabled={!review.workspace}>
              <FileKindIcon name={file.path} />
              <span className="rv-file-path">{file.path}</span>
              <span className="rv-changes">{file.added ? <span className="stat-add">+{file.added}</span> : null}{file.removed ? <span className="stat-del">−{file.removed}</span> : null}</span>
              <ChevronRight size={13} aria-hidden="true" className="rv-chevron" />
            </button>
            {open === file.path && review.workspace ? <FileDiff host={parts.host} review={review} path={file.path} /> : null}
          </li>
        ))}
        {review.files > review.paths.length && review.paths.length > 0 ? <li className="rv-more">and {plural(review.files - review.paths.length, "more file")}</li> : null}
      </ul>
      {noting ? (
        <div className="rv-note">
          <textarea autoFocus value={note} placeholder="What should the thread change?" aria-label="Note to the thread" onChange={(event) => setNote(event.target.value)} rows={compact ? 3 : 4} />
          <div>
            <button type="button" onClick={() => { setNoting(false); setNote(""); }}>Cancel</button>
            <button type="button" className="primary" disabled={!note.trim() || sending} onClick={() => { void sendNote(); }}>{sending ? "Sending…" : "Send to thread"}</button>
          </div>
        </div>
      ) : null}
      {review.state !== "merged" ? (
        <div className="rv-detail-actions">
          <button type="button" className="rv-merge" disabled={Boolean(blocked) || act.busy === review.key} {...tooltipProps(blocked ?? `Merge ${review.branch} into ${review.target} (a merge commit, after checking it merges cleanly)`)} onClick={() => act.merge(review)}>
            <GitMerge size={14} aria-hidden="true" /> {act.busy === review.key ? "Merging…" : "Merge"}
          </button>
          <button type="button" disabled={Boolean(rebaseBlocker(review, act.mayAsk)) || act.busy === review.key} {...tooltipProps(rebaseBlocker(review, act.mayAsk) ?? `Asks the thread to rebase onto ${review.target}`)} onClick={() => act.rebase(review)}>
            <RefreshCw size={14} aria-hidden="true" /> Ask thread to rebase
          </button>
          <button type="button" disabled={!act.mayAsk || !askable(review) || noting} {...tooltipProps(!act.mayAsk ? READ_ONLY_REASON : "Send the thread a note on what to change")} onClick={() => setNoting(true)}>
            <MessageSquare size={14} aria-hidden="true" /> Note
          </button>
          {thread ? <button type="button" className="rv-open-thread" onClick={() => { void actions.switchSession(thread.path); }}>Open thread</button> : null}
        </div>
      ) : removing ? (
        <div className="rv-detail-actions" role="group" aria-label="Remove">
          <span>Remove the worktree and delete {review.branch}? The threads stay.</span>
          <button type="button" onClick={() => setRemoving(false)}>Cancel</button>
          <button type="button" className="danger" disabled={act.busy === review.key} onClick={() => act.remove(review)}>{act.busy === review.key ? "Removing…" : "Remove"}</button>
        </div>
      ) : (
        <div className="rv-detail-actions">
          {review.workspace && !review.remote ? (
            <button type="button" disabled={!act.mayRemove} {...tooltipProps(act.mayRemove ? `Removes the worktree and deletes ${review.branch}; ${review.target} holds its work` : READ_ONLY_REASON)} onClick={() => setRemoving(true)}>
              <Trash2 size={14} aria-hidden="true" /> Remove worktree and branch
            </button>
          ) : null}
          {thread ? <button type="button" className="rv-open-thread" onClick={() => { void actions.switchSession(thread.path); }}>Open thread</button> : null}
        </div>
      )}
    </article>
  );
}

function FileDiff({ host, review, path }: { host: HostExtensionClient; review: LocalReview; path: string }) {
  const [diff, setDiff] = useState<UiFileDiff>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    host.invoke("file-diff", { workspace: review.workspace, relPath: path, options: { scope: "branch", baseRef: review.target } })
      .then((answer) => { if (live) setDiff(answer as UiFileDiff); }, (reason) => { if (live) setError(errorMessage(reason)); });
    return () => { live = false; };
  }, [host, review.workspace, review.target, review.tip, path]);
  if (error) return <p className="rv-diff-error">{error}</p>;
  if (!diff) return <div className="rv-diff-loading"><Spinner size="sm" label={`Loading ${path}`} /></div>;
  return <div className="rv-diff"><DiffView diff={diff} mode="unified" path={path} wrap /></div>;
}

/**
 * The Reviews page: finished threads' branches as local merge requests across
 * projects (1i, 1p, 1q), and the remote requests under their own entry. Its
 * sidebar picks what it lists; without one, tabs over the list do.
 */
export function ReviewsPage({ params, navigate, actions, close, parts, sidebar = false }: PageProps & { parts: ReviewsPageParts }) {
  const compact = useCompactProfile();
  const { reviews, counts, snapshot } = useLocalReviews(parts.store);
  const remoteCount = useSyncExternalStore(parts.rows.subscribe, parts.rows.openCount);
  const filter = useSyncExternalStore(parts.filter.subscribe, parts.filter.getSnapshot);
  const [busy, setBusy] = useState<string>();
  const mayMerge = useCommandAllowed(REVIEW_HOST_EXTENSION_ID, "local-review-merge");
  const mayAsk = useCommandAllowed(REVIEW_HOST_EXTENSION_ID, "local-review-ask");
  const mayRemove = useCommandAllowed(REVIEW_HOST_EXTENSION_ID, "local-review-remove");
  const tab = tabOf(params.tab);
  const project = text(params.project);
  const detailKey = text(params.review);
  const store = parts.store;
  useEffect(() => { void store.refresh(); }, [store]);

  const select = (next: ReviewTab, nextProject?: string) => navigate({ tab: next, ...(nextProject ? { project: nextProject } : {}) }, { replace: true });
  const openReview = (review: LocalReview) => navigate({ tab, ...(project ? { project } : {}), review: review.key }, { label: review.title });

  const act: RowActions = {
    busy,
    mayMerge,
    mayAsk,
    mayRemove,
    merge: (review) => {
      setBusy(review.key);
      void store.merge(review).then((outcome) => {
        if (outcome.state === "merged" || outcome.state === "already-merged") actions.toast?.({ type: "success", title: `Merged ${review.branch} into ${outcome.into}`, description: review.title });
        else actions.toast?.({ type: "warning", title: outcome.state === "conflict" ? "Not merged: conflicts" : "Not merged", description: outcome.detail });
      }, (error) => actions.toast?.({ type: "error", title: `${review.branch} was not merged`, description: errorMessage(error) })).finally(() => { setBusy(undefined); void store.refresh(); });
    },
    rebase: (review) => {
      setBusy(review.key);
      void store.ask(review, "rebase").then(
        () => actions.toast?.({ type: "success", title: "Asked the thread to rebase", description: review.title }),
        (error) => actions.toast?.({ type: "error", title: "The thread was not asked", description: errorMessage(error) }),
      ).finally(() => setBusy(undefined));
    },
    remove: (review) => {
      setBusy(review.key);
      void store.remove(review).then(
        () => actions.toast?.({ type: "success", title: `Removed ${review.branch} and its worktree`, description: review.title }),
        (error) => actions.toast?.({ type: "error", title: `${review.branch} was not removed`, description: errorMessage(error) }),
      ).finally(() => { setBusy(undefined); void store.refresh(); });
    },
  };

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return reviews.filter((review) => (!project || review.project.key === project)
      && (!needle || `${review.title}\n${review.branch}\n${review.project.name}`.toLowerCase().includes(needle)));
  }, [reviews, project, filter]);

  const detail = detailKey ? reviews.find((review) => review.key === detailKey) : undefined;
  const month = mergedThisMonth(reviews);
  const footer = (
    <p className="rv-footer">
      Merged · {month.count} this month{month.costUsd > 0 ? `, ${formatCost(month.costUsd)}` : ""}. Merging keeps the thread; it just stops appearing here.
    </p>
  );

  let body: ReactNode;
  if (tab === "remote") {
    body = (
      <Suspense fallback={<div className="stage-empty" role="status"><Spinner size="sm" label="Loading pull requests" /></div>}>
        <PullRequestsPage params={params} navigate={(next, options) => navigate({ ...next, tab: "remote" }, options)} actions={actions} close={close} parts={parts.remote} />
      </Suspense>
    );
  } else if (detailKey) {
    body = detail
      ? <ReviewDetail review={detail} parts={parts} act={act} actions={actions} compact={compact} />
      : snapshot.answer ? <Empty title="This review is gone" description="Its branch was removed, or its thread started working again." /> : <Skeleton className="rv-row-skeleton" />;
  } else if (!snapshot.answer) {
    body = snapshot.error
      ? <Empty icon={<TriangleAlert size={18} />} title="Reviews could not be read" description={snapshot.error}><button type="button" onClick={() => { void store.refresh(); }}>Retry</button></Empty>
      : <div className="rv-loading" aria-busy="true">{[0, 1, 2].map((index) => <Skeleton key={index} className="rv-row-skeleton" />)}</div>;
  } else {
    const of = (state: ReviewState) => shown.filter((review) => review.state === state);
    const row = (review: LocalReview) => compact
      ? <ReviewCard key={review.key} review={review} open={openReview} />
      : <ReviewRow key={review.key} review={review} open={openReview} act={act} />;
    // Ready is the queue: what can merge, then what waits on the thread, then what conflicts.
    const sections: Array<{ state: ReviewState; title?: string }> = tab === "ready"
      ? [{ state: "ready" }, { state: "requested", title: "Changes requested" }, { state: "conflicts", title: "Conflicts" }]
      : [{ state: tab }];
    const total = sections.reduce((sum, section) => sum + of(section.state).length, 0);
    body = total === 0
      ? <Empty icon={<GitPullRequest size={18} />} title={filter ? "No review matches" : EMPTY_TEXT[tab].title} description={filter ? "Try other words, or clear the filter." : EMPTY_TEXT[tab].description} />
      : (
        <>
          {tab === "ready" ? <p className="rv-intro">{INTRO}</p> : null}
          {compact ? null : (
            <div className="rv-columns" aria-hidden="true">
              <span />
              <span>Thread</span><span>Changes</span><span>Checks</span><span>Model · cost</span><span>Age</span>
            </div>
          )}
          {sections.map((section) => (
            <Section key={section.state} state={section.state} {...(section.title ? { title: section.title } : {})} count={of(section.state).length}>
              {of(section.state).map(row)}
            </Section>
          ))}
        </>
      );
  }

  const inDetail = Boolean(detailKey) || (tab === "remote" && Boolean(params.url));
  const count = (entry: ReviewTab) => entry === "remote" ? remoteCount : counts[entry];
  return (
    <div className={`rv-page${compact ? " compact" : ""}`} data-tab={tab}>
      {!compact && !sidebar && tab !== "remote" && !detailKey ? (
        <SettingsPageAction>
          <label className="rv-filter">
            <Search size={13} aria-hidden="true" />
            <input type="search" value={filter} placeholder="Filter reviews" aria-label="Filter reviews" onChange={(event) => parts.filter.set(event.target.value)} />
          </label>
        </SettingsPageAction>
      ) : null}
      <div className={`rv-main${tab === "remote" ? " remote" : ""}`}>
        {inDetail || sidebar ? null : (
          <div className="rv-tabs-row">
            <Tabs tab={tab} count={count} select={(next) => select(next, next === "remote" ? undefined : project)} />
            {compact || tab === "remote" ? null : <ProjectFilter {...(project ? { project } : {})} counts={counts} select={(next) => select(tab, next)} />}
          </div>
        )}
        <div className="rv-scroll">{body}</div>
        {tab === "remote" || detailKey ? null : footer}
      </div>
    </div>
  );
}

export default ReviewsPage;
