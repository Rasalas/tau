import type { PullRequestListEntry, PullRequestListState, PullRequestReviewDecision } from "./protocol.js";

export type PullRequestInvolvement = "all" | "reviewing" | "authored";
export type PullRequestListSort = "ready" | "blocked" | "updated" | "newest" | "oldest" | "largest" | "smallest";

export interface PullRequestListFilters {
  /** Each inner list is one `label:a,b` qualifier: any of its names. */
  labels?: string[][];
  excludedLabels?: string[];
  author?: string;
  draft?: "only" | "hide";
  review?: PullRequestReviewDecision | "none";
  checks?: "passing" | "failing";
}

/** What the page remembers between visits: the list controls, never a selection. */
export interface PullRequestListPreferences {
  state: PullRequestListState;
  involvement: PullRequestInvolvement;
  sort: PullRequestListSort;
  draft?: "only" | "hide";
  review?: PullRequestListFilters["review"];
  checks?: PullRequestListFilters["checks"];
}

export const DEFAULT_LIST_PREFERENCES: PullRequestListPreferences = { state: "open", involvement: "all", sort: "ready" };

const STATES: readonly PullRequestListState[] = ["open", "closed", "merged", "all"];
const INVOLVEMENTS: readonly PullRequestInvolvement[] = ["all", "reviewing", "authored"];
export const SORTS: readonly PullRequestListSort[] = ["ready", "blocked", "updated", "newest", "oldest", "largest", "smallest"];
const REVIEWS = ["approved", "changes-requested", "review-required", "none"] as const;

/** Stored preferences, each field checked on its own so one bad value costs only itself. */
export function decodeListPreferences(raw: string | undefined): PullRequestListPreferences {
  let value: Record<string, unknown> = {};
  try { value = JSON.parse(raw ?? "{}") as Record<string, unknown>; } catch { /* the defaults */ }
  const pick = <T extends string>(options: readonly T[], candidate: unknown): T | undefined => options.find((option) => option === candidate);
  return {
    state: pick(STATES, value.state) ?? DEFAULT_LIST_PREFERENCES.state,
    involvement: pick(INVOLVEMENTS, value.involvement) ?? DEFAULT_LIST_PREFERENCES.involvement,
    sort: pick(SORTS, value.sort) ?? DEFAULT_LIST_PREFERENCES.sort,
    ...(pick(["only", "hide"] as const, value.draft) ? { draft: value.draft as "only" | "hide" } : {}),
    ...(pick(REVIEWS, value.review) ? { review: value.review as PullRequestListFilters["review"] } : {}),
    ...(pick(["passing", "failing"] as const, value.checks) ? { checks: value.checks as "passing" | "failing" } : {}),
  };
}

const REVIEW_VALUES: Record<string, PullRequestListFilters["review"]> = {
  approved: "approved",
  changes_requested: "changes-requested",
  "changes-requested": "changes-requested",
  required: "review-required",
  "review-required": "review-required",
  none: "none",
};
const CHECKS_VALUES: Record<string, PullRequestListFilters["checks"]> = { success: "passing", passing: "passing", failure: "failing", failing: "failing" };
const QUERY_TOKEN = /(?:[^\s"]|"[^"]*")+/gu;
const unquote = (value: string) => value.replaceAll("\"", "").trim();

/**
 * A typed query split into qualifiers and the text left for the host to
 * search, written GitHub's way: `label:a,b`, `-label:x`, `author:me`,
 * `draft:true`, `review:approved`, `status:success`. An unknown key is a
 * namespaced label (`size:XL`), as in T3 Code; a quoted token stays text.
 */
export function parseListQuery(raw: string): { text: string; filters: PullRequestListFilters } {
  const text: string[] = [];
  const labels: string[][] = [];
  const excluded: string[] = [];
  const filters: PullRequestListFilters = {};
  for (const [token] of raw.matchAll(QUERY_TOKEN)) {
    const qualifier = /^(-?)([A-Za-z][\w-]*):(.+)$/u.exec(token);
    if (!qualifier) { text.push(token); continue; }
    const [, minus, rawKey, rawValue] = qualifier as unknown as [string, string, string, string];
    const key = rawKey.toLowerCase();
    const value = unquote(rawValue);
    const negated = minus === "-";
    if (!value || value.startsWith("/")) { text.push(token); continue; }
    const names = (prefix?: string) => rawValue.split(",").map(unquote).filter(Boolean).map((name) => prefix && !name.includes(":") ? `${prefix}:${name}` : name);
    if (key === "label") {
      if (negated) excluded.push(...names()); else labels.push(names());
    } else if (key === "author" && !negated) {
      filters.author = value;
    } else if (key === "draft" && !negated && /^(true|false)$/iu.test(value)) {
      filters.draft = value.toLowerCase() === "true" ? "only" : "hide";
    } else if (key === "review" && !negated && REVIEW_VALUES[value.toLowerCase()]) {
      filters.review = REVIEW_VALUES[value.toLowerCase()];
    } else if ((key === "status" || key === "checks") && !negated && CHECKS_VALUES[value.toLowerCase()]) {
      filters.checks = CHECKS_VALUES[value.toLowerCase()];
    } else if (["author", "draft", "review", "status", "checks"].includes(key)) {
      text.push(token);
    } else if (negated) {
      excluded.push(...names(rawKey));
    } else {
      labels.push(names(rawKey));
    }
  }
  return {
    text: text.join(" "),
    filters: { ...filters, ...(labels.length > 0 ? { labels } : {}), ...(excluded.length > 0 ? { excludedLabels: excluded } : {}) },
  };
}

/** The narrowings a row can be judged by from its own fields; `author:me` means the signed-in login. */
export function matchesListFilters(entry: PullRequestListEntry, filters: PullRequestListFilters, viewer?: string): boolean {
  const held = new Set(entry.labels.map((label) => label.name.trim().toLowerCase()));
  const holds = (name: string) => held.has(name.trim().toLowerCase());
  // Without a signed-in login, "me" stays the literal name.
  const me = entry.viewer ?? viewer;
  const author = filters.author?.toLowerCase() === "me" && me ? me : filters.author;
  return (filters.draft === undefined || entry.draft === (filters.draft === "only"))
    && (filters.review === undefined || (filters.review === "none" ? entry.reviewDecision === undefined : entry.reviewDecision === filters.review))
    && (filters.checks === undefined || entry.checks === filters.checks)
    && (filters.labels === undefined || filters.labels.every((group) => group.some(holds)))
    && (filters.excludedLabels === undefined || !filters.excludedLabels.some(holds))
    && (author === undefined || entry.author?.login.toLowerCase() === author.toLowerCase());
}

/** A row from a page that mixes hosts carries the login of its own host. */
const authoredBy = (entry: PullRequestListEntry, fallback: string | undefined) => {
  const viewer = entry.viewer ?? fallback;
  return Boolean(viewer) && entry.author?.login.toLowerCase() === viewer!.toLowerCase();
};

export function filterByInvolvement(entries: readonly PullRequestListEntry[], involvement: PullRequestInvolvement, viewer: string | undefined): PullRequestListEntry[] {
  if (involvement === "reviewing") return entries.filter((entry) => entry.reviewRequested);
  if (involvement === "authored") return entries.filter((entry) => authoredBy(entry, viewer));
  return [...entries];
}

export type PullRequestGroupKey = "authored" | "reviewRequested" | "others";

export interface PullRequestGroup {
  key: PullRequestGroupKey;
  label: string;
  entries: PullRequestListEntry[];
}

const GROUP_LABELS: Record<PullRequestGroupKey, string> = { authored: "Authored", reviewRequested: "Review requested", others: "Others" };

/** Authored first, then what waits on the viewer's review, then the rest; empty groups go. */
export function groupByInvolvement(entries: readonly PullRequestListEntry[], viewer: string | undefined): PullRequestGroup[] {
  const buckets: Record<PullRequestGroupKey, PullRequestListEntry[]> = { authored: [], reviewRequested: [], others: [] };
  for (const entry of entries) {
    if (authoredBy(entry, viewer)) buckets.authored.push(entry);
    else if (entry.reviewRequested) buckets.reviewRequested.push(entry);
    else buckets.others.push(entry);
  }
  return (["authored", "reviewRequested", "others"] as const)
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: GROUP_LABELS[key], entries: buckets[key] }));
}

const size = (entry: PullRequestListEntry) => entry.additions + entry.deletions;
const measured = (entry: PullRequestListEntry) => size(entry) > 0;
const recency = (left: PullRequestListEntry, right: PullRequestListEntry) => right.updatedAt.localeCompare(left.updatedAt);

/**
 * T3 Code's default queue: green and approved, then green and waiting, then
 * the rest still open (drafts among them), then finished work; a known
 * conflict is never ready. Smaller measured diffs first within a tier.
 */
export function rankByMergeReadiness(entries: readonly PullRequestListEntry[]): PullRequestListEntry[] {
  const tier = (entry: PullRequestListEntry) => {
    if (entry.mergeable === "conflicting") return 4;
    if (entry.state !== "open") return 3;
    if (entry.draft) return 2;
    if (entry.checks === "passing" && entry.reviewDecision === "approved") return 0;
    if (entry.checks === "passing") return 1;
    return 2;
  };
  return [...entries].sort((left, right) => tier(left) - tier(right)
    || Number(measured(right)) - Number(measured(left))
    || size(left) - size(right)
    || recency(left, right));
}

/** What the author has to act on first: a conflict, requested changes, red checks, a draft. */
export function rankBlockedOnAuthor(entries: readonly PullRequestListEntry[]): PullRequestListEntry[] {
  const tier = (entry: PullRequestListEntry) => {
    if (entry.state !== "open") return 6;
    if (entry.mergeable === "conflicting") return 0;
    if (entry.reviewDecision === "changes-requested") return 1;
    if (entry.checks === "failing") return 2;
    if (entry.draft) return 3;
    if (entry.checks === "passing" && entry.reviewDecision === "approved") return 5;
    return 4;
  };
  return [...entries].sort((left, right) => tier(left) - tier(right) || recency(left, right));
}

/** A reviewer is blocking every open request that asks them. */
export function rankBlockedOnReviewer(entries: readonly PullRequestListEntry[]): PullRequestListEntry[] {
  return [...entries].sort((left, right) => Number(left.state !== "open") - Number(right.state !== "open") || recency(left, right));
}

/** How closely a row's own words answer a search; the host may have matched text the row does not show. */
export function scoreMatch(entry: PullRequestListEntry, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const number = needle.replace(/^#/u, "");
  if (/^\d+$/u.test(number)) return String(entry.ref.number) === number ? 100 : 0;
  const title = entry.title.toLowerCase();
  const terms = needle.split(/\s+/u).filter(Boolean);
  if (title === needle) return 90;
  if (title.includes(needle)) return 80;
  if (terms.length > 1 && terms.every((term) => title.includes(term))) return 70;
  if (entry.headRef.toLowerCase().includes(needle)) return 60;
  if ((entry.author?.login ?? "").toLowerCase().includes(needle)) return 50;
  if (terms.some((term) => title.includes(term))) return 30;
  return 10;
}

/** The chosen order inside each group; a search orders by how well rows match instead. */
export function sortGroups(groups: readonly PullRequestGroup[], sort: PullRequestListSort, search: string, involvement: PullRequestInvolvement): PullRequestGroup[] {
  const within = (rank: (entries: readonly PullRequestListEntry[]) => PullRequestListEntry[]) => groups.map((group) => ({ ...group, entries: rank(group.entries) }));
  if (search.trim()) return within((entries) => [...entries].sort((left, right) => scoreMatch(right, search) - scoreMatch(left, search) || recency(left, right)));
  if (sort === "ready") return within(rankByMergeReadiness);
  if (sort === "blocked") {
    return groups.map((group) => {
      const role = group.key === "authored" ? "authored" : group.key === "reviewRequested" ? "reviewing" : involvement;
      if (role === "all") return group;
      return { ...group, entries: role === "authored" ? rankBlockedOnAuthor(group.entries) : rankBlockedOnReviewer(group.entries) };
    });
  }
  if (sort === "updated") return within((entries) => [...entries].sort(recency));
  if (sort === "newest" || sort === "oldest") {
    const sign = sort === "newest" ? -1 : 1;
    return within((entries) => [...entries].sort((left, right) => sign * left.createdAt.localeCompare(right.createdAt) || recency(left, right)));
  }
  const sign = sort === "largest" ? -1 : 1;
  return within((entries) => [...entries].sort((left, right) => Number(measured(right)) - Number(measured(left)) || sign * (size(left) - size(right)) || recency(left, right)));
}

export interface LabelFacet {
  name: string;
  color?: string;
  count: number;
}

/** Labels and authors of the rows loaded, most used first, for the filter menu. */
export function listFacets(entries: readonly PullRequestListEntry[]): { labels: LabelFacet[]; authors: Array<{ login: string; count: number }> } {
  const labels = new Map<string, LabelFacet>();
  const authors = new Map<string, { login: string; count: number }>();
  for (const entry of entries) {
    for (const label of entry.labels) {
      const key = label.name.toLowerCase();
      const held = labels.get(key);
      labels.set(key, { name: held?.name ?? label.name, ...(held?.color ?? label.color ? { color: held?.color ?? label.color } : {}), count: (held?.count ?? 0) + 1 });
    }
    if (entry.author) {
      const key = entry.author.login.toLowerCase();
      authors.set(key, { login: authors.get(key)?.login ?? entry.author.login, count: (authors.get(key)?.count ?? 0) + 1 });
    }
  }
  const byCount = <T extends { count: number }>(name: (item: T) => string) => (left: T, right: T) => right.count - left.count || name(left).localeCompare(name(right));
  return {
    labels: [...labels.values()].sort(byCount((label) => label.name)),
    authors: [...authors.values()].sort(byCount((author) => author.login)),
  };
}

/**
 * Everything the page draws from one answer: involvement, then the typed
 * and menu filters, grouped and sorted. Pure, so the page only renders it.
 */
export function arrangeList(entries: readonly PullRequestListEntry[], options: {
  viewer?: string;
  involvement: PullRequestInvolvement;
  sort: PullRequestListSort;
  query: string;
  menu: PullRequestListFilters;
}): { groups: PullRequestGroup[]; shown: number; search: string } {
  const typed = parseListQuery(options.query);
  const filters: PullRequestListFilters = { ...options.menu, ...typed.filters };
  const kept = filterByInvolvement(entries, options.involvement, options.viewer).filter((entry) => matchesListFilters(entry, filters, options.viewer));
  const groups = options.involvement === "all"
    ? groupByInvolvement(kept, options.viewer)
    : kept.length > 0 ? [{ key: "others" as const, label: "", entries: kept }] : [];
  return { groups: sortGroups(groups, options.sort, typed.text, options.involvement), shown: kept.length, search: typed.text };
}
