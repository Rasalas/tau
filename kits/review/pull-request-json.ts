import type { UiDiffHunk, UiDiffLine, UiFileDiff } from "tau/host-extension";
import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestComment,
  PullRequestCommit,
  PullRequestDetail,
  PullRequestFile,
  PullRequestLabel,
  PullRequestRef,
  PullRequestReviewer,
  PullRequestThread,
  PullRequestVerdict,
  PullRequestViewedState,
} from "./protocol.js";
import { githubAutoMerge, gitlabAutoMerge } from "./branch-request-json.js";

/*
 * What `gh` and `glab` answer, turned into the view's own shapes. Every field
 * is read defensively: the CLIs add and rename fields across versions, and a
 * missing one must cost a blank, never the whole view.
 */

type Json = Record<string, unknown>;

const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * A request's web URL, by the path each host gives it: GitHub's `o/n/pull/7`,
 * GitLab's `g/sub/p/-/merge_requests/7`, Forgejo's `o/n/pulls/7`, Bitbucket's
 * `w/r/pull-requests/7` and Azure DevOps' `org/project/_git/repo/pullrequest/7`.
 */
export function parseRequestUrl(url: string): PullRequestRef | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  const path = parsed.pathname.replace(/\/+$/u, "");
  const at = (service: PullRequestRef["service"], repo: string, number: string, host = parsed.host): PullRequestRef =>
    ({ service, host, repo, number: Number(number), url: `${parsed.origin}${path}` });
  const gitlab = /^\/(.+?)\/-\/merge_requests\/(\d+)$/u.exec(path);
  if (gitlab) return at("gitlab", gitlab[1]!, gitlab[2]!);
  const github = /^\/([^/]+\/[^/]+)\/pull\/(\d+)$/u.exec(path);
  if (github) return at("github", github[1]!, github[2]!);
  const forgejo = /^\/([^/]+\/[^/]+)\/pulls\/(\d+)$/u.exec(path);
  if (forgejo) return at("forgejo", forgejo[1]!, forgejo[2]!);
  const bitbucket = /^\/([^/]+\/[^/]+)\/pull-requests\/(\d+)$/u.exec(path);
  if (bitbucket) return at("bitbucket", bitbucket[1]!, bitbucket[2]!);
  const azure = /^\/(.+)\/_git\/([^/]+)\/pullrequest\/(\d+)$/iu.exec(path);
  if (azure) {
    const before = azure[1]!.split("/").map((segment) => decodeURIComponent(segment));
    const repository = decodeURIComponent(azure[2]!);
    // A legacy host names the organization and may keep a collection segment before the project.
    const legacy = parsed.hostname.endsWith(".visualstudio.com");
    const organization = legacy ? parsed.hostname.split(".")[0] : before.length === 2 ? before[0] : undefined;
    const project = before.at(-1);
    if (organization && project && (!legacy || before.length <= 2)) return at("azure-devops", `${organization}/${project}/${repository}`, azure[3]!);
  }
  return undefined;
}

function actor(value: unknown): PullRequestActor | undefined {
  const raw = record(value);
  const login = text(raw.login) ?? text(raw.username);
  if (!login) return undefined;
  const name = text(raw.name);
  const bot = raw.is_bot === true || raw.bot === true || /\[bot\]$/u.test(login);
  return { login, ...(name && name !== login ? { name } : {}), ...(bot ? { bot } : {}) };
}

const GHOST: PullRequestActor = { login: "ghost" };

function githubVerdict(state: string | undefined): PullRequestVerdict {
  switch (state?.toUpperCase()) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes-requested";
    case "DISMISSED": return "dismissed";
    case "PENDING": return "pending";
    default: return "commented";
  }
}

const CHECK_CONCLUSIONS: Record<string, PullRequestCheckStatus> = {
  SUCCESS: "passed",
  FAILURE: "failed",
  ERROR: "failed",
  TIMED_OUT: "failed",
  STARTUP_FAILURE: "failed",
  CANCELLED: "cancelled",
  ACTION_REQUIRED: "action-required",
  SKIPPED: "skipped",
  NEUTRAL: "neutral",
  STALE: "neutral",
};

/** One row of `statusCheckRollup`: a check run (status + conclusion) or a commit status (state). */
export function githubCheckStatus(entry: Json): PullRequestCheckStatus {
  const conclusion = text(entry.conclusion)?.toUpperCase();
  if (conclusion && CHECK_CONCLUSIONS[conclusion]) return CHECK_CONCLUSIONS[conclusion];
  const state = text(entry.state)?.toUpperCase();
  if (state === "SUCCESS") return "passed";
  if (state === "FAILURE" || state === "ERROR") return "failed";
  return "pending";
}

/**
 * The rollup as rows, one per workflow and name, the newest run winning; a
 * name two workflows share is spelled `workflow / name`.
 */
export function parseGitHubChecks(rollup: unknown): PullRequestCheck[] {
  const newest = new Map<string, { at: string; check: PullRequestCheck }>();
  for (const entry of list(rollup)) {
    const name = text(entry.name) ?? text(entry.context);
    if (!name) continue;
    const workflow = text(entry.workflowName);
    const url = text(entry.detailsUrl) ?? text(entry.targetUrl);
    const description = text(entry.description);
    const status = githubCheckStatus(entry);
    const startedAt = text(entry.startedAt);
    const completedAt = text(entry.completedAt);
    const queued = status === "pending" && /^(QUEUED|WAITING|PENDING|REQUESTED)$/u.test(text(entry.status) ?? "");
    const check: PullRequestCheck = {
      name, status, ...(workflow ? { workflow } : {}), ...(url ? { url } : {}), ...(description ? { description } : {}),
      ...(startedAt ? { startedAt } : {}), ...(completedAt ? { completedAt } : {}), ...(queued ? { queued } : {}),
    };
    const key = `${workflow ?? ""}\0${name}`;
    const at = text(entry.startedAt) ?? text(entry.completedAt) ?? "";
    const current = newest.get(key);
    if (!current || at >= current.at) newest.set(key, { at, check });
  }
  const checks = [...newest.values()].map((entry) => entry.check);
  const names = new Map<string, number>();
  for (const check of checks) names.set(check.name, (names.get(check.name) ?? 0) + 1);
  return checks.map((check) => (names.get(check.name) ?? 0) > 1 && check.workflow ? { ...check, name: `${check.workflow} / ${check.name}` } : check);
}

function githubState(raw: Json): PullRequestDetail["state"] {
  const state = text(raw.state)?.toUpperCase();
  if (state === "MERGED" || text(raw.mergedAt)) return "merged";
  if (state === "CLOSED") return "closed";
  return "open";
}

/** Reviews carry the verdicts; a review request without one yet is "pending". */
function githubReviewers(raw: Json): PullRequestReviewer[] {
  const reviewers = new Map<string, PullRequestReviewer>();
  for (const request of list(raw.reviewRequests)) {
    const login = text(request.login) ?? text(request.slug) ?? text(request.name);
    if (login) reviewers.set(login, { login, verdict: "pending", ...(text(request.slug) ? { team: true } : {}) });
  }
  const reviews = list(raw.latestReviews).length > 0 ? list(raw.latestReviews) : list(raw.reviews);
  for (const review of reviews) {
    const who = actor(review.author);
    if (!who || who.login === text(record(raw.author).login)) continue;
    const verdict = githubVerdict(text(review.state));
    const known = reviewers.get(who.login);
    // A comment after a verdict does not undo the verdict.
    if (known && known.verdict !== "pending" && verdict === "commented") continue;
    reviewers.set(who.login, { login: who.login, verdict });
  }
  return [...reviewers.values()];
}

function githubLabels(value: unknown): PullRequestLabel[] {
  return list(value).flatMap((label) => {
    const name = text(label.name);
    const color = text(label.color);
    return name ? [{ name, ...(color && /^[0-9a-f]{6}$/iu.test(color) ? { color: color.toLowerCase() } : {}) }] : [];
  });
}

function githubComments(raw: Json): PullRequestComment[] {
  const comments: PullRequestComment[] = [];
  for (const comment of list(raw.comments)) {
    const body = typeof comment.body === "string" ? comment.body : "";
    const createdAt = text(comment.createdAt) ?? "";
    const url = text(comment.url);
    comments.push({ id: text(comment.id) ?? `comment-${createdAt}`, kind: "comment", author: actor(comment.author) ?? GHOST, body, createdAt, ...(url ? { url } : {}) });
  }
  for (const review of list(raw.reviews)) {
    const body = typeof review.body === "string" ? review.body : "";
    const verdict = githubVerdict(text(review.state));
    // A bodiless "commented" review is only the envelope of its line comments.
    if (verdict === "commented" && !body.trim()) continue;
    const createdAt = text(review.submittedAt) ?? text(review.createdAt) ?? "";
    comments.push({ id: text(review.id) ?? `review-${createdAt}`, kind: "review", author: actor(review.author) ?? GHOST, body, createdAt, verdict });
  }
  return comments.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function githubCommits(value: unknown): PullRequestCommit[] {
  return list(value).flatMap((commit) => {
    const oid = text(commit.oid);
    if (!oid) return [];
    const first = list(commit.authors)[0] ?? {};
    const author = text(first.login) ?? text(first.name);
    return [{
      oid,
      headline: text(commit.messageHeadline) ?? "",
      committedAt: text(commit.committedDate) ?? text(commit.authoredDate) ?? "",
      ...(author ? { author } : {}),
    }];
  });
}

/** `gh pr view <url> --json …` (see `GITHUB_VIEW_FIELDS`). */
export function parseGitHubDetail(ref: PullRequestRef, output: string): PullRequestDetail {
  const raw = record(JSON.parse(output));
  const author = actor(raw.author);
  const optional = {
    ...(text(raw.id) ? { nodeId: text(raw.id) } : {}),
    ...(author ? { author } : {}),
    ...(text(raw.createdAt) ? { createdAt: text(raw.createdAt) } : {}),
    ...(text(raw.updatedAt) ? { updatedAt: text(raw.updatedAt) } : {}),
    ...(text(raw.mergedAt) ? { mergedAt: text(raw.mergedAt) } : {}),
    ...(text(raw.closedAt) ? { closedAt: text(raw.closedAt) } : {}),
    ...(text(raw.headRefName) ? { headRef: text(raw.headRefName) } : {}),
    ...(text(raw.headRefOid) ? { headSha: text(raw.headRefOid) } : {}),
  };
  const autoMerge = githubAutoMerge(raw.autoMergeRequest);
  return {
    ref,
    ...optional,
    ...(autoMerge ? { autoMerge } : {}),
    title: text(raw.title) ?? `#${ref.number}`,
    body: typeof raw.body === "string" ? raw.body : "",
    state: githubState(raw),
    draft: raw.isDraft === true,
    baseRef: text(raw.baseRefName) ?? "",
    additions: count(raw.additions),
    deletions: count(raw.deletions),
    changedFiles: count(raw.changedFiles),
    reviewers: githubReviewers(raw),
    labels: githubLabels(raw.labels),
    checks: parseGitHubChecks(raw.statusCheckRollup),
    comments: githubComments(raw),
    commits: githubCommits(raw.commits),
  };
}

function githubViewed(state: string | undefined): PullRequestViewedState {
  if (state === "VIEWED") return "viewed";
  if (state === "DISMISSED") return "dismissed";
  return "unviewed";
}

/** Where a GraphQL connection carries on; undefined once it is read to its end. */
function nextCursor(connection: unknown): string | undefined {
  const info = record(record(connection).pageInfo);
  return info.hasNextPage === true ? text(info.endCursor) : undefined;
}

/**
 * The review threads and each file's viewed state, from one page of
 * `GITHUB_THREADS_QUERY`, with the cursors of the connections that go on.
 */
export function parseGitHubThreads(output: string): { threads: PullRequestThread[]; viewed: Map<string, PullRequestViewedState>; nodeId?: string; threadsAfter?: string; filesAfter?: string } {
  const request = record(record(record(record(JSON.parse(output)).data).repository).pullRequest);
  const threadsAfter = nextCursor(request.reviewThreads);
  const filesAfter = nextCursor(request.files);
  const threads = list(record(request.reviewThreads).nodes).flatMap((thread): PullRequestThread[] => {
    const id = text(thread.id);
    const path = text(thread.path);
    if (!id || !path) return [];
    const comments = list(record(thread.comments).nodes).map((comment): PullRequestComment => {
      const createdAt = text(comment.createdAt) ?? "";
      const url = text(comment.url);
      return { id: text(comment.id) ?? `${id}-${createdAt}`, kind: "review-comment", author: actor(comment.author) ?? GHOST, body: typeof comment.body === "string" ? comment.body : "", createdAt, ...(url ? { url } : {}) };
    });
    const line = typeof thread.line === "number" ? thread.line : typeof thread.originalLine === "number" ? thread.originalLine : undefined;
    return [{
      id,
      path,
      ...(line !== undefined ? { line } : {}),
      side: text(thread.diffSide)?.toUpperCase() === "LEFT" ? "old" : "new",
      resolved: thread.isResolved === true,
      outdated: thread.isOutdated === true,
      comments,
    }];
  });
  const viewed = new Map<string, PullRequestViewedState>();
  for (const file of list(record(request.files).nodes)) {
    const path = text(file.path);
    if (path) viewed.set(path, githubViewed(text(file.viewerViewedState)));
  }
  return {
    threads,
    viewed,
    ...(text(request.id) ? { nodeId: text(request.id) } : {}),
    ...(threadsAfter ? { threadsAfter } : {}),
    ...(filesAfter ? { filesAfter } : {}),
  };
}

function gitlabState(state: string | undefined): PullRequestDetail["state"] {
  const value = state?.toLowerCase();
  if (value === "merged") return "merged";
  if (value === "closed" || value === "locked") return "closed";
  return "open";
}

const GITLAB_PIPELINE: Record<string, PullRequestCheckStatus> = {
  success: "passed",
  failed: "failed",
  canceled: "cancelled",
  canceling: "cancelled",
  skipped: "skipped",
  manual: "neutral",
};

/** GitLab reports one pipeline per request; it becomes one check named "Pipeline". */
export function parseGitLabChecks(pipeline: unknown): PullRequestCheck[] {
  const raw = record(pipeline);
  const status = text(raw.status)?.toLowerCase();
  if (!status) return [];
  const url = text(raw.web_url);
  return [{ name: "Pipeline", status: GITLAB_PIPELINE[status] ?? "pending", description: status, ...(url ? { url } : {}) }];
}

/** A system note, or a note inside a discussion the view shows as a thread. */
function gitlabNotes(discussions: unknown): { comments: PullRequestComment[]; approvers: Set<string> } {
  const comments: PullRequestComment[] = [];
  const approvers = new Set<string>();
  for (const discussion of list(discussions)) {
    for (const note of list(discussion.notes)) {
      const author = actor(note.author) ?? GHOST;
      const body = typeof note.body === "string" ? note.body : "";
      if (note.system === true) {
        if (/^approved this merge request/iu.test(body)) approvers.add(author.login);
        if (/^unapproved this merge request/iu.test(body)) approvers.delete(author.login);
        continue;
      }
      // Line notes are threads; the timeline keeps the conversation on the request.
      if (text(note.type) === "DiffNote") continue;
      const createdAt = text(note.created_at) ?? "";
      comments.push({ id: String(note.id ?? `${text(discussion.id)}-${createdAt}`), kind: "comment", author, body, createdAt });
    }
  }
  return { comments: comments.sort((left, right) => left.createdAt.localeCompare(right.createdAt)), approvers };
}

/** `glab api projects/:path/merge_requests/:iid`, with its discussions and commits. */
export function parseGitLabDetail(ref: PullRequestRef, output: string, discussions: string, commits: string): PullRequestDetail {
  const raw = record(JSON.parse(output));
  const author = actor(raw.author);
  const notes = gitlabNotes(JSON.parse(discussions));
  const refs = record(raw.diff_refs);
  const diffRefs = text(refs.base_sha) && text(refs.head_sha) && text(refs.start_sha)
    ? { base: text(refs.base_sha)!, head: text(refs.head_sha)!, start: text(refs.start_sha)! }
    : undefined;
  const reviewers: PullRequestReviewer[] = list(raw.reviewers).flatMap((reviewer) => {
    const who = actor(reviewer);
    return who ? [{ login: who.login, verdict: notes.approvers.has(who.login) ? "approved" as const : "pending" as const }] : [];
  });
  for (const login of notes.approvers) {
    if (!reviewers.some((reviewer) => reviewer.login === login)) reviewers.push({ login, verdict: "approved" });
  }
  const labels = (Array.isArray(raw.labels) ? raw.labels : []).flatMap((label): PullRequestLabel[] => {
    if (typeof label === "string") return [{ name: label }];
    const name = text(record(label).name);
    const color = text(record(label).color)?.replace(/^#/u, "");
    return name ? [{ name, ...(color && /^[0-9a-f]{6}$/iu.test(color) ? { color: color.toLowerCase() } : {}) }] : [];
  });
  const changes = Number.parseInt(String(raw.changes_count ?? ""), 10);
  const autoMerge = gitlabAutoMerge(raw);
  return {
    ref,
    ...(autoMerge ? { autoMerge } : {}),
    ...(raw.id !== undefined ? { nodeId: String(raw.id) } : {}),
    ...(author ? { author } : {}),
    ...(text(raw.created_at) ? { createdAt: text(raw.created_at) } : {}),
    ...(text(raw.updated_at) ? { updatedAt: text(raw.updated_at) } : {}),
    ...(text(raw.merged_at) ? { mergedAt: text(raw.merged_at) } : {}),
    ...(text(raw.closed_at) ? { closedAt: text(raw.closed_at) } : {}),
    ...(text(raw.source_branch) ? { headRef: text(raw.source_branch) } : {}),
    ...(text(raw.sha) ? { headSha: text(raw.sha) } : {}),
    ...(diffRefs ? { diffRefs } : {}),
    title: text(raw.title) ?? `!${ref.number}`,
    body: typeof raw.description === "string" ? raw.description : "",
    state: gitlabState(text(raw.state)),
    draft: raw.draft === true || raw.work_in_progress === true,
    baseRef: text(raw.target_branch) ?? "",
    additions: 0,
    deletions: 0,
    changedFiles: Number.isFinite(changes) ? changes : 0,
    reviewers,
    labels,
    checks: parseGitLabChecks(raw.head_pipeline ?? raw.pipeline),
    comments: notes.comments,
    commits: list(JSON.parse(commits)).flatMap((commit) => {
      const oid = text(commit.id);
      const name = text(commit.author_name);
      return oid ? [{ oid, headline: text(commit.title) ?? "", committedAt: text(commit.committed_date) ?? text(commit.created_at) ?? "", ...(name ? { author: name } : {}) }] : [];
    }),
  };
}

/** Discussions whose first note sits on a line of the diff. */
export function parseGitLabThreads(output: string): PullRequestThread[] {
  return list(JSON.parse(output)).flatMap((discussion): PullRequestThread[] => {
    const notes = list(discussion.notes).filter((note) => note.system !== true);
    const first = notes[0];
    const position = record(first?.position);
    const path = text(position.new_path) ?? text(position.old_path);
    if (!first || text(first.type) !== "DiffNote" || !path) return [];
    const newLine = typeof position.new_line === "number" ? position.new_line : undefined;
    const oldLine = typeof position.old_line === "number" ? position.old_line : undefined;
    const line = newLine ?? oldLine;
    return [{
      id: String(discussion.id ?? first.id),
      path,
      ...(line !== undefined ? { line } : {}),
      side: newLine !== undefined ? "new" : "old",
      resolved: notes.some((note) => note.resolvable === true) && notes.every((note) => note.resolvable !== true || note.resolved === true),
      outdated: false,
      comments: notes.map((note) => ({ id: String(note.id), kind: "review-comment" as const, author: actor(note.author) ?? GHOST, body: typeof note.body === "string" ? note.body : "", createdAt: text(note.created_at) ?? "" })),
    }];
  });
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/** The hunks of one file's patch; anything before the first `@@` is skipped. */
export function parseHunks(patch: string): UiDiffHunk[] {
  const hunks: UiDiffHunk[] = [];
  let hunk: UiDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunk = { header: line, lines: [] };
      hunks.push(hunk);
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (!hunk) continue;
    const mark = line.charAt(0);
    let parsed: UiDiffLine | undefined;
    if (mark === "+") parsed = { kind: "added", newLine: newLine++, text: line.slice(1) };
    else if (mark === "-") parsed = { kind: "removed", oldLine: oldLine++, text: line.slice(1) };
    else if (mark === " ") parsed = { kind: "context", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) };
    if (parsed) hunk.lines.push(parsed);
  }
  return hunks;
}

function stripPrefix(path: string): string {
  const unquoted = path.startsWith("\"") && path.endsWith("\"") ? path.slice(1, -1) : path;
  return unquoted.replace(/^[ab]\//u, "");
}

function fileDiff(path: string, hunks: UiDiffHunk[], note?: string): UiFileDiff {
  let added = 0;
  let removed = 0;
  for (const line of hunks.flatMap((hunk) => hunk.lines)) {
    if (line.kind === "added") added += 1;
    else if (line.kind === "removed") removed += 1;
  }
  return { path, added, removed, hunks, ...(note ? { note } : {}) };
}

/** A whole `gh pr diff`: one entry per `diff --git` section, in the order Git printed them. */
export function parseUnifiedDiff(patch: string): Array<{ file: Omit<PullRequestFile, "viewed">; diff: UiFileDiff }> {
  const sections = patch.split(/^(?=diff --git )/mu).filter((section) => section.startsWith("diff --git "));
  return sections.map((section) => {
    const lines = section.split("\n");
    const header = /^diff --git (\S+|"[^"]+") (\S+|"[^"]+")$/u.exec(lines[0] ?? "");
    let oldPath = header ? stripPrefix(header[1]!) : "";
    let newPath = header ? stripPrefix(header[2]!) : "";
    let status: PullRequestFile["status"] = "modified";
    let binary = false;
    for (const line of lines.slice(1)) {
      if (line.startsWith("@@")) break;
      if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "deleted";
      else if (line.startsWith("rename from ")) { oldPath = line.slice("rename from ".length); status = "renamed"; }
      else if (line.startsWith("rename to ")) newPath = line.slice("rename to ".length);
      else if (line.startsWith("--- ") && line !== "--- /dev/null") oldPath = stripPrefix(line.slice(4).trim());
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") newPath = stripPrefix(line.slice(4).trim());
      else if (/^Binary files .* differ$/u.test(line)) binary = true;
    }
    const path = status === "deleted" ? oldPath : newPath;
    const diff = fileDiff(path, parseHunks(section), binary ? "Binary file" : undefined);
    return {
      file: { path, ...(status === "renamed" && oldPath !== newPath ? { previousPath: oldPath } : {}), status, added: diff.added, removed: diff.removed },
      diff,
    };
  });
}

/** `glab api …/merge_requests/:iid/diffs`: one object per file with its hunks as `diff`. */
export function parseGitLabDiffs(output: string): Array<{ file: Omit<PullRequestFile, "viewed">; diff: UiFileDiff }> {
  return list(JSON.parse(output)).flatMap((entry) => {
    const newPath = text(entry.new_path);
    const oldPath = text(entry.old_path) ?? newPath;
    if (!newPath || !oldPath) return [];
    const status: PullRequestFile["status"] = entry.new_file === true ? "added" : entry.deleted_file === true ? "deleted" : entry.renamed_file === true ? "renamed" : "modified";
    const path = status === "deleted" ? oldPath : newPath;
    const diff = fileDiff(path, parseHunks(typeof entry.diff === "string" ? entry.diff : ""));
    return [{ file: { path, ...(status === "renamed" ? { previousPath: oldPath } : {}), status, added: diff.added, removed: diff.removed }, diff }];
  });
}

const GITHUB_FILE_STATUS: Record<string, PullRequestFile["status"]> = { added: "added", removed: "deleted", renamed: "renamed" };

/**
 * `gh api --paginate …/pulls/N/files --jq '.[]'`: one file per line, each
 * with its own patch. GitHub leaves the patch out of a file too large to
 * show, so that file keeps its counts and says why it has no lines.
 */
export function parseGitHubFiles(output: string): Array<{ file: Omit<PullRequestFile, "viewed">; diff: UiFileDiff }> {
  return output.split("\n").filter((line) => line.trim()).flatMap((line) => {
    const entry = record(JSON.parse(line));
    const path = text(entry.filename);
    if (!path) return [];
    const status = GITHUB_FILE_STATUS[text(entry.status) ?? ""] ?? "modified";
    const previousPath = text(entry.previous_filename);
    const patch = typeof entry.patch === "string" ? entry.patch : undefined;
    const hunks = patch ? parseHunks(patch) : [];
    const diff: UiFileDiff = patch
      ? fileDiff(path, hunks)
      : { path, added: count(entry.additions), removed: count(entry.deletions), hunks: [], note: count(entry.additions) + count(entry.deletions) > 0 ? "GitHub shows no diff for this file; it is too large." : "Binary file" };
    return [{ file: { path, ...(status === "renamed" && previousPath ? { previousPath } : {}), status, added: diff.added, removed: diff.removed }, diff }];
  });
}

/** `gh pr diff` refuses a request over 300 files or too large a diff; the per-file listing still answers. */
export function isDiffTooLarge(message: string): boolean {
  return /too.?large|exceeded the maximum|maximum number of files|HTTP 406|maxBuffer|stdout maxBuffer length exceeded/iu.test(message);
}

/** A fingerprint of a file's change, so a local viewed mark knows when the file moved on. */
export function diffFingerprint(diff: UiFileDiff): string {
  let hash = 2166136261;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      const value = `${line.kind}${line.text}\n`;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    }
  }
  return (hash >>> 0).toString(16);
}
