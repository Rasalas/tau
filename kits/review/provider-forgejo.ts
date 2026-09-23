import { HostCommandError } from "tau/host-extension";
import {
  PROVIDERS,
  type PullRequestActor,
  type PullRequestCheck,
  type PullRequestCheckStatus,
  type PullRequestComment,
  type PullRequestDetail,
  type PullRequestLabel,
  type PullRequestListEntry,
  type PullRequestRef,
  type PullRequestReviewer,
  type PullRequestThread,
  type PullRequestVerdict,
  type ReviewRequest,
} from "./protocol.js";
import type { LineCommentInput, ProviderTools, RepositoryTarget, SourceControlProvider } from "./provider.js";
import { missingCli } from "./provider-github.js";
import { parseRequestUrl, parseUnifiedDiff } from "./pull-request-json.js";

/*
 * Forgejo and Gitea through `tea api`: tea holds the login (`tea login add`)
 * and signs each call, so the kit never sees a token. The API is Gitea's
 * v1, which Forgejo keeps. tea exits 0 on an HTTP error; `--include` puts
 * the status line on stderr, and that decides.
 */

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;

const LOGINS_TTL_MS = 60_000;
const PAGE = 50;
const MAX_LIST_PAGES = 10;
const MAX_REVIEWS = 30;
const DIFF_BUFFER = 16 * 1024 * 1024;
/** Forgejo and Gitea mark a draft by this prefix on the title. */
const DRAFT_PREFIX = /^\s*(?:\[WIP\]|WIP:)\s*/iu;

export interface TeaLogin {
  name: string;
  url: string;
  sshHost?: string;
  user?: string;
  default: boolean;
}

/** `tea login list --output json`. */
export function parseTeaLogins(output: string): TeaLogin[] {
  let rows: unknown;
  try { rows = JSON.parse(output); } catch { return []; }
  return list(rows).flatMap((row) => {
    const name = text(row.name);
    const url = text(row.url);
    if (!name || !url) return [];
    const sshHost = text(row.ssh_host) ?? text(row.sshhost);
    const user = text(row.user);
    return [{ name, url: url.replace(/\/+$/u, ""), ...(sshHost ? { sshHost: sshHost.toLowerCase() } : {}), ...(user ? { user } : {}), default: row.default === true || row.default === "true" }];
  });
}

/** The login whose server is `host`: its web host with the port, its bare name, or its SSH host. */
export function loginFor(logins: readonly TeaLogin[], host: string): TeaLogin | undefined {
  const wanted = host.toLowerCase();
  const matches = logins.filter((login) => {
    try {
      const url = new URL(login.url);
      return url.host.toLowerCase() === wanted || url.hostname.toLowerCase() === wanted || login.sshHost === wanted;
    } catch {
      return false;
    }
  });
  return matches.find((login) => login.default) ?? matches[0];
}

/** A Forgejo remote: the web host keeps its port, an SSH remote names the server alone. */
export function forgejoRepository(remoteUrl: string): RepositoryTarget | undefined {
  const value = remoteUrl.trim();
  let host: string | undefined;
  let path: string | undefined;
  if (/^https?:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      host = url.host;
      path = url.pathname;
    } catch {
      return undefined;
    }
  } else if (/^ssh:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      host = url.hostname;
      path = url.pathname;
    } catch {
      return undefined;
    }
  } else {
    const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/u.exec(value);
    host = scp?.[1];
    path = scp?.[2];
  }
  const repo = path?.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  if (!host || !repo || repo.split("/").length !== 2) return undefined;
  return { host: host.toLowerCase(), repo };
}

function actor(value: unknown): PullRequestActor | undefined {
  const raw = record(value);
  const login = text(raw.login) ?? text(raw.username);
  if (!login) return undefined;
  const name = text(raw.full_name);
  return { login, ...(name && name !== login ? { name } : {}) };
}

const GHOST: PullRequestActor = { login: "ghost" };

function state(raw: Json): "open" | "closed" | "merged" {
  if (raw.merged === true || text(raw.merged_at)) return "merged";
  return text(raw.state) === "closed" ? "closed" : "open";
}

const isDraft = (raw: Json) => raw.draft === true || DRAFT_PREFIX.test(text(raw.title) ?? "");

function labels(value: unknown): PullRequestLabel[] {
  return list(value).flatMap((label) => {
    const name = text(label.name);
    const color = text(label.color)?.replace(/^#/u, "");
    return name ? [{ name, ...(color && /^[0-9a-f]{6}$/iu.test(color) ? { color: color.toLowerCase() } : {}) }] : [];
  });
}

const STATUSES: Record<string, PullRequestCheckStatus> = { success: "passed", failure: "failed", error: "failed", warning: "neutral", pending: "pending", skipped: "skipped" };

/** `GET /repos/:o/:r/commits/:sha/status`: one check per status context. */
export function parseForgejoChecks(output: string): PullRequestCheck[] {
  return list(record(JSON.parse(output)).statuses).flatMap((status) => {
    const name = text(status.context);
    if (!name) return [];
    const url = text(status.target_url);
    const description = text(status.description);
    return [{ name, status: STATUSES[text(status.status) ?? text(status.state) ?? ""] ?? "pending", ...(url ? { url } : {}), ...(description ? { description } : {}) }];
  });
}

const VERDICTS: Record<string, PullRequestVerdict> = { APPROVED: "approved", REQUEST_CHANGES: "changes-requested", COMMENT: "commented", PENDING: "pending", REQUEST_REVIEW: "pending" };

/** The request, its comments, reviews and commits, as the view reads them. */
export function parseForgejoDetail(ref: PullRequestRef, pull: string, comments: string, reviews: string, commits: string, checks: PullRequestCheck[]): PullRequestDetail {
  const raw = record(JSON.parse(pull));
  const author = actor(raw.user);
  const reviewers = new Map<string, PullRequestReviewer>();
  for (const person of list(raw.requested_reviewers)) {
    const login = actor(person)?.login;
    if (login) reviewers.set(login, { login, verdict: "pending" });
  }
  const timeline: PullRequestComment[] = [];
  for (const comment of list(JSON.parse(comments))) {
    const createdAt = text(comment.created_at) ?? "";
    const url = text(comment.html_url);
    timeline.push({ id: String(comment.id ?? createdAt), kind: "comment", author: actor(comment.user) ?? GHOST, body: typeof comment.body === "string" ? comment.body : "", createdAt, ...(url ? { url } : {}) });
  }
  for (const review of list(JSON.parse(reviews))) {
    const verdict = VERDICTS[text(review.state)?.toUpperCase() ?? ""] ?? "commented";
    const who = actor(review.user);
    if (who && who.login !== author?.login && verdict !== "pending") {
      const known = reviewers.get(who.login);
      if (!(known && known.verdict !== "pending" && verdict === "commented")) reviewers.set(who.login, { login: who.login, verdict });
    }
    const body = typeof review.body === "string" ? review.body : "";
    if (verdict === "commented" && !body.trim()) continue;
    if (verdict === "pending") continue;
    const createdAt = text(review.submitted_at) ?? text(review.updated_at) ?? "";
    timeline.push({ id: `review-${String(review.id ?? createdAt)}`, kind: "review", author: who ?? GHOST, body, createdAt, verdict });
  }
  const head = record(raw.head);
  return {
    ref,
    ...(author ? { author } : {}),
    ...(text(raw.created_at) ? { createdAt: text(raw.created_at) } : {}),
    ...(text(raw.updated_at) ? { updatedAt: text(raw.updated_at) } : {}),
    ...(text(raw.merged_at) ? { mergedAt: text(raw.merged_at) } : {}),
    ...(text(raw.closed_at) ? { closedAt: text(raw.closed_at) } : {}),
    ...(text(head.ref) ? { headRef: text(head.ref) } : {}),
    ...(text(head.sha) ? { headSha: text(head.sha) } : {}),
    title: text(raw.title) ?? `#${ref.number}`,
    body: typeof raw.body === "string" ? raw.body : "",
    state: state(raw),
    draft: isDraft(raw),
    baseRef: text(record(raw.base).ref) ?? "",
    additions: count(raw.additions),
    deletions: count(raw.deletions),
    changedFiles: count(raw.changed_files),
    reviewers: [...reviewers.values()],
    labels: labels(raw.labels),
    checks,
    comments: timeline.sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    commits: list(JSON.parse(commits)).flatMap((commit) => {
      const oid = text(commit.sha);
      const message = text(record(commit.commit).message) ?? "";
      const who = record(record(commit.commit).author);
      const name = text(record(commit.author).login) ?? text(who.name);
      return oid ? [{ oid, headline: message.split("\n")[0] ?? "", committedAt: text(who.date) ?? text(commit.created) ?? "", ...(name ? { author: name } : {}) }] : [];
    }),
  };
}

/**
 * Review comments as conversations: Forgejo keeps no thread object, so the
 * comments on one line of one file are one conversation, as its web UI shows them.
 */
export function parseForgejoThreads(reviewComments: readonly string[]): PullRequestThread[] {
  const threads = new Map<string, PullRequestThread>();
  for (const output of reviewComments) {
    for (const comment of list(JSON.parse(output))) {
      const path = text(comment.path);
      if (!path) continue;
      const position = count(comment.position);
      const original = count(comment.original_position);
      const side = position > 0 ? "new" as const : "old" as const;
      const line = position > 0 ? position : original > 0 ? original : undefined;
      const key = `${path}\0${side}\0${line ?? ""}`;
      const createdAt = text(comment.created_at) ?? "";
      const url = text(comment.html_url);
      const entry: PullRequestComment = { id: String(comment.id ?? createdAt), kind: "review-comment", author: actor(comment.user) ?? GHOST, body: typeof comment.body === "string" ? comment.body : "", createdAt, ...(url ? { url } : {}) };
      const thread = threads.get(key);
      if (thread) {
        thread.comments.push(entry);
        if (comment.resolver) thread.resolved = true;
      } else {
        threads.set(key, { id: entry.id, path, ...(line !== undefined ? { line } : {}), side, resolved: Boolean(comment.resolver), outdated: false, comments: [entry] });
      }
    }
  }
  for (const thread of threads.values()) thread.comments.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return [...threads.values()];
}

/** `GET /repos/:o/:r/pulls`: rows as the Pull Requests page lists them. */
export function parseForgejoList(output: string, viewer: string | undefined): PullRequestListEntry[] {
  const me = viewer?.toLowerCase();
  return list(JSON.parse(output)).flatMap((raw): PullRequestListEntry[] => {
    const ref = parseRequestUrl(text(raw.html_url) ?? "");
    if (!ref) return [];
    const author = actor(raw.user);
    return [{
      ref,
      title: text(raw.title) ?? `#${ref.number}`,
      ...(author ? { author } : {}),
      headRef: text(record(raw.head).ref) ?? "",
      baseRef: text(record(raw.base).ref) ?? "",
      state: state(raw),
      draft: isDraft(raw),
      ...(raw.mergeable === true ? { mergeable: "mergeable" as const } : raw.mergeable === false && state(raw) === "open" ? { mergeable: "conflicting" as const } : {}),
      additions: count(raw.additions),
      deletions: count(raw.deletions),
      createdAt: text(raw.created_at) ?? "",
      updatedAt: text(raw.updated_at) ?? text(raw.created_at) ?? "",
      labels: labels(raw.labels),
      reviewRequested: Boolean(me) && list(raw.requested_reviewers).some((person) => actor(person)?.login.toLowerCase() === me),
    }];
  });
}

function asRequest(raw: Json): ReviewRequest | undefined {
  const ref = parseRequestUrl(text(raw.html_url) ?? "");
  const baseRef = text(record(raw.base).ref);
  if (!ref || !baseRef) return undefined;
  return {
    provider: "forgejo", number: ref.number, title: text(raw.title) ?? `#${ref.number}`, url: ref.url, baseRef,
    ...(text(record(raw.head).ref) ? { headRef: text(record(raw.head).ref) } : {}),
    state: state(raw),
    draft: isDraft(raw),
    ...(typeof raw.body === "string" ? { body: raw.body } : {}),
  };
}

const stripDraft = (title: string) => title.replace(DRAFT_PREFIX, "");

export function createForgejoProvider(tools: ProviderTools): SourceControlProvider {
  const kind = "forgejo" as const;
  let logins: { at: number; value: Promise<TeaLogin[]> } | undefined;

  const readLogins = (): Promise<TeaLogin[]> => {
    if (logins && tools.now() - logins.at < LOGINS_TTL_MS) return logins.value;
    const value = tools.cli(kind, { args: ["login", "list", "--output", "json"] }, "Reading tea's logins").then(parseTeaLogins);
    logins = { at: tools.now(), value };
    value.catch(() => { logins = undefined; });
    return value;
  };

  const login = async (host: string): Promise<TeaLogin> => {
    const found = loginFor(await readLogins(), host);
    if (!found) throw new HostCommandError(`tea has no login for ${host}. Run \`tea login add --url https://${host}\` in a terminal, then try again.`);
    return found;
  };

  /** One call of the server's API, signed by tea; a status of 400 or more rejects. */
  const api = async (host: string, path: string, action: string, init: { method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; body?: unknown; maxBuffer?: number } = {}): Promise<string> => {
    const account = await login(host);
    const method = init.method ?? "GET";
    return tools.cli(kind, {
      args: ["api", "--include", "--login", account.name, "--method", method, ...(init.body !== undefined ? ["--data", "@-"] : []), `${account.url}/api/v1/${path}`],
      ...(init.body !== undefined ? { input: JSON.stringify(init.body) } : {}),
    }, action, {
      host,
      ...(init.maxBuffer ? { maxBuffer: init.maxBuffer } : {}),
      inspect: (stdout, stderr) => {
        const status = Number(/^HTTP\/\S+ (\d{3})/mu.exec(stderr)?.[1]);
        if (!status) throw new Error("tea reported no HTTP status; update tea to a release with `tea api --include`.");
        if (status >= 400) {
          let detail = "";
          try { detail = text(record(JSON.parse(stdout)).message) ?? ""; } catch { detail = stdout.split("\n")[0] ?? ""; }
          throw new Error(`HTTP ${status}${status === 429 ? " rate limit" : ""}${detail ? `: ${detail}` : ""}`);
        }
      },
    });
  };

  const repoPath = (repo: string) => `repos/${repo.split("/").map(encodeURIComponent).join("/")}`;
  const pullPath = (ref: PullRequestRef) => `${repoPath(ref.repo)}/pulls/${ref.number}`;
  const issuePath = (ref: PullRequestRef) => `${repoPath(ref.repo)}/issues/${ref.number}`;
  const noun = (ref: PullRequestRef) => `PR #${ref.number}`;
  const json = async (host: string, path: string, action: string): Promise<unknown> => JSON.parse(await api(host, path, action));

  const readChecks = async (ref: PullRequestRef, sha: string | undefined): Promise<PullRequestCheck[]> => {
    if (!sha) return [];
    return parseForgejoChecks(await api(ref.host, `${repoPath(ref.repo)}/commits/${encodeURIComponent(sha)}/status`, `Reading the checks of ${noun(ref)}`));
  };

  const reviews = (ref: PullRequestRef, fresh: boolean) => tools.cached("reviews", ref, fresh, () => api(ref.host, `${pullPath(ref)}/reviews?limit=${PAGE}`, `Reading the reviews of ${noun(ref)}`));

  /** Posts one review: a verdict, its text and any line comments, on the head the view read. */
  const postReview = async (ref: PullRequestRef, event: string, body: string, comments: readonly LineCommentInput[], known: PullRequestDetail, action: string) => {
    await api(ref.host, `${pullPath(ref)}/reviews`, action, {
      method: "POST",
      body: {
        event,
        body,
        ...(known.headSha ? { commit_id: known.headSha } : {}),
        comments: comments.map((comment) => ({ path: comment.path, body: comment.body, ...(comment.side === "old" ? { old_position: comment.line } : { new_position: comment.line }) })),
      },
    });
  };

  return {
    kind,
    info: PROVIDERS.forgejo,
    missing: () => missingCli(kind, tools.findCommand),
    repository: forgejoRepository,
    requestUrl: ({ host, repo }, number) => `https://${host}/${repo}/pulls/${number}`,
    signedIn: async ({ host }) => Boolean(loginFor(await readLogins().catch(() => []), host)),
    viewer: async (host) => text(record(await json(host, "user", "Reading the signed-in account")).login),
    status: async () => {
      const found = await readLogins().catch(() => []);
      if (found.length === 0) return { signedIn: false, hint: "Run `tea login add --url https://<your server>` in a terminal." };
      const hostOf = (entry: TeaLogin) => { try { return new URL(entry.url).host; } catch { return entry.url; } };
      return { signedIn: true, account: found.map((entry) => `${entry.user ?? entry.name} on ${hostOf(entry)}`).join(", ") };
    },

    current: async ({ host, repo, branch }) => {
      const rows = list(await json(host, `${repoPath(repo)}/pulls?state=all&sort=recentupdate&limit=${PAGE}`, `Looking for the pull request of ${branch}`));
      const mine = rows.filter((row) => text(record(row.head).ref) === branch);
      const raw = mine.find((row) => state(row) === "open") ?? mine[0];
      const request = raw ? asRequest(raw) : undefined;
      if (!request || !raw) return undefined;
      const checks = await readChecks({ service: kind, host, repo, number: request.number, url: request.url }, text(record(raw.head).sha)).catch(() => []);
      const failed = checks.filter((check) => check.status === "failed" || check.status === "cancelled").length;
      const pending = checks.filter((check) => check.status === "pending").length;
      return checks.length > 0 ? { ...request, checks: { passed: checks.length - failed - pending, failed, pending, total: checks.length } } : request;
    },
    create: async ({ host, repo }, input) => {
      const created = record(JSON.parse(await api(host, `${repoPath(repo)}/pulls`, "Creating the pull request", {
        method: "POST",
        body: { title: input.draft ? `WIP: ${stripDraft(input.title)}` : input.title, body: input.body, base: input.base, head: input.head },
      })));
      return text(created.html_url);
    },
    merge: async ({ host, repo }, request, method) => {
      await api(host, `${repoPath(repo)}/pulls/${request.number}/merge`, `Merging PR #${request.number}`, { method: "POST", body: { Do: method } });
    },
    edit: async ({ host, repo }, request, input) => {
      await api(host, `${repoPath(repo)}/pulls/${request.number}`, `Editing PR #${request.number}`, { method: "PATCH", body: input });
    },
    setDraft: async ({ host, repo }, request, draft) => {
      const title = stripDraft(request.title);
      await api(host, `${repoPath(repo)}/pulls/${request.number}`, `Editing PR #${request.number}`, { method: "PATCH", body: { title: draft ? `WIP: ${title}` : title } });
    },

    list: async ({ host, repo }, input, viewer) => {
      const entries: PullRequestListEntry[] = [];
      const words = input.search?.toLowerCase();
      // Forgejo lists merged requests among the closed ones and searches no titles; both are narrowed here.
      const asked = input.state === "merged" ? "closed" : input.state;
      for (let page = 1; page <= MAX_LIST_PAGES && entries.length <= input.limit; page += 1) {
        const output = await api(host, `${repoPath(repo)}/pulls?state=${asked}&sort=recentupdate&page=${page}&limit=${PAGE}`, `Listing the pull requests of ${repo}`);
        const rows = parseForgejoList(output, viewer).filter((entry) =>
          (input.state !== "merged" || entry.state === "merged") && (input.state !== "closed" || entry.state === "closed")
          && (!words || entry.title.toLowerCase().includes(words) || `#${entry.ref.number}` === words));
        entries.push(...rows);
        if ((JSON.parse(output) as unknown[]).length < PAGE) break;
      }
      return { entries: entries.slice(0, input.limit), more: entries.length > input.limit };
    },

    detail: async (ref, fresh) => {
      const pull = await api(ref.host, pullPath(ref), `Reading ${noun(ref)}`);
      const sha = text(record(record(JSON.parse(pull)).head).sha);
      const [comments, reviewList, commits, checks] = await Promise.all([
        api(ref.host, `${issuePath(ref)}/comments`, `Reading the comments of ${noun(ref)}`),
        reviews(ref, fresh),
        api(ref.host, `${pullPath(ref)}/commits?limit=${PAGE}`, `Reading the commits of ${noun(ref)}`),
        readChecks(ref, sha).catch(() => []),
      ]);
      return parseForgejoDetail(ref, pull, comments, reviewList, commits, checks);
    },
    checks: async (ref) => {
      const pull = record(await json(ref.host, pullPath(ref), `Reading ${noun(ref)}`));
      return readChecks(ref, text(record(pull.head).sha));
    },
    threads: async (ref, fresh) => {
      const withComments = list(JSON.parse(await reviews(ref, fresh))).filter((review) => count(review.comments_count) > 0).slice(0, MAX_REVIEWS);
      const answers = await Promise.all(withComments.map((review) => api(ref.host, `${pullPath(ref)}/reviews/${String(review.id)}/comments`, `Reading the conversations of ${noun(ref)}`)));
      return parseForgejoThreads(answers);
    },
    changes: async (ref) => parseUnifiedDiff(await api(ref.host, `${pullPath(ref)}.diff`, `Reading the diff of ${noun(ref)}`, { maxBuffer: DIFF_BUFFER })),
    comment: async (ref, body) => { await api(ref.host, `${issuePath(ref)}/comments`, `Commenting on ${noun(ref)}`, { method: "POST", body: { body } }); },
    lineComment: async (ref, input, known) => { await postReview(ref, "COMMENT", "", [input], known, `Commenting on ${noun(ref)}`); },
    update: async (ref, input) => { await api(ref.host, pullPath(ref), `Editing ${noun(ref)}`, { method: "PATCH", body: input }); },
    review: async (ref, input, known) => {
      const event = input.event === "approve" ? "APPROVED" : input.event === "request-changes" ? "REQUEST_CHANGES" : "COMMENT";
      await postReview(ref, event, input.body, input.comments, known, `Submitting the review of ${noun(ref)}`);
      tools.drop("reviews", ref);
    },
    editComment: async (ref, input) => {
      await api(ref.host, `${repoPath(ref.repo)}/issues/comments/${encodeURIComponent(input.id)}`, `Editing a comment on ${noun(ref)}`, { method: "PATCH", body: { body: input.body } });
    },
    reviewers: async (ref, add, remove) => {
      const action = `Changing the reviewers of ${noun(ref)}`;
      if (add.length > 0) await api(ref.host, `${pullPath(ref)}/requested_reviewers`, action, { method: "POST", body: { reviewers: add } });
      if (remove.length > 0) await api(ref.host, `${pullPath(ref)}/requested_reviewers`, action, { method: "DELETE", body: { reviewers: remove } });
    },
    labels: async (ref, add, remove) => {
      const action = `Changing the labels of ${noun(ref)}`;
      const known = list(await json(ref.host, `${repoPath(ref.repo)}/labels?limit=${PAGE}`, action));
      const id = (name: string) => known.find((label) => text(label.name) === name)?.id;
      const adding = add.map(id).filter((value) => value !== undefined);
      if (adding.length < add.length) throw new HostCommandError(`${ref.repo} has no label named ${add.find((name) => id(name) === undefined)}.`);
      if (adding.length > 0) await api(ref.host, `${issuePath(ref)}/labels`, action, { method: "POST", body: { labels: adding } });
      for (const name of remove) {
        const found = id(name);
        if (found !== undefined) await api(ref.host, `${issuePath(ref)}/labels/${String(found)}`, action, { method: "DELETE" });
      }
    },
    candidates: async (ref) => {
      const [labelOutput, peopleOutput] = await Promise.all([
        api(ref.host, `${repoPath(ref.repo)}/labels?limit=${PAGE}`, `Reading the labels of ${ref.repo}`).catch(() => "[]"),
        api(ref.host, `${repoPath(ref.repo)}/assignees`, `Reading who can review ${noun(ref)}`).catch(() => "[]"),
      ]);
      return {
        labels: labels(JSON.parse(labelOutput)),
        reviewers: list(JSON.parse(peopleOutput)).flatMap((person) => { const name = actor(person)?.login; return name ? [name] : []; }),
      };
    },
  };
}
