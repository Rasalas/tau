import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  ChevronRight,
  Eye,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  Inbox,
  MessageSquare,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
  Wrench,
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
  Skeleton,
  Spinner,
  tooltipProps,
  useCommandAllowed,
  useModelName,
  useThreadStore,
  type DiffLineSlot,
  type HostExtensionClient,
  type PageProps,
  type UiDiffLine,
  type UiFileDiff,
  type UiProject,
  type WorkbenchActions,
} from "tau";
import { useCompactProfile } from "./compact-profile.js";
import { fixRequest, mergedStatus, type InboxItem } from "./inbox.js";
import { useInboxRows, type InboxPullsStore } from "./inbox-pulls.js";
import { mergeBlocker, mergedThisMonth, reviewRuntime, type HunkPick, type LocalReview } from "./local-reviews.js";
import type { LocalReviewsStore, ReviewRun } from "./local-reviews-store.js";
import { runsPipeline } from "./pipeline.js";
import { PipelineGraph, PipelineMini } from "./pipeline-view.js";
import { REVIEW_HOST_EXTENSION_ID, requestNumber, type PendingReviewComment, type PullRequestListEntry } from "./protocol.js";
import { requestLabelOf } from "./pull-request-logic.js";
import { projectId } from "./pull-request-lists.js";
import { baseName, lineTarget, lineText, noteMessage } from "./review-lines.js";
import type { PullRequestsPageParts } from "./pull-requests-page.js";
import type { ReviewsFilter } from "./reviews-filter.js";
import { ReadFailures, ReviewsFooter } from "./reviews-footer.js";
import { Changes, StatusCell } from "./review-cells.js";
import type { RowRequests } from "./requests.js";
import { ReviewDetailSidebar } from "./review-detail-sidebar.js";
import { ALREADY, askBlocker, plural, rebaseBlocker } from "./review-words.js";
import type { DetailParts } from "./review-detail-store.js";

const PullRequestsPage = lazy(() => import("./pull-requests-page.js").then((module) => ({ default: module.PullRequestsPage })));
const PullRequestDetailPane = lazy(() => import("./pull-requests-page.js").then((module) => ({ default: module.PullRequestDetailPane })));
const LocalReviewDetail = lazy(() => import("./local-review-detail.js").then((module) => ({ default: module.LocalReviewDetail })));
const PullMergeDialog = lazy(() => import("./inbox-merge.js").then((module) => ({ default: module.PullMergeDialog })));

/** What the page lists: the inbox, what was merged, or every project's pull requests. */
export type ReviewTab = "inbox" | "merged" | "remote";
const TABS: readonly ReviewTab[] = ["inbox", "merged", "remote"];
const TAB_LABELS: Record<ReviewTab, { nav: string; short: string; title: string }> = {
  inbox: { nav: "Inbox", short: "Inbox", title: "Inbox" },
  merged: { nav: "Merged", short: "Merged", title: "Merged" },
  remote: { nav: "All pull requests", short: "Pull requests", title: "All pull requests" },
};
const TAB_ICONS: Record<ReviewTab, typeof GitPullRequest> = { inbox: Inbox, merged: GitMerge, remote: GitPullRequestArrow };

export interface ReviewsPageParts {
  store: LocalReviewsStore;
  host: HostExtensionClient;
  rows: RowRequests;
  remote: PullRequestsPageParts;
  /** The open pull requests the inbox reads beside the local branches. */
  pulls: InboxPullsStore;
  /** "Filter reviews", drawn in the list's page head. */
  filter: ReviewsFilter;
  /** What the detail view (1e) shares with its sidebar, and what it reads beside the review. */
  detail: DetailParts;
}

// Links from before the inbox named a review state; those all live in the inbox now.
const tabOf = (value: unknown): ReviewTab => value === "merged" || value === "remote" ? value : "inbox";
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

/** A project as the sidebar and the rows draw it. */
type ProjectMark = LocalReview["project"];

function ProjectTile({ project }: { project: ProjectMark }) {
  return <ProjectIcon project={{ path: project.root, name: project.name, workspaceId: project.key, icon: project.icon }} className="rv-tile" />;
}

const markOf = (project: UiProject): ProjectMark => ({ key: projectId(project), name: project.name, root: project.path, ...(project.icon ? { icon: project.icon } : {}) });

/** The review's script runs as a mini pipeline, in the review on a phone. */
function Checks({ runs }: { runs: readonly ReviewRun[] }) {
  if (!runs.length) return <span className="rv-checks none">No checks</span>;
  return <span className="rv-checks"><PipelineMini pipelines={[runsPipeline(runs)]} size={18} nested={false} /></span>;
}

function Model({ review, name = true }: { review: LocalReview; name?: boolean }) {
  const catalog = useModelName(reviewRuntime(review), review.model, review.modelProvider);
  const label = catalog ?? review.model;
  return (
    <span className="rv-model">
      <ProviderIconStack modelProvider={review.modelProvider} runtimeProvider={reviewRuntime(review)} runtimeMark={false} {...(label ? { modelName: label } : {})} hint={{ side: "top" }} />
      {name && label ? <span className="rv-model-name">{label}</span> : null}
    </span>
  );
}

/** Where Merge lands; a target other than the default branch says so. */
function Into({ review }: { review: LocalReview }) {
  if (!review.target) return null;
  const off = review.offDefault;
  return <span className="rv-into" data-off={off ? "" : undefined} {...(off ? tooltipProps(`This review targets ${review.target}; the project's default branch is ${off}.`) : {})}> → {review.target}</span>;
}

const numberOf = (entry: PullRequestListEntry) => requestNumber(entry.ref.service, entry.ref.number);

/** The second line: `#12 · branch → target`, or `#12 · author` for someone else's request. */
function Sub({ item }: { item: InboxItem }) {
  const { review, pull } = item;
  const entry = pull?.entry;
  const lead = entry ? `${numberOf(entry)} · ` : review?.request ? `${requestLabelOf(review.request.url, review.request.number)} · ` : "";
  if (review) return <span className="rv-sub">{lead}<span className="rv-mono">{review.remote ? `${review.remote.machine}: ` : ""}{review.branch}</span><Into review={review} /></span>;
  if (entry && !pull?.mine) return <span className="rv-sub">{lead}{entry.author?.login ?? "ghost"}</span>;
  return <span className="rv-sub">{lead}<span className="rv-mono">{entry?.headRef}</span> → {entry?.baseRef}</span>;
}

const titleOf = (item: InboxItem) => item.review?.title ?? item.pull?.entry.title ?? "";
const labelOf = (item: InboxItem) => item.review ? `${item.review.title}, ${item.review.branch}` : `${titleOf(item)}, ${item.pull ? numberOf(item.pull.entry) : ""}`;

interface RowActions {
  merge(review: LocalReview, picks?: Record<string, HunkPick[]>): void;
  mergePull(item: InboxItem): void;
  rebase(review: LocalReview): void;
  fix(item: InboxItem): void;
  remove(review: LocalReview): void;
  open(item: InboxItem, focus?: "checks"): void;
  busy: string | undefined;
  mayMerge: boolean;
  mayMergePull: boolean;
  mayRemove: boolean;
  mayAsk: boolean;
}

/** Why a request's merge is off, from the row's side. */
function pullMergeBlocker(item: InboxItem, act: RowActions): string | undefined {
  const entry = item.pull!.entry;
  if (!act.mayMergePull) return READ_ONLY_REASON;
  if (entry.draft) return `${numberOf(entry)} is a draft; mark it ready for review first.`;
  const uncommitted = item.review?.uncommitted ?? 0;
  if (uncommitted > 0) return `${plural(uncommitted, "file")} not committed in the worktree; ask the thread to commit and push first.`;
  return undefined;
}

/** The row's one step: Merge, Review, Ask to rebase, Ask to fix or Open; "Waiting" when the thread has it. */
function RowAction({ item, act }: { item: InboxItem; act: RowActions }) {
  const { review, pull } = item;
  const busy = act.busy === item.key;
  const button = (className: string, label: string, Icon: typeof GitMerge, run: () => void, blocked?: string, hint?: string) => (
    <button type="button" className={`rv-act${className}`} disabled={Boolean(blocked) || busy} {...tooltipProps(blocked ?? hint ?? label)} onClick={run}>
      <Icon size={13} aria-hidden="true" /><span className="rv-act-label">{busy ? `${label}…` : label}</span>
    </button>
  );
  if (item.action === "merge") {
    if (pull) {
      const target = review?.target ?? pull.entry.baseRef;
      return button(" go", "Merge", GitMerge, () => act.mergePull(item), pullMergeBlocker(item, act), `Merge ${numberOf(pull.entry)} into ${target} on its host`);
    }
    return button(" go", "Merge", GitMerge, () => act.merge(review!), !act.mayMerge ? READ_ONLY_REASON : mergeBlocker(review!), `Merge ${review!.branch} into ${review!.target}`);
  }
  if (item.action === "review") return button("", "Review", Eye, () => act.open(item));
  if (item.action === "open") return button("", "Open", ArrowUpRight, () => act.open(item), undefined, "No thread here works on it; open it to see why");
  if (item.action === "rebase" && review) return button("", "Ask to rebase", RefreshCw, () => act.rebase(review), rebaseBlocker(review, act.mayAsk), `Asks the thread to rebase onto ${review.target}`);
  if (item.action === "fix" && review) return button("", "Ask to fix", Wrench, () => act.fix(item), askBlocker(review, act.mayAsk), "Sends the thread a note with what the pull request needs");
  return <span className="rv-quiet" {...(review?.ask ? tooltipProps(review.ask.kind === "note" ? `Your note: ${review.ask.text}` : "You asked the thread to rebase.") : {})}>Waiting</span>;
}

function RowTile({ item, projects }: { item: InboxItem; projects: ReadonlyMap<string, ProjectMark> }) {
  const project = item.review?.project ?? (item.project ? projects.get(item.project) : undefined);
  return project ? <ProjectTile project={project} /> : <GitPullRequest size={14} aria-hidden="true" className="rv-tile-glyph" />;
}

function rowChanges(item: InboxItem) {
  if (item.review) return <Changes files={item.review.files} added={item.review.added} removed={item.review.removed} />;
  const entry = item.pull!.entry;
  return <Changes added={entry.additions} removed={entry.deletions} />;
}

function InboxRow({ item, projects, act }: { item: InboxItem; projects: ReadonlyMap<string, ProjectMark>; act: RowActions }) {
  return (
    <li className="rv-row" data-key={item.key} data-section={item.section}>
      <button type="button" className="rv-row-open" onClick={() => act.open(item)} aria-label={labelOf(item)}>
        <RowTile item={item} projects={projects} />
        <span className="rv-thread">
          <span className="rv-title">{titleOf(item)}</span>
          <Sub item={item} />
        </span>
        {rowChanges(item)}
        <StatusCell status={item.status} />
        <span className="rv-age">{shortAge(item.at)}</span>
      </button>
      <span className="rv-row-action"><RowAction item={item} act={act} /></span>
    </li>
  );
}

/** A phone's row (1p): title and age, the meta line, then status and changes; its one step always shows. */
function InboxCard({ item, projects, act }: { item: InboxItem; projects: ReadonlyMap<string, ProjectMark>; act: RowActions }) {
  return (
    <li className="rv-card" data-key={item.key} data-section={item.section}>
      <button type="button" className="rv-card-open" onClick={() => act.open(item)} aria-label={labelOf(item)}>
        <span className="rv-card-line">
          <RowTile item={item} projects={projects} />
          <span className="rv-title">{titleOf(item)}</span>
          <span className="rv-age">{shortAge(item.at)}</span>
        </span>
        <Sub item={item} />
        <span className="rv-card-line">
          <StatusCell status={item.status} />
          {rowChanges(item)}
        </span>
      </button>
      <span className="rv-card-action"><RowAction item={item} act={act} /></span>
    </li>
  );
}

/** The tabs of a phone and of a page without its sidebar. */
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

/** Up and down step through the rows (the focus is the selection), Home and End to the ends; Enter opens the focused one. */
function moveRow(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || (event.target as HTMLElement).closest("input, textarea, select")) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(".rv-row-open, .rv-card-open")];
  if (rows.length === 0) return;
  event.preventDefault();
  const at = rows.findIndex((row) => row.closest("li")?.contains(document.activeElement));
  const next = event.key === "Home" ? 0
    : event.key === "End" ? rows.length - 1
    : at < 0 ? (event.key === "ArrowDown" ? 0 : rows.length - 1)
    : Math.min(rows.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)));
  rows[next]?.focus();
}

type InboxProject = ProjectMark & { open: number };

/**
 * The inbox from the window's reviews and every project's open requests, and
 * the projects with how many of its rows each has, for the sidebar's filter.
 */
function useInbox(parts: ReviewsPageParts) {
  const { pulls, sections, total, ...local } = useInboxRows(parts.store, parts.pulls);
  const marks = useMemo(() => new Map(pulls.projects.map((project) => [projectId(project), markOf(project)])), [pulls.projects]);
  const projects = useMemo((): InboxProject[] => {
    const listed = new Map<string, InboxProject>(local.counts.projects.map((entry) => [entry.key, { ...entry, open: 0 }]));
    for (const item of sections.flatMap((section) => section.items)) {
      if (!item.project) continue;
      const mark = item.review?.project ?? marks.get(item.project);
      const entry = listed.get(item.project) ?? (mark ? { ...mark, open: 0 } : undefined);
      if (!entry) continue;
      entry.open += 1;
      listed.set(item.project, entry);
    }
    return [...listed.values()].sort((left, right) => right.open - left.open || left.name.localeCompare(right.name));
  }, [local.counts.projects, sections, marks]);
  return { ...local, pulls, sections, projects, marks, total };
}

/**
 * The page's sidebar (1i), in Settings' column: Inbox, Merged and All pull
 * requests, then the projects with their open rows as a filter.
 */
export function ReviewsSidebar({ params, navigate, parts }: PageProps & { parts: ReviewsPageParts }) {
  const { total, projects } = useInbox(parts);
  const list = useRef<HTMLDivElement>(null);
  const tab = tabOf(params.tab);
  const project = text(params.project);
  const inDetail = Boolean(params.review) || Boolean(params.url);
  // Out of a detail, into what the page lists.
  const select = (next: ReviewTab, nextProject?: string) => navigate({ tab: next, ...(nextProject ? { project: nextProject } : {}) }, { root: true, replace: true });
  const item = (key: string, active: boolean, label: string, icon: ReactNode, figure: number, onSelect: () => void, hint?: string) => (
    <button key={key} type="button" className={active ? "active" : undefined} aria-current={active ? "page" : undefined} {...(hint ? tooltipProps(hint, { side: "right" }) : {})} onClick={onSelect}>
      {icon}<span className="rv-nav-label">{label}</span>{figure ? <small className="rv-nav-count">{figure}</small> : null}
    </button>
  );
  // A review open: the sidebar is the review's own (1e), and the way back is its own too.
  if (inDetail) {
    return <ReviewDetailSidebar store={parts.detail.store} detailKey={text(params.review) ?? text(params.url) ?? ""} backLabel={TAB_LABELS[tab].nav} back={() => select(tab, tab === "remote" ? undefined : project)} />;
  }
  return (
    <div className="settings-nav-list rv-sidebar" ref={list} onKeyDown={(event) => moveFocus(event, list.current)}>
      <div className="settings-nav-group" role="group" aria-label="Review">
        <h2 className="settings-nav-heading">Review</h2>
        {TABS.map((entry) => {
          const Icon = TAB_ICONS[entry];
          return item(entry, entry === tab && !project, TAB_LABELS[entry].nav, <Icon size={14} aria-hidden="true" />, entry === "inbox" ? total : 0, () => select(entry));
        })}
      </div>
      {projects.length > 0 ? (
        <div className="settings-nav-group" role="group" aria-label="Projects">
          <h2 className="settings-nav-heading">Projects</h2>
          {projects.map((entry) => item(entry.key, project === entry.key, entry.name, <ProjectTile project={entry} />, entry.open, () => select(tab === "remote" ? "inbox" : tab, entry.key), entry.name))}
        </div>
      ) : null}
    </div>
  );
}

/** A narrow page's project filter beside the tabs, with the open rows of each. */
function ProjectFilter({ project, projects, select }: { project?: string; projects: readonly InboxProject[]; select(project?: string): void }) {
  if (projects.length < 2 && !project) return null;
  return (
    <select className="rv-project-filter" aria-label="Project" value={project ?? ""} onChange={(event) => select(event.target.value || undefined)}>
      <option value="">All projects</option>
      {projects.map((entry) => <option key={entry.key} value={entry.key}>{entry.name}{entry.open ? ` · ${entry.open}` : ""}</option>)}
    </select>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="rv-section" aria-label={title}>
      <h3><b>{title}</b>{count}</h3>
      <ul>{children}</ul>
    </section>
  );
}

/** Rows that stand in for the list while it is read, in the list's own grid. */
function GhostRows({ compact }: { compact: boolean }) {
  return (
    <ul className="rv-ghosts" aria-busy="true" aria-label="Loading reviews">
      {[0, 1, 2].map((index) => compact ? <li key={index} className="rv-card rv-ghost"><Skeleton className="rv-ghost-card" /></li> : (
        <li key={index} className="rv-row rv-ghost">
          <span className="rv-row-open">
            <Skeleton className="rv-ghost-tile" />
            <span className="rv-thread"><Skeleton className="rv-ghost-line" /><Skeleton className="rv-ghost-line short" /></span>
            <Skeleton className="rv-ghost-line" />
            <Skeleton className="rv-ghost-line" />
            <span />
          </span>
          <span className="rv-row-action" />
        </li>
      ))}
    </ul>
  );
}

/** One project whose local target trails origin, for the head's line. */
interface StaleTarget { project: ProjectMark; target: string; compared: string; behind: number; ahead?: number }

function staleTargets(reviews: readonly LocalReview[]): StaleTarget[] {
  const found = new Map<string, StaleTarget>();
  for (const review of reviews) {
    if (review.state === "merged" || !review.comparedRef || !review.targetBehind) continue;
    const key = `${review.project.key}\n${review.target}`;
    if (!found.has(key)) found.set(key, { project: review.project, target: review.target, compared: review.comparedRef, behind: review.targetBehind, ...(review.targetAhead ? { ahead: review.targetAhead } : {}) });
  }
  return [...found.values()];
}

function StaleLine({ stale, named, update, busy, allowed }: { stale: StaleTarget; named: boolean; update(stale: StaleTarget): void; busy: boolean; allowed: boolean }) {
  const lead = named ? `${stale.project.name}: compared` : "Compared";
  if (stale.ahead) return <p>{lead} with {stale.compared} — local {stale.target} has {plural(stale.ahead, "commit")} {stale.compared} lacks.</p>;
  return (
    <p>
      {lead} with {stale.compared} — local {stale.target} is {plural(stale.behind, "commit")} behind.{" "}
      <button type="button" className="rv-head-link" disabled={busy || !allowed} {...tooltipProps(allowed ? `Fast-forwards ${stale.target} to ${stale.compared}` : READ_ONLY_REASON)} onClick={() => update(stale)}>
        {busy ? `Updating ${stale.target}…` : `Update ${stale.target}`}
      </button>
    </p>
  );
}

/** A note on a diff line being written, or `{}` for a note on the whole review. */
type NoteDraft = { path?: string; line?: number; side?: "new" | "old"; code?: string };

/**
 * One review on a phone (1q, 2o): what the thread said it did, the files with
 * the first one's diff open, notes on its lines kept for later or sent at
 * once, and Request changes and Merge fixed at the bottom.
 */
function ReviewDetail({ review, parts, act, actions }: { review: LocalReview; parts: ReviewsPageParts; act: RowActions; actions: WorkbenchActions }) {
  const [summary, setSummary] = useState<{ summary?: string; turns?: number }>();
  const [open, setOpen] = useState<string | undefined>(() => review.paths[0]?.path);
  const [draft, setDraft] = useState<NoteDraft>();
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [removing, setRemoving] = useState(false);
  const noteKey = `local:${review.key}`;
  const runs = parts.store.latestRuns(review.path ?? "");
  const notes = parts.detail.notes;
  const held = useSyncExternalStore(notes.subscribe, () => notes.comments(noteKey));
  let threads: ReturnType<typeof useThreadStore> | undefined;
  try { threads = useThreadStore(); } catch { threads = undefined; }
  useEffect(() => {
    let live = true;
    setSummary(undefined);
    parts.store.summary(review).then((answer) => { if (live) setSummary(answer); }, () => { if (live) setSummary({}); });
    return () => { live = false; };
  }, [parts.store, review.key, review.tip]); // eslint-disable-line react-hooks/exhaustive-deps
  const blocked = !act.mayMerge ? READ_ONLY_REASON : mergeBlocker(review);
  const asked = askBlocker(review, act.mayAsk);
  const thread = review.threadId ? threads?.getThread(review.threadId) : undefined;
  const write = (next: NoteDraft | undefined) => { setDraft(next); setNote(""); };
  // Held notes go as one turn with what their lines show; a note on the whole review goes as it is.
  const send = async (list: readonly PendingReviewComment[], plain?: string) => {
    setSending(true);
    try {
      await parts.store.ask(review, "note", plain ?? noteMessage(list), list.map(({ id, path, line, side, body }) => ({ id, note: id, path, line, side, body })));
      for (const entry of list) notes.remove(noteKey, entry.id);
      write(undefined);
      actions.toast?.({ type: "success", title: "Sent to the thread", description: review.title });
    } catch (error) {
      actions.toast?.({ type: "error", title: "The note was not sent", description: errorMessage(error) });
    } finally {
      setSending(false);
    }
  };
  const lineOf = (entry: { path?: string; line?: number; side?: string }, path: string, line: UiDiffLine) => {
    const target = lineTarget(line);
    return entry.path === path && entry.line === target?.line && entry.side === target?.side;
  };
  const slot = (path: string): DiffLineSlot | undefined => asked ? undefined : {
    onAction: ({ line }) => { const target = lineTarget(line); if (target) write({ path, ...target, code: lineText(line) }); },
    actionLabel: ({ line }) => `Note on line ${lineTarget(line)?.line ?? ""}`,
    count: ({ line }) => held.filter((entry) => lineOf(entry, path, line)).length,
    selected: ({ line }) => Boolean(draft && lineOf(draft, path, line)),
  };
  const body = note.trim();
  const lineNote = draft?.path ? { id: crypto.randomUUID(), path: draft.path, line: draft.line!, side: draft.side!, body, ...(draft.code ? { code: draft.code } : {}) } : undefined;
  return (
    <article className="rv-detail" aria-label={review.title}>
      <p className="rv-detail-sub">
        <span className="rv-mono">{review.branch}<Into review={review} /></span>
        <span aria-hidden="true">·</span>
        <Changes added={review.added} removed={review.removed} />
        <span aria-hidden="true">·</span>
        <Model review={review} />
      </p>
      {summary === undefined ? <Skeleton className="rv-summary-skeleton" /> : summary.summary ? <div className="rv-summary"><Markdown>{summary.summary}</Markdown></div> : <p className="rv-summary muted">The thread left no summary.</p>}
      <p className="rv-meta">
        <strong>{plural(review.files, "file")}</strong>
        {summary?.turns ? <span>{plural(summary.turns, "turn")}</span> : null}
        <Checks runs={runs} />
        {review.uncommitted ? <span className="warn">{review.uncommitted} not committed</span> : null}
        {review.behind ? <span>{plural(review.behind, "commit")} behind {review.comparedRef ?? review.target}</span> : null}
        {review.comparedRef && review.targetBehind ? <span>{review.target} is {plural(review.targetBehind, "commit")} behind {review.comparedRef}</span> : null}
      </p>
      {runs.length ? <PipelineGraph pipelines={[runsPipeline(runs)]} actions={actions} /> : null}
      {review.ask ? (
        <div className="rv-ask-open" role="status">
          {review.ask.kind === "note" ? <MessageSquare size={13} aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
          <span>{review.ask.kind === "note" ? <>Your note: {review.ask.text}</> : "You asked the thread to rebase."} It shows here until the thread commits again.</span>
          <button type="button" disabled={!act.mayAsk} onClick={() => { void parts.store.withdraw(review).catch((error) => actions.notify(errorMessage(error), "error")); }}>Withdraw</button>
        </div>
      ) : null}
      {review.request && review.state === "merged" ? <p className="rv-already" role="status"><GitMerge size={13} aria-hidden="true" /> Integrated into {review.target} through <a href={review.request.url} target="_blank" rel="noreferrer">{requestLabelOf(review.request.url, review.request.number)}</a>.</p>
        : review.mergedBy ? <p className="rv-already" role="status"><GitMerge size={13} aria-hidden="true" /> Already in {review.target}: {ALREADY[review.mergedBy]}</p> : null}
      {review.state !== "merged" && review.mergeBlocked ? <p className="rv-already" role="status">{review.mergeBlocked}</p> : null}
      {review.conflicts.length > 0 ? (
        <p className="rv-conflicts" role="status"><TriangleAlert size={13} aria-hidden="true" /> Conflicts with {review.target} in {review.conflicts.slice(0, 6).join(", ")}{review.conflicts.length > 6 ? " …" : ""}</p>
      ) : null}
      <ul className="rv-files-list" aria-label="Files">
        {review.paths.map((file) => (
          <li key={file.path} className={open === file.path ? "open" : undefined}>
            <button type="button" aria-expanded={open === file.path} title={file.path} onClick={() => setOpen(open === file.path ? undefined : file.path)} disabled={!review.workspace}>
              <FileKindIcon name={file.path} />
              <span className="rv-file-path">{baseName(file.path)}</span>
              <span className="rv-changes">{file.added ? <span className="stat-add">+{file.added}</span> : null}{file.removed ? <span className="stat-del">−{file.removed}</span> : null}</span>
              <ChevronRight size={13} aria-hidden="true" className="rv-chevron" />
            </button>
            {open === file.path && review.workspace ? <FileDiff host={parts.host} review={review} path={file.path} lines={slot(file.path)} /> : null}
          </li>
        ))}
        {review.files > review.paths.length && review.paths.length > 0 ? <li className="rv-more">and {plural(review.files - review.paths.length, "more file")}</li> : null}
      </ul>
      {held.length > 0 ? (
        <section className="rv-held" aria-label="Review notes">
          <header>
            <span>Review notes · {held.length}</span>
            <button type="button" className="text-button" disabled={sending || Boolean(asked)} onClick={() => { void send(held); }}>{held.length === 1 ? "Send" : held.length === 2 ? "Send both" : `Send all ${held.length}`}</button>
          </header>
          {held.map((entry) => (
            <p key={entry.id}>
              <code>{baseName(entry.path)}:{entry.line}</code><span>{entry.body}</span>
              <button type="button" aria-label="Remove note" onClick={() => notes.remove(noteKey, entry.id)}><X size={14} /></button>
            </p>
          ))}
        </section>
      ) : null}
      {thread ? <button type="button" className="rv-open-thread" onClick={() => { void actions.switchSession(thread.path); }}>Open thread</button> : null}
      {draft ? (
        <div className="rv-compose">
          <span className="rv-compose-where">
            <MessageSquare size={13} aria-hidden="true" />
            <span>{draft.path ? `${baseName(draft.path)}:${draft.line}` : "Request changes"}</span>
            <button type="button" aria-label="Cancel the note" onClick={() => write(undefined)}><X size={16} /></button>
          </span>
          <textarea autoFocus value={note} placeholder={draft.path ? "What should change on this line?" : "What should the thread change?"} aria-label="Note to the thread" onChange={(event) => setNote(event.target.value)} rows={2} />
          <div>
            {lineNote ? <button type="button" className="text-button" disabled={!body} onClick={() => { const { id: _id, ...kept } = lineNote; notes.add(noteKey, kept); write(undefined); }}>Keep for later</button> : null}
            <button type="button" className="primary" disabled={!body || sending} onClick={() => { void send(lineNote ? [lineNote] : [], lineNote ? undefined : body); }}><ArrowUp size={14} aria-hidden="true" /> {sending ? "Sending…" : "Send now"}</button>
          </div>
        </div>
      ) : review.state !== "merged" ? (
        <div className="rv-detail-actions rv-bar">
          <button type="button" disabled={Boolean(asked)} {...tooltipProps(asked ?? "Send the thread a note on what to change")} onClick={() => write({})}>
            <MessageSquare size={14} aria-hidden="true" /> Request changes
          </button>
          {review.state === "conflicts" ? (
            <button type="button" className="rv-merge" disabled={Boolean(rebaseBlocker(review, act.mayAsk)) || act.busy === review.key} {...tooltipProps(rebaseBlocker(review, act.mayAsk) ?? `Asks the thread to rebase onto ${review.target}`)} onClick={() => act.rebase(review)}>
              <RefreshCw size={14} aria-hidden="true" /> Ask to rebase
            </button>
          ) : (
            <button type="button" className="rv-merge" disabled={Boolean(blocked) || act.busy === review.key} {...tooltipProps(blocked ?? `Merge ${review.branch} into ${review.target} (a merge commit, after checking it merges cleanly)`)} onClick={() => act.merge(review)}>
              <GitMerge size={14} aria-hidden="true" /> {act.busy === review.key ? "Merging…" : "Merge"}
            </button>
          )}
        </div>
      ) : removing && review.path ? (
        <div className="rv-detail-actions" role="group" aria-label="Remove">
          <span>Remove the worktree and delete {review.branch}? The threads stay.</span>
          <button type="button" onClick={() => setRemoving(false)}>Cancel</button>
          <button type="button" className="danger" disabled={act.busy === review.key} onClick={() => act.remove(review)}>{act.busy === review.key ? "Removing…" : "Remove"}</button>
        </div>
      ) : review.path && review.workspace && !review.remote ? (
        <div className="rv-detail-actions">
          <button type="button" disabled={!act.mayRemove} {...tooltipProps(act.mayRemove ? `Removes the worktree and deletes ${review.branch}; ${review.target} holds its work` : READ_ONLY_REASON)} onClick={() => setRemoving(true)}>
            <Trash2 size={14} aria-hidden="true" /> Remove worktree and branch
          </button>
        </div>
      ) : null}
    </article>
  );
}

function FileDiff({ host, review, path, lines }: { host: HostExtensionClient; review: LocalReview; path: string; lines?: DiffLineSlot | undefined }) {
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
  return <div className="rv-diff"><DiffView diff={diff} mode="unified" path={path} wrap {...(lines ? { lines } : {})} /></div>;
}

const EMPTY_TEXT: Record<"inbox" | "merged", { title: string; description: string }> = {
  inbox: { title: "Nothing waiting", description: "A thread's finished branch lands here, with the pull requests that need you: yours to merge or fix, and others' you are asked to review." },
  merged: { title: "Nothing merged yet", description: "A branch you merge from here is listed after it." },
};

/**
 * The Reviews page: the inbox of the threads' branches and the pull requests
 * that need the user (1i, 1p, 1q), what was merged, and every project's pull
 * requests. Its sidebar picks what it lists; without one, tabs over the list do.
 */
export function ReviewsPage({ params, navigate, actions, close, parts, sidebar = false }: PageProps & { parts: ReviewsPageParts }) {
  const compact = useCompactProfile();
  const { reviews, snapshot, sections, projects, marks, total, pulls } = useInbox(parts);
  const filter = useSyncExternalStore(parts.filter.subscribe, parts.filter.getSnapshot);
  const [busy, setBusy] = useState<string>();
  const [merging, setMerging] = useState<InboxItem>();
  const [updating, setUpdating] = useState<string>();
  const mayMerge = useCommandAllowed(REVIEW_HOST_EXTENSION_ID, "local-review-merge");
  const mayAsk = useCommandAllowed(REVIEW_HOST_EXTENSION_ID, "local-review-ask");
  const mayRemove = useCommandAllowed(REVIEW_HOST_EXTENSION_ID, "local-review-remove");
  const mayMergePull = useCommandAllowed(REVIEW_HOST_EXTENSION_ID, "pr-action");
  const mayUpdate = useCommandAllowed(REVIEW_HOST_EXTENSION_ID, "local-review-update-target");
  const tab = tabOf(params.tab);
  const project = text(params.project);
  const detailKey = text(params.review);
  const detailUrl = tab === "remote" ? undefined : text(params.url);
  const store = parts.store;
  useEffect(() => { void store.refresh(); }, [store]);

  const select = (next: ReviewTab, nextProject?: string) => navigate({ tab: next, ...(nextProject ? { project: nextProject } : {}) }, { replace: true });
  const scroller = useRef<HTMLDivElement>(null);
  // Where the list was when a row opened: back from it, the same row has the focus and the list its scroll.
  const left = useRef<{ key: string; top: number }>(undefined);
  const here = { tab, ...(project ? { project } : {}) };
  const openReview = (review: LocalReview, focus?: "checks") => {
    left.current = { key: review.key, top: scroller.current?.scrollTop ?? 0 };
    navigate({ ...here, review: review.key, ...(focus ? { focus } : {}) }, { label: review.title });
  };
  const openPull = (item: InboxItem) => {
    const entry = item.pull!.entry;
    const workspace = item.pull!.workspaces[0];
    left.current = { key: item.key, top: scroller.current?.scrollTop ?? 0 };
    navigate({ ...here, url: entry.ref.url, number: entry.ref.number, service: entry.ref.service, ...(workspace ? { workspace } : {}) }, { label: `${numberOf(entry)} ${entry.title}` });
  };
  const listed = !detailKey && !detailUrl && tab !== "remote" && Boolean(snapshot.answer);
  useLayoutEffect(() => {
    const from = left.current;
    if (!listed || !from || !scroller.current) return;
    left.current = undefined;
    scroller.current.scrollTop = from.top;
    const row = [...scroller.current.querySelectorAll<HTMLElement>("li[data-key]")].find((item) => item.dataset.key === from.key);
    row?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, [listed]);

  const reloadPulls = () => { void parts.pulls.load(pulls.machines, true); };
  const act: RowActions = {
    busy,
    mayMerge,
    mayMergePull,
    mayAsk,
    mayRemove,
    open: (item, focus) => item.review ? openReview(item.review, focus) : openPull(item),
    merge: (review, picks) => {
      setBusy(review.key);
      void store.merge(review, picks).then((outcome) => {
        if (outcome.state === "merged" || outcome.state === "already-merged") actions.toast?.({ type: "success", title: `Merged ${review.branch} into ${outcome.into}`, description: review.title });
        else actions.toast?.({ type: "warning", title: outcome.state === "conflict" ? "Not merged: conflicts" : "Not merged", description: outcome.detail });
      }, (error) => actions.toast?.({ type: "error", title: `${review.branch} was not merged`, description: errorMessage(error) })).finally(() => { setBusy(undefined); void store.refresh(); });
    },
    mergePull: (item) => setMerging(item),
    rebase: (review) => {
      setBusy(review.key);
      void store.ask(review, "rebase").then(
        () => actions.toast?.({ type: "success", title: "Asked the thread to rebase", description: review.title }),
        (error) => actions.toast?.({ type: "error", title: "The thread was not asked", description: errorMessage(error) }),
      ).finally(() => setBusy(undefined));
    },
    fix: (item) => {
      const review = item.review!;
      setBusy(item.key);
      void store.ask(review, "note", fixRequest(item.pull!.entry)).then(
        () => actions.toast?.({ type: "success", title: "Sent to the thread", description: review.title }),
        (error) => actions.toast?.({ type: "error", title: "The note was not sent", description: errorMessage(error) }),
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
  const update = (stale: StaleTarget) => {
    const key = `${stale.project.key}\n${stale.target}`;
    setUpdating(key);
    void store.updateTarget(stale.project.key, stale.target).then(
      (done) => actions.toast?.({ type: "success", title: `${stale.target} is up to date with ${stale.compared}`, description: `${stale.project.name}: ${plural(done.commits, "commit")} fast-forwarded.` }),
      (error) => actions.toast?.({ type: "error", title: `${stale.target} was not updated`, description: errorMessage(error) }),
    ).finally(() => { setUpdating(undefined); void store.refresh(); });
  };

  const needle = filter.trim().toLowerCase();
  const matches = (words: ReadonlyArray<string | undefined>) => !needle || words.join("\n").toLowerCase().includes(needle);
  const shownSections = useMemo(() => sections.map((section) => ({
    ...section,
    items: section.items.filter((item) => (!project || item.project === project) && matches([
      titleOf(item), item.review?.branch, item.review?.project.name, item.pull?.entry.headRef, item.pull?.entry.author?.login,
      item.pull ? numberOf(item.pull.entry) : undefined, item.project ? marks.get(item.project)?.name : undefined,
    ])),
  })).filter((section) => section.items.length > 0), [sections, project, needle, marks]); // eslint-disable-line react-hooks/exhaustive-deps
  const merged = useMemo(() => reviews.filter((review) => review.state === "merged" && (!project || review.project.key === project)
    && matches([review.title, review.branch, review.project.name])), [reviews, project, needle]); // eslint-disable-line react-hooks/exhaustive-deps

  const detail = detailKey ? reviews.find((review) => review.key === detailKey) : undefined;
  const month = mergedThisMonth(reviews);
  const projectName = (workspace: string) => marks.get(workspace)?.name ?? projects.find((entry) => entry.key === workspace)?.name;
  const failures = pulls.answer?.failures ?? [];
  const footer = (
    <ReviewsFooter>
      {[
        <span key="month">{month.count} merged this month{month.costUsd > 0 ? ` · ${formatCost(month.costUsd)}` : ""}</span>,
        failures.length ? <ReadFailures key="failures" failures={failures} name={projectName} /> : null,
        pulls.error ? (
          <span key="error" className="rv-failures">
            <span {...tooltipProps(pulls.error)}>Pull requests not read</span>
            <button type="button" className="rv-foot-link" onClick={reloadPulls}>Retry</button>
          </span>
        ) : pulls.loading && !pulls.answer ? <span key="loading" className="rv-failures"><Spinner size="xs" label="Reading pull requests" /> Reading pull requests</span> : null,
      ]}
    </ReviewsFooter>
  );
  const row = (item: InboxItem) => compact
    ? <InboxCard key={item.key} item={item} projects={marks} act={act} />
    : <InboxRow key={item.key} item={item} projects={marks} act={act} />;
  const mergedItem = (review: LocalReview): InboxItem => ({ key: review.key, section: "ready", review, status: mergedStatus(review), action: "wait", project: review.project.key, at: review.at });
  const mergedRow = (review: LocalReview) => {
    const item = mergedItem(review);
    return compact ? (
      <li key={review.key} className="rv-card" data-key={review.key} data-state="merged">
        <button type="button" className="rv-card-open" onClick={() => openReview(review)} aria-label={labelOf(item)}>
          <span className="rv-card-line"><ProjectTile project={review.project} /><span className="rv-title">{review.title}</span><span className="rv-age">{shortAge(review.at)}</span></span>
          <Sub item={item} />
          <span className="rv-card-line"><StatusCell status={item.status} />{rowChanges(item)}</span>
        </button>
      </li>
    ) : (
      <li key={review.key} className="rv-row" data-key={review.key} data-state="merged">
        <button type="button" className="rv-row-open" onClick={() => openReview(review)} aria-label={labelOf(item)}>
          <ProjectTile project={review.project} />
          <span className="rv-thread"><span className="rv-title">{review.title}</span><Sub item={item} /></span>
          {rowChanges(item)}
          <StatusCell status={item.status} />
          <span className="rv-age">{shortAge(review.at)}</span>
        </button>
        <span className="rv-row-action" />
      </li>
    );
  };

  let body: ReactNode;
  if (tab === "remote") {
    body = (
      <Suspense fallback={<div className="stage-empty" role="status"><Spinner size="sm" label="Loading pull requests" /></div>}>
        <PullRequestsPage key={typeof params.threadId === "string" ? params.threadId : "remote"} params={params} navigate={(next, options) => navigate({ ...next, tab: "remote" }, options)} actions={actions} close={close} parts={parts.remote} />
      </Suspense>
    );
  } else if (detailUrl) {
    body = (
      <Suspense fallback={<div className="stage-empty" role="status"><Spinner size="sm" label="Loading the pull request" /></div>}>
        <PullRequestDetailPane params={params} actions={actions} parts={parts.remote} back={() => navigate(here, { root: true, replace: true })} />
      </Suspense>
    );
  } else if (detailKey) {
    body = detail
      ? compact
        ? <ReviewDetail review={detail} parts={parts} act={act} actions={actions} />
        : (
          <Suspense fallback={<Skeleton className="rv-row-skeleton" />}>
            <LocalReviewDetail review={detail} parts={parts} detail={parts.detail} act={act} actions={actions} focus={params.focus === "checks" ? "checks" : undefined} back={() => navigate(here, { root: true, replace: true })} />
          </Suspense>
        )
      : snapshot.answer ? <Empty title="This review is gone" description="Its branch was removed, or its thread started working again." /> : <Skeleton className="rv-row-skeleton" />;
  } else if (!snapshot.answer) {
    body = snapshot.error
      ? <Empty icon={<TriangleAlert size={18} />} title="Reviews could not be read" description={snapshot.error}><button type="button" onClick={() => { void store.refresh(); }}>Retry</button></Empty>
      : <GhostRows compact={compact} />;
  } else if (tab === "merged") {
    body = merged.length === 0
      ? <Empty icon={<GitMerge size={18} />} title={needle ? "Nothing matches" : EMPTY_TEXT.merged.title} description={needle ? "Try other words, or clear the filter." : EMPTY_TEXT.merged.description} />
      : <Section title="Merged" count={merged.length}>{merged.map(mergedRow)}</Section>;
  } else {
    body = shownSections.length === 0
      ? <Empty icon={<Inbox size={18} />} title={needle ? "Nothing matches" : EMPTY_TEXT.inbox.title} description={needle ? "Try other words, or clear the filter." : EMPTY_TEXT.inbox.description} />
      : shownSections.map((section) => <Section key={section.id} title={section.title} count={section.items.length}>{section.items.map(row)}</Section>);
  }

  const inDetail = Boolean(detailKey) || Boolean(params.url);
  const count = (entry: ReviewTab) => entry === "inbox" ? total : 0;
  const inList = !inDetail && !compact;
  const stale = tab === "inbox" ? staleTargets(project ? reviews.filter((review) => review.project.key === project) : reviews) : [];
  const named = new Set(reviews.filter((review) => review.state !== "merged").map((review) => review.project.key)).size > 1 && !project;
  const heading = project ? projects.find((entry) => entry.key === project)?.name ?? TAB_LABELS[tab].title : TAB_LABELS[tab].title;
  return (
    <div className={`rv-page${compact ? " compact" : ""}`} data-tab={tab} data-view={inList ? "list" : undefined}>
      <div className={`rv-main${tab === "remote" || ((detailKey || detailUrl) && !compact) ? " remote" : ""}`}>
        {inDetail || sidebar ? null : (
          <div className="rv-tabs-row">
            <Tabs tab={tab} count={count} select={(next) => select(next, next === "remote" ? undefined : project)} />
            {compact || tab === "remote" ? null : <ProjectFilter {...(project ? { project } : {})} projects={projects} select={(next) => select(tab, next)} />}
          </div>
        )}
        {inList && tab !== "remote" ? (
          <header className="rv-head">
            <div>
              <h2>{heading}</h2>
              {stale.map((entry) => <StaleLine key={`${entry.project.key}\n${entry.target}`} stale={entry} named={named} update={update} busy={updating === `${entry.project.key}\n${entry.target}`} allowed={mayUpdate} />)}
            </div>
            <label className="rv-filter">
              <Search size={13} aria-hidden="true" />
              <input
                type="search"
                value={filter}
                placeholder="Filter"
                aria-label="Filter reviews"
                onChange={(event) => parts.filter.set(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && filter) { event.preventDefault(); event.stopPropagation(); parts.filter.set(""); }
                  else if (event.key === "ArrowDown") { event.preventDefault(); event.currentTarget.closest(".rv-main")?.querySelector<HTMLElement>(".rv-row-open, .rv-card-open")?.focus(); }
                }}
              />
            </label>
          </header>
        ) : null}
        <div className="rv-scroll" ref={scroller} onKeyDown={tab === "remote" || inDetail ? undefined : moveRow}>{body}</div>
        {tab === "remote" || inDetail ? null : footer}
      </div>
      {merging?.pull ? (
        <Suspense fallback={null}>
          <PullMergeDialog
            entry={merging.pull.entry}
            client={parts.remote.client}
            preferences={parts.remote.shared?.preferences}
            allowed={mayMergePull}
            onClose={() => setMerging(undefined)}
            onDone={(message) => {
              setMerging(undefined);
              actions.toast?.({ type: "success", title: message, description: titleOf(merging) });
              reloadPulls();
              void store.refresh();
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

export default ReviewsPage;
