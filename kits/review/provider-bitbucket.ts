import { HostCommandError } from "tau/host-extension";
import {
  PROVIDERS,
  type PullRequestActor,
  type PullRequestCheck,
  type PullRequestCheckStatus,
  type PullRequestComment,
  type PullRequestDetail,
  type PullRequestListEntry,
  type PullRequestListState,
  type PullRequestRef,
  type PullRequestReviewDecision,
  type PullRequestReviewer,
  type PullRequestThread,
  type PullRequestVerdict,
  type ReviewRequest,
} from "./protocol.js";
import type { GitCredential, ProviderTools, RepositoryTarget, SourceControlProvider } from "./provider.js";
import { parseRemote } from "./pull-request-hosting.js";
import { parseUnifiedDiff } from "./pull-request-json.js";
import { SERVICES } from "./request-cli.js";

/*
 * Bitbucket Cloud through its REST API. There is no Bitbucket CLI, so the
 * credential is the one Git's own credential helper holds: for the API host
 * first (an Atlassian API token with the account's email), then for
 * bitbucket.org. A username of `x-token-auth` marks an access token, sent as
 * a bearer token. Tau reads the credential when it needs it and keeps it in
 * memory for a minute; it never writes one.
 */

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;

export const BITBUCKET_API = "https://api.bitbucket.org/2.0";
const WEB_HOST = "bitbucket.org";
const PAGE = 50;
const MAX_PAGES = 20;

const STATES: Record<PullRequestListState, string[]> = { open: ["OPEN"], merged: ["MERGED"], closed: ["DECLINED", "SUPERSEDED"], all: ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"] };

function actor(value: unknown): PullRequestActor | undefined {
  const raw = record(value);
  const login = text(raw.nickname) ?? text(raw.username) ?? text(raw.display_name);
  if (!login) return undefined;
  const name = text(raw.display_name);
  return { login, ...(name && name !== login ? { name } : {}) };
}

const GHOST: PullRequestActor = { login: "former user" };

function state(value: unknown): "open" | "closed" | "merged" {
  const raw = text(value)?.toUpperCase();
  return raw === "MERGED" ? "merged" : raw === "OPEN" ? "open" : "closed";
}

const PARTICIPANT_VERDICTS: Record<string, PullRequestVerdict> = { approved: "approved", changes_requested: "changes-requested" };

function verdictOf(participant: Json): PullRequestVerdict {
  return PARTICIPANT_VERDICTS[text(participant.state) ?? ""] ?? (participant.approved === true ? "approved" : "pending");
}

function decision(participants: Json[]): PullRequestReviewDecision | undefined {
  const reviewers = participants.filter((entry) => text(entry.role) === "REVIEWER");
  if (participants.some((entry) => verdictOf(entry) === "changes-requested")) return "changes-requested";
  if (reviewers.length === 0) return undefined;
  return reviewers.every((entry) => verdictOf(entry) === "approved") ? "approved" : "review-required";
}

const htmlUrl = (raw: Json) => text(record(record(raw.links).html).href);

/** A request's web URL as the view addresses it: `https://bitbucket.org/<workspace>/<repo>/pull-requests/<id>`. */
function refOf(raw: Json, repo: string): PullRequestRef | undefined {
  const number = count(raw.id);
  if (!number) return undefined;
  const url = htmlUrl(raw) ?? `https://${WEB_HOST}/${repo}/pull-requests/${number}`;
  return { service: "bitbucket", host: WEB_HOST, repo, number, url };
}

const CHECK_STATES: Record<string, PullRequestCheckStatus> = { SUCCESSFUL: "passed", FAILED: "failed", INPROGRESS: "pending", STOPPED: "cancelled" };

/** `GET …/pullrequests/:id/statuses`: one check per build key. */
export function parseBitbucketChecks(output: string): PullRequestCheck[] {
  return list(record(JSON.parse(output)).values).flatMap((status) => {
    const name = text(status.name) ?? text(status.key);
    if (!name) return [];
    const url = text(status.url);
    const description = text(status.description);
    return [{ name, status: CHECK_STATES[text(status.state)?.toUpperCase() ?? ""] ?? "pending", ...(url ? { url } : {}), ...(description ? { description } : {}) }];
  });
}

export function parseBitbucketList(output: string, repo: string, viewer: string | undefined): PullRequestListEntry[] {
  const me = viewer?.toLowerCase();
  return list(record(JSON.parse(output)).values).flatMap((raw): PullRequestListEntry[] => {
    const ref = refOf(raw, repo);
    if (!ref) return [];
    const author = actor(raw.author);
    const participants = list(raw.participants);
    const reviewDecision = decision(participants);
    return [{
      ref,
      title: text(raw.title) ?? `#${ref.number}`,
      ...(author ? { author } : {}),
      headRef: text(record(record(raw.source).branch).name) ?? "",
      baseRef: text(record(record(raw.destination).branch).name) ?? "",
      state: state(raw.state),
      draft: raw.draft === true,
      additions: 0,
      deletions: 0,
      createdAt: text(raw.created_on) ?? "",
      updatedAt: text(raw.updated_on) ?? text(raw.created_on) ?? "",
      labels: [],
      ...(reviewDecision ? { reviewDecision } : {}),
      reviewRequested: Boolean(me) && participants.some((entry) => text(entry.role) === "REVIEWER" && actor(entry.user)?.login.toLowerCase() === me),
    }];
  });
}

/** The request, its general comments, commits, statuses and line counts, as the view reads them. */
export function parseBitbucketDetail(ref: PullRequestRef, pull: string, comments: string, commits: string, checks: PullRequestCheck[], diffstat: string): PullRequestDetail {
  const raw = record(JSON.parse(pull));
  const author = actor(raw.author);
  const reviewers = new Map<string, PullRequestReviewer>();
  const timeline: PullRequestComment[] = [];
  for (const reviewer of list(raw.reviewers)) {
    const login = actor(reviewer)?.login;
    if (login) reviewers.set(login, { login, verdict: "pending" });
  }
  for (const participant of list(raw.participants)) {
    const who = actor(participant.user);
    const verdict = verdictOf(participant);
    if (!who || (verdict === "pending" && !reviewers.has(who.login))) continue;
    reviewers.set(who.login, { login: who.login, verdict });
    const at = text(participant.participated_on);
    if (verdict !== "pending" && at) timeline.push({ id: `verdict-${who.login}`, kind: "review", author: who, body: "", createdAt: at, verdict });
  }
  for (const comment of list(record(JSON.parse(comments)).values)) {
    if (comment.deleted === true || comment.inline) continue;
    const createdAt = text(comment.created_on) ?? "";
    const url = htmlUrl(comment);
    timeline.push({ id: String(comment.id), kind: "comment", author: actor(comment.user) ?? GHOST, body: text(record(comment.content).raw) ?? "", createdAt, ...(url ? { url } : {}) });
  }
  const files = list(record(JSON.parse(diffstat)).values);
  const source = record(raw.source);
  return {
    ref,
    ...(author ? { author } : {}),
    ...(text(raw.created_on) ? { createdAt: text(raw.created_on) } : {}),
    ...(text(raw.updated_on) ? { updatedAt: text(raw.updated_on) } : {}),
    ...(state(raw.state) === "merged" && text(raw.updated_on) ? { mergedAt: text(raw.updated_on) } : {}),
    ...(state(raw.state) === "closed" && text(raw.updated_on) ? { closedAt: text(raw.updated_on) } : {}),
    ...(text(record(source.branch).name) ? { headRef: text(record(source.branch).name) } : {}),
    ...(text(record(source.commit).hash) ? { headSha: text(record(source.commit).hash) } : {}),
    title: text(raw.title) ?? `#${ref.number}`,
    body: typeof raw.description === "string" ? raw.description : "",
    state: state(raw.state),
    draft: raw.draft === true,
    baseRef: text(record(record(raw.destination).branch).name) ?? "",
    additions: files.reduce((sum, file) => sum + count(file.lines_added), 0),
    deletions: files.reduce((sum, file) => sum + count(file.lines_removed), 0),
    changedFiles: count(record(JSON.parse(diffstat)).size) || files.length,
    reviewers: [...reviewers.values()],
    labels: [],
    checks,
    comments: timeline.sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    commits: list(record(JSON.parse(commits)).values).flatMap((commit) => {
      const oid = text(commit.hash);
      const who = record(commit.author);
      const name = actor(who.user)?.login ?? text(who.raw)?.replace(/\s*<[^>]*>$/u, "");
      return oid ? [{ oid, headline: (text(commit.message) ?? "").split("\n")[0] ?? "", committedAt: text(commit.date) ?? "", ...(name ? { author: name } : {}) }] : [];
    }),
  };
}

/** Line comments and their replies as conversations, each rooted at the comment that started it. */
export function parseBitbucketThreads(comments: string): PullRequestThread[] {
  const rows = list(record(JSON.parse(comments)).values);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const rootOf = (row: Json): Json => {
    let current = row;
    for (let depth = 0; depth < 50; depth += 1) {
      const parent = byId.get(String(record(current.parent).id ?? ""));
      if (!parent) return current;
      current = parent;
    }
    return current;
  };
  const threads = new Map<string, PullRequestThread>();
  for (const row of rows) {
    if (row.deleted === true) continue;
    const root = rootOf(row);
    const inline = record(root.inline);
    const path = text(inline.path);
    if (!path) continue;
    const id = String(root.id);
    const createdAt = text(row.created_on) ?? "";
    const url = htmlUrl(row);
    const entry: PullRequestComment = { id: String(row.id), kind: "review-comment", author: actor(row.user) ?? GHOST, body: text(record(row.content).raw) ?? "", createdAt, ...(url ? { url } : {}) };
    const thread = threads.get(id);
    if (thread) { thread.comments.push(entry); continue; }
    const to = typeof inline.to === "number" ? inline.to : undefined;
    const from = typeof inline.from === "number" ? inline.from : undefined;
    const line = to ?? from;
    threads.set(id, { id, path, ...(line !== undefined ? { line } : {}), side: to !== undefined ? "new" : "old", resolved: Boolean(root.resolution), outdated: inline.outdated === true, comments: [entry] });
  }
  for (const thread of threads.values()) thread.comments.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return [...threads.values()];
}

function asRequest(raw: Json, repo: string, checks: PullRequestCheck[]): ReviewRequest | undefined {
  const ref = refOf(raw, repo);
  const baseRef = text(record(record(raw.destination).branch).name);
  if (!ref || !baseRef) return undefined;
  const failed = checks.filter((check) => check.status === "failed" || check.status === "cancelled").length;
  const pending = checks.filter((check) => check.status === "pending").length;
  return {
    provider: "bitbucket", number: ref.number, title: text(raw.title) ?? `#${ref.number}`, url: ref.url, baseRef,
    ...(text(record(record(raw.source).branch).name) ? { headRef: text(record(record(raw.source).branch).name) } : {}),
    state: state(raw.state),
    draft: raw.draft === true,
    ...(typeof raw.description === "string" ? { body: raw.description } : {}),
    ...(checks.length > 0 ? { checks: { passed: checks.length - failed - pending, failed, pending, total: checks.length } } : {}),
  };
}

export function createBitbucketProvider(tools: ProviderTools, env: Record<string, string | undefined>): SourceControlProvider {
  const kind = "bitbucket" as const;
  const api = (env.TAU_BITBUCKET_API_URL?.trim() || BITBUCKET_API).replace(/\/+$/u, "");
  const apiHost = (() => { try { return new URL(api).host; } catch { return "api.bitbucket.org"; } })();

  const credential = async (): Promise<GitCredential | undefined> => await tools.credential(apiHost) ?? await tools.credential(WEB_HOST);

  const authorization = async (): Promise<string> => {
    const found = await credential();
    if (!found) throw new HostCommandError(`Git's credential helper holds no Bitbucket credential. Store an API token for ${apiHost}: \`${SERVICES.bitbucket.login}\`.`);
    return found.username === "x-token-auth"
      ? `Bearer ${found.password}`
      : `Basic ${Buffer.from(`${found.username}:${found.password}`).toString("base64")}`;
  };

  const request = async (path: string, action: string, init: { method?: string; body?: unknown; accept?: string } = {}): Promise<string> => {
    const url = /^https?:/iu.test(path) ? path : `${api}/${path}`;
    // A `next` link comes from an answer; the credential goes to the API and nowhere else.
    if (!url.startsWith(`${api}/`)) throw new HostCommandError(`${action} failed: Bitbucket pointed outside ${apiHost}.`);
    const answer = await tools.http(kind, url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: await authorization(),
        ...(init.accept ? { Accept: init.accept } : {}),
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      action,
      host: WEB_HOST,
    });
    return answer.text();
  };

  /** Every page of a paged listing, `next` link after `next` link. */
  const pages = async (path: string, action: string): Promise<string> => {
    const values: unknown[] = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < MAX_PAGES; page += 1) {
      const answer = record(JSON.parse(await request(next, action)));
      values.push(...(Array.isArray(answer.values) ? answer.values : []));
      next = text(answer.next);
    }
    return JSON.stringify({ values, size: values.length });
  };

  const repoPath = (repo: string) => `repositories/${repo.split("/").map(encodeURIComponent).join("/")}`;
  const pullPath = (ref: PullRequestRef) => `${repoPath(ref.repo)}/pullrequests/${ref.number}`;
  const noun = (ref: PullRequestRef) => `PR #${ref.number}`;
  const comments = (ref: PullRequestRef, fresh: boolean) => tools.cached("comments", ref, fresh, () => pages(`${pullPath(ref)}/comments?pagelen=100`, `Reading the comments of ${noun(ref)}`));
  const checks = async (ref: PullRequestRef) => parseBitbucketChecks(await request(`${pullPath(ref)}/statuses?pagelen=${PAGE}`, `Reading the checks of ${noun(ref)}`));
  const refFor = (target: RepositoryTarget, number: number): PullRequestRef => ({ service: kind, host: WEB_HOST, repo: target.repo, number, url: `https://${WEB_HOST}/${target.repo}/pull-requests/${number}` });

  /** Bitbucket's PUT replaces the title with what it is given, so the current one goes along. */
  const put = async (ref: PullRequestRef, fields: { title?: string; description?: string; draft?: boolean }, action: string) => {
    const title = fields.title ?? text(record(JSON.parse(await request(pullPath(ref), action))).title);
    await request(pullPath(ref), action, { method: "PUT", body: { ...fields, ...(title ? { title } : {}) } });
  };

  const post = (ref: PullRequestRef, body: unknown, action: string) => request(`${pullPath(ref)}/comments`, action, { method: "POST", body });

  return {
    kind,
    info: PROVIDERS.bitbucket,
    missing: () => tools.findCommand("git") ? undefined : "Git is not installed or not on your PATH; Tau reads Bitbucket's credential from Git's credential helper.",
    repository: (remoteUrl) => {
      const found = parseRemote(remoteUrl);
      // Bitbucket Data Center speaks another API; only the cloud is reached.
      return found && found.host === WEB_HOST && found.repo.split("/").length === 2 ? { host: WEB_HOST, repo: found.repo } : undefined;
    },
    requestUrl: ({ repo }, number) => `https://${WEB_HOST}/${repo}/pull-requests/${number}`,
    signedIn: async () => Boolean(await credential()),
    viewer: async () => actor(JSON.parse(await request("user", "Reading the signed-in account")))?.login,
    status: async () => {
      const found = await credential();
      if (!found) return { signedIn: false, hint: `Store an API token for ${apiHost} in Git's credential helper: \`${SERVICES.bitbucket.login}\`.` };
      return { signedIn: true, account: found.username === "x-token-auth" ? "an access token" : found.username };
    },

    current: async (target) => {
      const query = new URLSearchParams({ q: `source.branch.name = "${target.branch.replace(/["\\]/gu, "")}"`, pagelen: "10", sort: "-updated_on" });
      for (const value of STATES.all) query.append("state", value);
      const rows = list(record(JSON.parse(await request(`${repoPath(target.repo)}/pullrequests?${query.toString()}`, `Looking for the pull request of ${target.branch}`))).values)
        .filter((row) => text(record(record(row.source).branch).name) === target.branch);
      const raw = rows.find((row) => state(row.state) === "open") ?? rows[0];
      if (!raw) return undefined;
      const found = await checks(refFor(target, count(raw.id))).catch(() => []);
      return asRequest(raw, target.repo, found);
    },
    create: async (target, input) => {
      const created = record(JSON.parse(await request(`${repoPath(target.repo)}/pullrequests`, "Creating the pull request", {
        method: "POST",
        body: { title: input.title, description: input.body, source: { branch: { name: input.head } }, destination: { branch: { name: input.base } }, draft: input.draft },
      })));
      return htmlUrl(created);
    },
    merge: async (target, current, method, options = {}) => {
      const body = { merge_strategy: method === "squash" ? "squash" : "merge_commit", ...(options.deleteBranch ? { close_source_branch: true } : {}) };
      await request(`${pullPath(refFor(target, current.number))}/merge`, `Merging PR #${current.number}`, { method: "POST", body });
      return options.deleteBranch && current.headRef ? { branchDeleted: current.headRef } : undefined;
    },
    edit: async (target, current, input) => {
      await put(refFor(target, current.number), { title: input.title ?? current.title, ...(input.body !== undefined ? { description: input.body } : {}) }, `Editing PR #${current.number}`);
    },
    setDraft: async (target, current, draft) => {
      await put(refFor(target, current.number), { title: current.title, draft }, `Editing PR #${current.number}`);
    },

    list: async ({ repo }, input, viewer) => {
      const query = new URLSearchParams({ pagelen: String(PAGE), sort: "-updated_on", fields: "+values.participants" });
      for (const value of STATES[input.state]) query.append("state", value);
      if (input.search) query.set("q", `title ~ "${input.search.replace(/["\\]/gu, "")}"`);
      const entries: PullRequestListEntry[] = [];
      let next: string | undefined = `${repoPath(repo)}/pullrequests?${query.toString()}`;
      for (let page = 0; next && page < MAX_PAGES && entries.length <= input.limit; page += 1) {
        const output = await request(next, `Listing the pull requests of ${repo}`);
        entries.push(...parseBitbucketList(output, repo, viewer));
        next = text(record(JSON.parse(output)).next);
      }
      return { entries: entries.slice(0, input.limit), more: entries.length > input.limit || (entries.length === input.limit && Boolean(next)) };
    },

    detail: async (ref, fresh) => {
      const [pull, commentList, commits, found, diffstat] = await Promise.all([
        request(pullPath(ref), `Reading ${noun(ref)}`),
        comments(ref, fresh),
        request(`${pullPath(ref)}/commits?pagelen=${PAGE}`, `Reading the commits of ${noun(ref)}`),
        checks(ref).catch(() => []),
        pages(`${pullPath(ref)}/diffstat?pagelen=100`, `Reading the files of ${noun(ref)}`).catch(() => "{}"),
      ]);
      return parseBitbucketDetail(ref, pull, commentList, commits, found, diffstat);
    },
    checks,
    threads: async (ref, fresh) => parseBitbucketThreads(await comments(ref, fresh)),
    changes: async (ref) => parseUnifiedDiff(await request(`${pullPath(ref)}/diff`, `Reading the diff of ${noun(ref)}`, { accept: "text/plain" })),
    comment: async (ref, body) => { await post(ref, { content: { raw: body } }, `Commenting on ${noun(ref)}`); },
    reply: async (ref, threadId, body) => { await post(ref, { content: { raw: body }, parent: { id: Number(threadId) } }, `Commenting on ${noun(ref)}`); },
    lineComment: async (ref, input) => {
      await post(ref, { content: { raw: input.body }, inline: { path: input.path, ...(input.side === "old" ? { from: input.line } : { to: input.line }) } }, `Commenting on ${noun(ref)}`);
    },
    update: async (ref, input) => { await put(ref, { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.body !== undefined ? { description: input.body } : {}) }, `Editing ${noun(ref)}`); },
    /** A review is its parts: the line comments, the text as a comment, then the approval or the request for changes. */
    review: async (ref, input) => {
      const action = `Submitting the review of ${noun(ref)}`;
      for (const comment of input.comments) {
        await post(ref, { content: { raw: comment.body }, inline: { path: comment.path, ...(comment.side === "old" ? { from: comment.line } : { to: comment.line }) } }, action);
      }
      if (input.body) await post(ref, { content: { raw: input.body } }, action);
      if (input.event === "approve") await request(`${pullPath(ref)}/approve`, `Approving ${noun(ref)}`, { method: "POST" });
      if (input.event === "request-changes") await request(`${pullPath(ref)}/request-changes`, `Requesting changes on ${noun(ref)}`, { method: "POST" });
    },
    editComment: async (ref, input) => {
      await request(`${pullPath(ref)}/comments/${encodeURIComponent(input.id)}`, `Editing a comment on ${noun(ref)}`, { method: "PUT", body: { content: { raw: input.body } } });
    },
  };
}
