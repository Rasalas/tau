import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowDownUp,
  Layers,
  CircleCheck,
  CircleDashed,
  ChevronDown,
  CircleX,
  Folder,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  ListFilter,
  RefreshCw,
  Search,
  TriangleAlert,
} from "lucide-react";
import { Empty, errorMessage, getClientStorage, Menu, SettingsPageAction, Skeleton, Spinner, useThreadStore, type MenuSection, type StageTabHandle, type ThreadStore, type UiProject, type WorkbenchActions } from "tau";
import { REVIEWS_PAGE } from "./local-reviews.js";
import { providerInfo, type PullRequestList, type PullRequestListEntry, type PullRequestListState, type PullRequestLists } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";
import {
  arrangeList,
  decodeListPreferences,
  groupByRepository,
  listFacets,
  scoreMatch,
  type PullRequestInvolvement,
  type PullRequestListFilters,
  type PullRequestListPreferences,
  type PullRequestListSort,
  SORTS,
  type PullRequestSection,
} from "./pull-request-list-logic.js";
import { hostName, relativeTime, shortNoun } from "./pull-request-logic.js";
import { INVOLVEMENTS, listNarrowings, NarrowingChips, PullRequestFilterSheet, REVIEW_LABELS, SORT_LABELS, STATES, type FilterGroup } from "./pull-request-list-filters.js";
import { useCompactProfile } from "./compact-profile.js";

const PREFERENCES_KEY = "tau.review.pull-requests";
const GROUPING_KEY = "tau.review.pull-requests.group";
const PAGE = 100;
const MAX_LIMIT = 500;
/** A search goes to the host once typing pauses this long. */
const SEARCH_DELAY_MS = 350;

export interface PullRequestsTabParams extends Record<string, unknown> {
  /** The project whose repository the page lists; the active thread's when absent. */
  workspace?: string;
  /** `"all"` lists every project's repository, across hosts. */
  scope?: "all";
}

/** What the page shows: one project's repository, or every project's. */
type Scope = { kind: "project"; workspace?: string } | { kind: "all" };

/** The page's rows from one repository or many, each row with its host's viewer. */
interface Listing {
  service: PullRequestList["service"];
  /** Every repository listed, `host/repo`. */
  repositories: string[];
  host: string;
  repo: string;
  viewer?: string;
  entries: PullRequestListEntry[];
  truncated: boolean;
  /** Projects whose repository could not be read, by name. */
  failures: Array<{ workspace: string; message: string }>;
  /** The project to open a row's request in, by `host/repo`. */
  workspaces: Map<string, string>;
}

export function singleListing(list: PullRequestList, workspace?: string): Listing {
  const key = `${list.host}/${list.repo}`;
  return { service: list.service, repositories: [key], host: list.host, repo: list.repo, ...(list.viewer ? { viewer: list.viewer } : {}), entries: list.entries, truncated: list.truncated, failures: [], workspaces: new Map(workspace ? [[key, workspace]] : []) };
}

/** Many repositories' lists as one: every row keeps the login of its own host for "Authored". */
export function mergedListing(answer: PullRequestLists): Listing | undefined {
  const [first] = answer.lists;
  if (!first) return undefined;
  return {
    service: first.service,
    repositories: answer.lists.map((list) => `${list.host}/${list.repo}`),
    host: first.host,
    repo: first.repo,
    entries: answer.lists.flatMap((list) => list.entries.map((entry) => list.viewer ? { ...entry, viewer: list.viewer } : entry)),
    truncated: answer.lists.some((list) => list.truncated),
    failures: answer.failures,
    workspaces: new Map(answer.lists.flatMap((list) => list.workspaces[0] ? [[`${list.host}/${list.repo}`, list.workspaces[0]] as const] : [])),
  };
}

/** The projects the window knows, once per workspace; outside a workbench there are none. */
function useProjects(): readonly UiProject[] {
  let store: ThreadStore | undefined;
  try { store = useThreadStore(); } catch { store = undefined; }
  const [projects, setProjects] = useState<readonly UiProject[]>(() => store?.getProjects() ?? []);
  useEffect(() => store?.subscribeToProjects(() => setProjects(store!.getProjects())), [store]);
  return projects;
}

const projectId = (project: UiProject) => project.workspaceId ?? project.path;

function StateGlyph({ entry }: { entry: PullRequestListEntry }) {
  const props = { size: 14, "aria-hidden": true } as const;
  if (entry.state === "merged") return <GitMerge {...props} className="pr-glyph merged" />;
  if (entry.state === "closed") return <GitPullRequestClosed {...props} className="pr-glyph closed" />;
  if (entry.draft) return <GitPullRequestDraft {...props} className="pr-glyph draft" />;
  return <GitPullRequest {...props} className="pr-glyph open" />;
}

function ChecksGlyph({ checks }: { checks: PullRequestListEntry["checks"] }) {
  if (!checks) return null;
  const title = checks === "passing" ? "Checks passing" : checks === "failing" ? "Checks failing" : "Checks running";
  const Icon = checks === "passing" ? CircleCheck : checks === "failing" ? CircleX : CircleDashed;
  return <span className={`pr-row-checks ${checks}`} title={title} aria-label={title}><Icon size={11} aria-hidden="true" /></span>;
}

function ReviewGlyph({ decision }: { decision: PullRequestListEntry["reviewDecision"] }) {
  if (!decision) return null;
  return <span className={`pr-row-review ${decision}`} title={REVIEW_LABELS[decision]}>{REVIEW_LABELS[decision]}</span>;
}

/** One request: the state and checks glyphs, then number, title and counts over author, labels and time. */
const PullRequestRow = memo(function PullRequestRow({ entry, matchedElsewhere, showRepository, onOpen }: { entry: PullRequestListEntry; matchedElsewhere: boolean; showRepository: boolean; onOpen(entry: PullRequestListEntry): void }) {
  const shown = entry.labels.slice(0, 3);
  return (
    <button className="pr-row" data-pr-row="" aria-label={`#${entry.ref.number} ${entry.title}`} onClick={() => onOpen(entry)}>
      <span className="pr-row-glyphs">
        <StateGlyph entry={entry} />
        {entry.mergeable === "conflicting" ? <span className="pr-row-conflict" title="Has conflicts with the base branch" aria-label="Has conflicts"><TriangleAlert size={10} aria-hidden="true" /></span> : null}
        <ChecksGlyph checks={entry.checks} />
      </span>
      <span className="pr-row-lines">
        <span className="pr-row-line">
          <span className="pr-row-number">#{entry.ref.number}</span>
          <span className="pr-row-title">{entry.title}</span>
          {entry.stack ? (
            <span className="pr-row-stack" title={`Layer ${entry.stack.position} of ${entry.stack.size} in stack #${entry.stack.number}`} aria-label={`Stack layer ${entry.stack.position} of ${entry.stack.size}`}>
              <Layers size={9} aria-hidden="true" />{entry.stack.position}/{entry.stack.size}
            </span>
          ) : null}
          <ReviewGlyph decision={entry.reviewDecision} />
          <span className="spacer" />
          {entry.additions || entry.deletions ? <span className="pr-row-stat"><span className="stat-add">+{entry.additions}</span> <span className="stat-del">−{entry.deletions}</span></span> : null}
        </span>
        <span className="pr-row-line meta">
          {showRepository ? <span className="pr-row-repo" title={`${entry.ref.host}/${entry.ref.repo}`}>{entry.ref.repo}</span> : null}
          {matchedElsewhere ? <span className="pr-row-elsewhere" title="Matched in the description"><Search size={9} aria-hidden="true" /> matched in the description</span> : null}
          <span className="pr-row-author" title={entry.author?.name ? `${entry.author.name} (@${entry.author.login})` : entry.author?.login}>{entry.author?.login ?? "ghost"}</span>
          <span className="pr-row-branch" title={`${entry.headRef} → ${entry.baseRef}`}>{entry.headRef}</span>
          {shown.map((label) => (
            <span key={label.name} className="pr-label small"><i aria-hidden="true" style={label.color ? { background: `#${label.color}` } : undefined} />{label.name}</span>
          ))}
          {entry.labels.length > shown.length ? <span className="pr-row-more">+{entry.labels.length - shown.length}</span> : null}
          <span className="spacer" />
          <span className="pr-row-time">{relativeTime(entry.updatedAt)}</span>
        </span>
      </span>
    </button>
  );
});

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange(value: T): void }) {
  return (
    <div className="toggle-group" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} role="radio" aria-checked={value === option.value} className={value === option.value ? "active" : ""} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

/** Arrow keys move between rows, as T3 Code's list does; Enter opens the focused one. */
function moveFocus(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-pr-row]")];
  if (rows.length === 0) return;
  event.preventDefault();
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next = at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)));
  rows[next]!.focus();
}

type Grouping = "involvement" | "project";
const GROUPINGS: Array<{ value: Grouping; label: string }> = [{ value: "involvement", label: "Involvement" }, { value: "project", label: "Project" }];

/**
 * T3 Code's Pull Requests list: every request of a repository in a state, the
 * viewer's own work first, ordered by merge readiness or by what blocks whom,
 * and narrowed by typed qualifiers or the filter menu. As the app's Pull
 * Requests page it lists every project, grouped by involvement or project; as
 * a thread's tab, its project's alone. A row opens the request.
 */
export function PullRequestListView({ params, handle, actions, client, open, surface = "tab", headAction = false }: {
  params: PullRequestsTabParams;
  /** The tab it draws in; the page has none. */
  handle?: Pick<StageTabHandle, "setTitle">;
  actions: WorkbenchActions;
  client: PullRequestClient;
  open(entry: PullRequestListEntry, workspace?: string): void;
  surface?: "tab" | "page";
  /** On the page, Refresh goes to the page head's action while the list is on screen. */
  headAction?: boolean;
}) {
  const onPage = surface === "page";
  const phone = useCompactProfile();
  const [scope, setScope] = useState<Scope>(() => params.scope === "all" ? { kind: "all" } : { kind: "project", ...(params.workspace ? { workspace: params.workspace } : {}) });
  const [host, setHost] = useState<string>();
  const projects = useProjects();
  const workspace = scope.kind === "project" ? scope.workspace : undefined;
  const everyProject = useMemo(() => projects.map(projectId), [projects]);
  const [preferences, setPreferences] = useState<PullRequestListPreferences>(() => decodeListPreferences(getClientStorage()?.get(PREFERENCES_KEY) ?? undefined));
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [author, setAuthor] = useState<string>();
  const [more, setMore] = useState<{ question: string; limit: number }>({ question: "", limit: PAGE });
  const [list, setList] = useState<Listing>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [menu, setMenu] = useState<"sort" | "filters" | "projects" | "sheet">();
  const [grouping, setGroupingState] = useState<Grouping>(() => getClientStorage()?.get(GROUPING_KEY) === "project" ? "project" : "involvement");
  const setGrouping = (next: Grouping) => { setGroupingState(next); getClientStorage()?.set(GROUPING_KEY, next); };
  const asked = useRef(0);

  const update = (patch: Partial<PullRequestListPreferences>) => setPreferences((current) => {
    const next = { ...current, ...patch };
    for (const key of Object.keys(patch) as Array<keyof PullRequestListPreferences>) if (patch[key] === undefined) delete next[key];
    getClientStorage()?.set(PREFERENCES_KEY, JSON.stringify(next));
    return next;
  });

  // Only the free text goes to the host; qualifiers narrow the rows already here.
  const typedText = useMemo(() => arrangeList([], { involvement: "all", sort: "ready", query, menu: {} }).search, [query]);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(typedText), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [typedText]);

  // "Load more" belongs to one question; a new state or search starts from the first page.
  const question = `${scope.kind === "all" ? "\u0001all" : workspace ?? ""}\0${preferences.state}\0${search}`;
  const limit = more.question === question ? more.limit : PAGE;
  const setLimit = (next: number) => setMore({ question, limit: next });

  const load = useCallback(async () => {
    const request = ++asked.current;
    setLoading(true);
    try {
      const asking = { state: preferences.state, limit, ...(search ? { search } : {}) };
      const next = scope.kind === "all"
        ? mergedListing(await client.listMany({ ...asking, workspaces: everyProject }))
        : singleListing(await client.list({ ...(workspace ? { workspace } : {}), ...asking }), workspace);
      if (request !== asked.current) return;
      if (!next) throw new Error("None of your projects has a repository with requests Tau can list.");
      setList(next);
      setError(undefined);
    } catch (reason) {
      if (request === asked.current) setError(errorMessage(reason));
    } finally {
      if (request === asked.current) setLoading(false);
    }
  }, [client, everyProject, limit, preferences.state, scope.kind, search, workspace]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!list || !handle) return;
    handle.setTitle(list.repositories.length > 1 ? "Pull requests · all projects" : `${shortNoun(list.service)}s · ${list.repo.split("/").at(-1)}`);
  }, [handle, list]);

  const menuFilters: PullRequestListFilters = {
    ...(preferences.draft ? { draft: preferences.draft } : {}),
    ...(preferences.review ? { review: preferences.review } : {}),
    ...(preferences.checks ? { checks: preferences.checks } : {}),
    ...(labels.length > 0 ? { labels: labels.map((label) => [label]) } : {}),
    ...(author ? { author } : {}),
  };
  const hosts = useMemo(() => [...new Set((list?.entries ?? []).map((entry) => entry.ref.host))].sort(), [list]);
  const entries = useMemo(() => host ? (list?.entries ?? []).filter((entry) => entry.ref.host === host) : list?.entries ?? [], [host, list]);
  const manyRepositories = (list?.repositories.length ?? 0) > 1;
  const arranged = useMemo(
    () => arrangeList(entries, { ...(list?.viewer ? { viewer: list.viewer } : {}), involvement: preferences.involvement, sort: preferences.sort, query, menu: menuFilters }),
    // `menuFilters` is rebuilt every render from the values listed here.
    [entries, list?.viewer, preferences.involvement, preferences.sort, preferences.draft, preferences.review, preferences.checks, labels, author, query],
  );
  const facets = useMemo(() => listFacets(entries), [entries]);
  const filterCount = [preferences.draft, preferences.review, preferences.checks, author, host].filter(Boolean).length + labels.length;
  const noun = list && !manyRepositories ? providerInfo(list.service).noun : "pull request";
  const openRow = useCallback((entry: PullRequestListEntry) => open(entry, list?.workspaces.get(`${entry.ref.host}/${entry.ref.repo}`) ?? workspace), [list, open, workspace]);
  const projectName = (id: string | undefined) => projects.find((project) => projectId(project) === id)?.name;
  const sections: PullRequestSection[] = onPage && grouping === "project" && manyRepositories
    ? groupByRepository(arranged.groups, (repository) => projectName(list?.workspaces.get(repository)) ?? repository)
    : arranged.groups;
  const projectItems: MenuSection[] = [{ items: [
    { id: "project:\u0001all", label: "All projects", selected: scope.kind === "all" },
    ...projects.map((project) => ({ id: `project:${projectId(project)}`, label: project.name, hint: project.displayPath ?? project.path, selected: scope.kind === "project" && workspace === projectId(project) })),
  ] }];
  const scopeLabel = scope.kind === "all" ? "All projects" : projectName(workspace) ?? "This project";

  const filterSections: MenuSection[] = [
    { heading: "Drafts", items: [
      { id: "draft:", label: "All", selected: !preferences.draft },
      { id: "draft:only", label: "Drafts only", selected: preferences.draft === "only" },
      { id: "draft:hide", label: "Hide drafts", selected: preferences.draft === "hide" },
    ] },
    { heading: "Review", items: [
      { id: "review:", label: "All", selected: !preferences.review },
      ...(Object.keys(REVIEW_LABELS) as Array<keyof typeof REVIEW_LABELS>).map((value) => ({ id: `review:${value}`, label: REVIEW_LABELS[value], selected: preferences.review === value })),
    ] },
    { heading: "Checks", items: [
      { id: "checks:", label: "All", selected: !preferences.checks },
      { id: "checks:passing", label: "Passing", selected: preferences.checks === "passing" },
      { id: "checks:failing", label: "Failing", selected: preferences.checks === "failing" },
    ] },
    { items: [
      { id: "labels", label: labels.length > 0 ? `Labels (${labels.length})` : "Labels", disabled: facets.labels.length === 0, submenu: [{ items: facets.labels.map((label) => ({ id: `label:${label.name}`, label: label.name, hint: String(label.count), selected: labels.includes(label.name) })) }] },
      { id: "authors", label: author ? `Author: ${author}` : "Author", disabled: facets.authors.length === 0, submenu: [{ items: [{ id: "author:", label: "Anyone", selected: !author }, ...facets.authors.map((person) => ({ id: `author:${person.login}`, label: person.login, hint: String(person.count), selected: author === person.login }))] }] },
      ...(filterCount > 0 ? [{ id: "clear", label: "Clear filters" }] : []),
    ] },
    { items: [
      ...(hosts.length > 1 || host ? [{
        id: "hosts",
        label: host ? `Host: ${host}` : "Host",
        submenu: [{ items: [{ id: "host:", label: "All hosts", selected: !host }, ...hosts.map((name) => ({ id: `host:${name}`, label: name, selected: host === name }))] }],
      }] : []),
    ] },
  ];

  const pickFilter = (id: string) => {
    const [key, ...rest] = id.split(":");
    const value = rest.join(":");
    if (key === "draft") update({ draft: (value || undefined) as PullRequestListPreferences["draft"] });
    else if (key === "review") update({ review: (value || undefined) as PullRequestListPreferences["review"] });
    else if (key === "checks") update({ checks: (value || undefined) as PullRequestListPreferences["checks"] });
    else if (key === "label") setLabels((current) => current.includes(value) ? current.filter((label) => label !== value) : [...current, value]);
    else if (key === "author") setAuthor(value || undefined);
    else if (key === "project") { setScope(value === "\u0001all" ? { kind: "all" } : { kind: "project", workspace: value }); setHost(undefined); }
    else if (key === "host") setHost(value || undefined);
    else if (key === "state") update({ state: value as PullRequestListState });
    else if (key === "involvement") update({ involvement: value as PullRequestInvolvement });
    else if (key === "sort") update({ sort: value as PullRequestListSort });
    else if (key === "group") setGrouping(value as Grouping);
    else if (key === "clear") { update({ draft: undefined, review: undefined, checks: undefined }); setLabels([]); setAuthor(undefined); setHost(undefined); }
  };

  // A phone keeps the header to one line: every control below goes into a sheet, what narrows the list into chips.
  const narrowings = listNarrowings({ ...preferences, project: onPage && scope.kind === "project" ? scopeLabel : undefined, labels, author, host });
  const removeNarrowing = (id: string) => {
    if (id === "project") pickFilter("project:\u0001all");
    else if (id === "state") update({ state: "open" });
    else if (id === "involvement") update({ involvement: "all" });
    else pickFilter(id.startsWith("label:") ? id : `${id}:`);
  };
  const clearNarrowings = () => {
    update({ state: "open", involvement: "all" });
    pickFilter("clear");
    if (onPage && scope.kind === "project") pickFilter("project:\u0001all");
  };
  const one = (id: string, legend: string, options: Array<{ value: string; label: string }>, current: string | undefined): FilterGroup => (
    { id, legend, kind: "one", options: options.map((option) => ({ id: `${id}:${option.value}`, label: option.label, selected: (current ?? "") === option.value })) }
  );
  const sheetGroups: FilterGroup[] = phone ? [
    ...(onPage ? [{ id: "project", legend: "Project", kind: "list" as const, options: projectItems[0]!.items.map((item) => ({ id: item.id, label: item.label, selected: Boolean(item.selected) })) }] : []),
    one("state", "State", STATES, preferences.state),
    one("involvement", "Involvement", INVOLVEMENTS, preferences.involvement),
    ...(onPage && manyRepositories ? [one("group", "Group by", GROUPINGS, grouping)] : []),
    { id: "sort", legend: "Sort", kind: "list", options: SORTS.map((sort) => ({ id: `sort:${sort}`, label: SORT_LABELS[sort], selected: preferences.sort === sort })) },
    one("draft", "Drafts", [{ value: "", label: "All" }, { value: "only", label: "Drafts only" }, { value: "hide", label: "Hide drafts" }], preferences.draft),
    one("review", "Review", [{ value: "", label: "All" }, ...(Object.keys(REVIEW_LABELS) as Array<keyof typeof REVIEW_LABELS>).map((value) => ({ value, label: REVIEW_LABELS[value] }))], preferences.review),
    one("checks", "Checks", [{ value: "", label: "All" }, { value: "passing", label: "Passing" }, { value: "failing", label: "Failing" }], preferences.checks),
    ...(facets.labels.length > 0 ? [{ id: "labels", legend: "Labels", kind: "many" as const, options: facets.labels.map((label) => ({ id: `label:${label.name}`, label: label.name, hint: String(label.count), selected: labels.includes(label.name) })) }] : []),
    ...(facets.authors.length > 0 ? [{ id: "author", legend: "Author", kind: "list" as const, options: [{ id: "author:", label: "Anyone", selected: !author }, ...facets.authors.map((person) => ({ id: `author:${person.login}`, label: person.login, hint: String(person.count), selected: author === person.login }))] }] : []),
    ...(hosts.length > 1 || host ? [{ id: "host", legend: "Host", kind: "list" as const, options: [{ id: "host:", label: "All hosts", selected: !host }, ...hosts.map((name) => ({ id: `host:${name}`, label: name, selected: host === name }))] }] : []),
  ] : [];
  const shownText = list ? `${arranged.shown} of ${entries.length}${list.truncated ? "+" : ""}` : undefined;

  const firstLoad = loading && !list && !error;
  const refresh = <>
    {loading && list ? <Spinner size="xs" label="Refreshing" /> : null}
    <button className="icon-button compact" aria-label="Refresh pull requests" title="Refresh" disabled={loading} onClick={() => void load()}><RefreshCw size={13} /></button>
  </>;
  const searchField = (
    <label className="pr-list-search">
      {loading && search ? <Spinner size="xs" label="Searching" /> : <Search size={phone ? 16 : 13} aria-hidden="true" />}
      <input type="search" aria-label="Search pull requests" placeholder={phone ? "Search, or label:bug" : "Search pull requests, or label:bug"} value={query} onChange={(event) => setQuery(event.target.value)} />
    </label>
  );
  const narrowed = filterCount > 0 || query.trim() !== "" || preferences.state !== "open" || preferences.involvement !== "all";

  return (
    <div className={`pr-list-view${onPage ? " on-page" : ""}`} aria-label="Pull requests">
      {phone ? (
        <header className="pr-list-head phone">
          <div className="pr-list-bar">
            {searchField}
            <button
              className={`icon-button pr-list-filter${narrowings.length > 0 ? " active" : ""}`}
              aria-label={narrowings.length > 0 ? `Filter pull requests, ${narrowings.length} active` : "Filter pull requests"}
              aria-haspopup="dialog"
              aria-expanded={menu === "sheet"}
              onClick={() => setMenu("sheet")}
            >
              <ListFilter size={20} aria-hidden="true" />
              {narrowings.length > 0 ? <span className="pr-list-filter-count" aria-hidden="true">{narrowings.length}</span> : null}
            </button>
            <button className="icon-button" aria-label="Refresh pull requests" disabled={loading} onClick={() => void load()}>
              {loading && list ? <Spinner size="sm" label="Refreshing" /> : <RefreshCw size={18} aria-hidden="true" />}
            </button>
          </div>
          <NarrowingChips items={narrowings} onRemove={removeNarrowing} onClear={clearNarrowings} />
        </header>
      ) : (
        <header className="pr-list-head">
          {onPage ? (
            <div className="pr-list-title">
              <span className="menu-anchor">
                <button className="mini-button pr-list-menu pr-list-scope" aria-label={`Projects: ${scopeLabel}`} aria-expanded={menu === "projects"} title={list?.repositories.join("\n")} onClick={() => setMenu(menu === "projects" ? undefined : "projects")}>
                  <Folder size={12} aria-hidden="true" /> {scopeLabel}{list && manyRepositories ? ` · ${list.repositories.length} repositories` : ""} <ChevronDown size={11} aria-hidden="true" />
                </button>
                {menu === "projects" ? <Menu align="left" label="Projects" sections={projectItems} onSelect={(id) => { pickFilter(id); setMenu(undefined); }} onClose={() => setMenu(undefined)} /> : null}
              </span>
              {list && !manyRepositories ? <button className="pr-list-repo" title={`Open ${list.repo} on ${hostName(list.service)}`} onClick={() => actions.openExternal(providerInfo(list.service).repositoryUrl(list.host, list.repo))}>{list.host}/{list.repo}</button> : null}
              <span className="spacer" />
              {headAction ? <SettingsPageAction><span className="pr-page-action">{refresh}</span></SettingsPageAction> : refresh}
            </div>
          ) : (
            <div className="pr-list-title">
              <h1>{list ? `${noun[0]!.toUpperCase()}${noun.slice(1)}s` : "Pull requests"}</h1>
              {list ? <button className="pr-list-repo" title={`Open ${list.repo} on ${hostName(list.service)}`} onClick={() => actions.openExternal(providerInfo(list.service).repositoryUrl(list.host, list.repo))}>{list.host}/{list.repo}</button> : null}
              <span className="spacer" />
              {actions.openPage ? <button className="mini-button" title="Every project's pull requests, on a page of their own" onClick={() => actions.openPage?.(REVIEWS_PAGE, { tab: "remote" })}>All projects</button> : null}
              {refresh}
            </div>
          )}
          <div className="pr-list-controls">
            {searchField}
            <span className="menu-anchor">
              <button className={`mini-button pr-list-menu ${filterCount > 0 ? "active" : ""}`} aria-label="Filter pull requests" aria-expanded={menu === "filters"} onClick={() => setMenu(menu === "filters" ? undefined : "filters")}>
                <ListFilter size={12} aria-hidden="true" /> Filters{filterCount > 0 ? ` · ${filterCount}` : ""}
              </button>
              {menu === "filters" ? <Menu align="right" label="Filter pull requests" sections={filterSections} onSelect={(id) => { pickFilter(id); if (!id.startsWith("label:")) setMenu(undefined); }} onClose={() => setMenu(undefined)} /> : null}
            </span>
            <span className="menu-anchor">
              <button className="mini-button pr-list-menu" aria-label="Sort pull requests" aria-expanded={menu === "sort"} title={SORT_LABELS[preferences.sort]} onClick={() => setMenu(menu === "sort" ? undefined : "sort")}>
                <ArrowDownUp size={12} aria-hidden="true" /> {SORT_LABELS[preferences.sort]}
              </button>
              {menu === "sort" ? (
                <Menu
                  align="right"
                  heading="Sort"
                  items={(Object.keys(SORT_LABELS) as PullRequestListSort[]).map((sort) => ({ id: sort, label: SORT_LABELS[sort], selected: preferences.sort === sort }))}
                  onSelect={(id) => { update({ sort: id as PullRequestListSort }); setMenu(undefined); }}
                  onClose={() => setMenu(undefined)}
                />
              ) : null}
            </span>
          </div>
          <div className="pr-list-controls">
            <Segmented label="State" value={preferences.state} options={STATES} onChange={(state) => update({ state })} />
            <Segmented label="Involvement" value={preferences.involvement} options={INVOLVEMENTS} onChange={(involvement) => update({ involvement })} />
            {onPage && manyRepositories ? <><span className="pr-list-caption" aria-hidden="true">Group by</span><Segmented label="Group by" value={grouping} options={GROUPINGS} onChange={setGrouping} /></> : null}
            <span className="spacer" />
            {shownText ? <span className="pr-list-count">{shownText}</span> : null}
          </div>
        </header>
      )}
      {menu === "sheet" && phone ? (
        <PullRequestFilterSheet
          groups={sheetGroups}
          summary={shownText ? `${shownText} ${noun}s shown` : undefined}
          onPick={pickFilter}
          onClear={narrowings.length > 0 ? clearNarrowings : undefined}
          onClose={() => setMenu(undefined)}
        />
      ) : null}

      <div className="pr-list-body" onKeyDown={moveFocus}>
        {firstLoad ? (
          <div className="pr-list-ghost" role="status" aria-label="Loading pull requests">
            {Array.from({ length: 7 }, (_, index) => <Skeleton key={index} className="pr-list-ghost-row" />)}
          </div>
        ) : error && entries.length === 0 ? (
          <Empty icon={<GitPullRequest size={18} />} title="Pull requests unavailable" description={error}>
            <button className="mini-button" onClick={() => void load()}>Retry</button>
          </Empty>
        ) : arranged.shown === 0 && !loading ? (
          query.trim() ? (
            <Empty icon={<Search size={18} />} title={`Nothing matches “${query.length > 48 ? `${query.slice(0, 48)}…` : query}”`} description="Try other words, or clear the search.">
              <button className="mini-button" onClick={() => setQuery("")}>Clear search</button>
            </Empty>
          ) : (
            <Empty icon={<GitPullRequest size={18} />} title={narrowed ? `No ${noun}s match these filters` : `No open ${noun}s`} description={narrowed ? "Change the state or the filters to see more." : manyRepositories ? "None of your projects has anything waiting." : `${list?.repo ?? "This repository"} has nothing waiting.`}>
              {phone && narrowings.length > 0 ? <button className="mini-button" onClick={clearNarrowings}>Clear filters</button> : null}
              {list?.truncated ? <button className="mini-button" onClick={() => setLimit(Math.min(MAX_LIMIT, limit + PAGE))}>Load more {noun}s</button> : null}
            </Empty>
          )
        ) : (
          <>
            {phone && shownText ? <p className="pr-list-summary">{shownText} · {SORT_LABELS[preferences.sort]}</p> : null}
            {sections.map((group) => (
              <section key={group.key} className="pr-list-group" aria-label={group.label || `${noun}s`}>
                {group.label ? <h2>{group.label} <small>{group.entries.length}</small></h2> : null}
                {group.entries.map((entry) => (
                  <PullRequestRow key={entry.ref.url} entry={entry} matchedElsewhere={Boolean(arranged.search) && scoreMatch(entry, arranged.search) <= 10} showRepository={manyRepositories} onOpen={openRow} />
                ))}
              </section>
            ))}
            {error ? (
              <div className="pr-list-stale" role="alert">
                <span>{error} Showing the last {noun}s loaded.</span>
                <button className="mini-button" onClick={() => void load()}>Retry</button>
              </div>
            ) : null}
            {list && list.failures.length > 0 ? (
              <div className="pr-list-stale quiet" role="note" title={list.failures.map((failure) => `${projectName(failure.workspace) ?? failure.workspace}: ${failure.message}`).join("\n")}>
                <span>Not listed: {list.failures.map((failure) => projectName(failure.workspace) ?? failure.workspace).join(", ")}.</span>
              </div>
            ) : null}
            {list?.truncated ? (
              <div className="pr-list-more">
                {loading ? <span><Spinner size="xs" label="Loading more" /> Loading more</span>
                  : limit < MAX_LIMIT ? <button className="mini-button" onClick={() => setLimit(Math.min(MAX_LIMIT, limit + PAGE))}>Load more {noun}s</button>
                    : <span>Narrow your search to find more {noun}s.</span>}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}


export default PullRequestListView;
