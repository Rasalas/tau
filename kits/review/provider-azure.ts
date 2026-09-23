import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { ProviderTools, RepositoryTarget, SourceControlProvider } from "./provider.js";
import { missingCli } from "./provider-github.js";

/*
 * Azure DevOps through `az repos` from the Azure CLI's DevOps extension,
 * signed in with `az login` or `az devops login`. The CLI has no diff and
 * no labels, so the Code tab and labels stay hidden; conversations and
 * comments go through `az devops invoke` on the threads API. A repository
 * is `organization/project/repository` below `dev.azure.com` or a legacy
 * `<organization>.visualstudio.com`.
 */

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;

const API_VERSION = "7.1";
const MAX_LIST = 500;
const STATUS: Record<PullRequestListState, string> = { open: "active", merged: "completed", closed: "abandoned", all: "all" };

/** `https://dev.azure.com/o/p/_git/r`, `git@ssh.dev.azure.com:v3/o/p/r` and the legacy `o.visualstudio.com` spellings. */
export function azureRepository(remoteUrl: string): RepositoryTarget | undefined {
  const value = remoteUrl.trim();
  const decode = (segments: string[]) => segments.map((segment) => { try { return decodeURIComponent(segment); } catch { return segment; } });
  const ssh = /^(?:[^@/]+@)?(ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/iu.exec(value);
  if (ssh) {
    const [organization, project, repository] = decode([ssh[2]!, ssh[3]!, ssh[4]!]);
    const legacy = ssh[1]!.toLowerCase().startsWith("vs-ssh");
    return { host: legacy ? `${organization!.toLowerCase()}.visualstudio.com` : "dev.azure.com", repo: `${organization}/${project}/${repository}` };
  }
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  const segments = decode(url.pathname.split("/").filter(Boolean));
  const git = segments.findIndex((segment) => segment.toLowerCase() === "_git");
  const repository = segments[git + 1]?.replace(/\.git$/u, "");
  const project = segments[git - 1];
  if (git < 1 || !repository || !project) return undefined;
  const hostname = url.hostname.toLowerCase();
  if (hostname === "dev.azure.com") return git === 2 ? { host: hostname, repo: `${segments[0]}/${project}/${repository}` } : undefined;
  if (hostname.endsWith(".visualstudio.com")) return { host: hostname, repo: `${hostname.split(".")[0]}/${project}/${repository}` };
  return undefined;
}

interface Place { organizationUrl: string; organization: string; project: string; repository: string; web: string }

function place(host: string, repo: string): Place {
  const [organization = "", project = "", repository = ""] = repo.split("/");
  const organizationUrl = host === "dev.azure.com" ? `https://dev.azure.com/${organization}` : `https://${host}`;
  const encode = (segment: string) => encodeURIComponent(segment);
  return { organizationUrl, organization, project, repository, web: `${organizationUrl}/${encode(project)}/_git/${encode(repository)}` };
}

const branchName = (ref: unknown) => text(ref)?.replace(/^refs\/heads\//u, "");

function actor(value: unknown): PullRequestActor | undefined {
  const raw = record(value);
  const login = text(raw.uniqueName) ?? text(raw.displayName);
  if (!login) return undefined;
  const name = text(raw.displayName);
  return { login, ...(name && name !== login ? { name } : {}) };
}

const GHOST: PullRequestActor = { login: "unknown" };

function state(raw: Json): "open" | "closed" | "merged" {
  const status = text(raw.status)?.toLowerCase();
  return status === "completed" ? "merged" : status === "abandoned" ? "closed" : "open";
}

/** Azure's votes: 10 approved, 5 approved with suggestions, 0 none, -5 waiting for the author, -10 rejected. */
function verdict(vote: unknown): PullRequestVerdict {
  const value = typeof vote === "number" ? vote : 0;
  return value > 0 ? "approved" : value < 0 ? "changes-requested" : "pending";
}

function decision(reviewers: Json[]): PullRequestReviewDecision | undefined {
  if (reviewers.length === 0) return undefined;
  if (reviewers.some((reviewer) => verdict(reviewer.vote) === "changes-requested")) return "changes-requested";
  const required = reviewers.filter((reviewer) => reviewer.isRequired === true);
  return (required.length > 0 ? required : reviewers).every((reviewer) => verdict(reviewer.vote) === "approved") ? "approved" : "review-required";
}

const POLICY_STATES: Record<string, PullRequestCheckStatus> = { approved: "passed", rejected: "failed", broken: "failed", running: "pending", queued: "pending", notapplicable: "skipped" };

/** `az repos pr policy list`: one check per policy that applies. */
export function parseAzurePolicies(output: string): PullRequestCheck[] {
  return list(JSON.parse(output)).flatMap((evaluation) => {
    const configuration = record(evaluation.configuration);
    if (configuration.isEnabled === false) return [];
    const kind = text(record(configuration.type).displayName);
    const name = text(record(configuration.settings).displayName) ?? text(record(evaluation.context).buildDefinitionName) ?? kind;
    if (!name) return [];
    const status = POLICY_STATES[text(evaluation.status)?.toLowerCase() ?? ""] ?? "pending";
    return [{ name, status, ...(kind && kind !== name ? { workflow: kind } : {}), ...(configuration.isBlocking === false ? { description: "optional" } : {}) }];
  });
}

export function parseAzureList(output: string, host: string, repo: string, viewer: string | undefined): PullRequestListEntry[] {
  const me = viewer?.toLowerCase();
  const { web } = place(host, repo);
  return list(JSON.parse(output)).flatMap((raw): PullRequestListEntry[] => {
    const number = typeof raw.pullRequestId === "number" ? raw.pullRequestId : undefined;
    if (!number) return [];
    const author = actor(raw.createdBy);
    const reviewers = list(raw.reviewers);
    const reviewDecision = decision(reviewers);
    const conflicting = text(raw.mergeStatus)?.toLowerCase() === "conflicts";
    return [{
      ref: { service: "azure-devops", host, repo, number, url: `${web}/pullrequest/${number}` },
      title: text(raw.title) ?? `#${number}`,
      ...(author ? { author } : {}),
      headRef: branchName(raw.sourceRefName) ?? "",
      baseRef: branchName(raw.targetRefName) ?? "",
      state: state(raw),
      draft: raw.isDraft === true,
      ...(conflicting ? { mergeable: "conflicting" as const } : text(raw.mergeStatus)?.toLowerCase() === "succeeded" ? { mergeable: "mergeable" as const } : {}),
      additions: 0,
      deletions: 0,
      createdAt: text(raw.creationDate) ?? "",
      updatedAt: text(raw.closedDate) ?? text(raw.creationDate) ?? "",
      labels: list(raw.labels).flatMap((label) => text(label.name) ? [{ name: text(label.name)! }] : []),
      ...(reviewDecision ? { reviewDecision } : {}),
      reviewRequested: Boolean(me) && reviewers.some((reviewer) => text(reviewer.uniqueName)?.toLowerCase() === me && verdict(reviewer.vote) === "pending"),
    }];
  });
}

const RESOLVED = new Set(["fixed", "closed", "bydesign", "wontfix"]);

const textComments = (thread: Json) => list(thread.comments).filter((comment) => text(comment.commentType)?.toLowerCase() !== "system" && comment.isDeleted !== true);

/** Threads on a file are conversations; the others' comments are the request's own. */
export function parseAzureThreads(output: string): { threads: PullRequestThread[]; comments: PullRequestComment[] } {
  const threads: PullRequestThread[] = [];
  const comments: PullRequestComment[] = [];
  for (const thread of list(record(JSON.parse(output)).value)) {
    if (thread.isDeleted === true) continue;
    const id = String(thread.id);
    const entries = textComments(thread).map((comment): PullRequestComment => ({
      id: `${id}:${String(comment.id)}`,
      kind: "review-comment",
      author: actor(comment.author) ?? GHOST,
      body: typeof comment.content === "string" ? comment.content : "",
      createdAt: text(comment.publishedDate) ?? "",
    }));
    if (entries.length === 0) continue;
    const context = record(thread.threadContext);
    const path = text(context.filePath)?.replace(/^\/+/u, "");
    if (!path) {
      comments.push(...entries.map((entry) => ({ ...entry, kind: "comment" as const })));
      continue;
    }
    const right = record(context.rightFileStart).line;
    const left = record(context.leftFileStart).line;
    const line = typeof right === "number" ? right : typeof left === "number" ? left : undefined;
    threads.push({ id, path, ...(line !== undefined ? { line } : {}), side: typeof right === "number" ? "new" : "old", resolved: RESOLVED.has(text(thread.status)?.toLowerCase() ?? ""), outdated: false, comments: entries });
  }
  return { threads, comments: comments.sort((left, right) => left.createdAt.localeCompare(right.createdAt)) };
}

export function parseAzureDetail(ref: PullRequestRef, pull: string, threads: string, commits: string, checks: PullRequestCheck[]): PullRequestDetail {
  const raw = record(JSON.parse(pull));
  const author = actor(raw.createdBy);
  const reviewers: PullRequestReviewer[] = list(raw.reviewers).flatMap((reviewer) => {
    const who = actor(reviewer);
    return who ? [{ login: who.login, verdict: verdict(reviewer.vote), ...(reviewer.isContainer === true ? { team: true } : {}) }] : [];
  });
  const closed = text(raw.closedDate);
  return {
    ref,
    ...(author ? { author } : {}),
    ...(text(raw.creationDate) ? { createdAt: text(raw.creationDate) } : {}),
    ...(closed ? { updatedAt: closed } : text(raw.creationDate) ? { updatedAt: text(raw.creationDate) } : {}),
    ...(state(raw) === "merged" && closed ? { mergedAt: closed } : {}),
    ...(state(raw) === "closed" && closed ? { closedAt: closed } : {}),
    ...(branchName(raw.sourceRefName) ? { headRef: branchName(raw.sourceRefName) } : {}),
    ...(text(record(raw.lastMergeSourceCommit).commitId) ? { headSha: text(record(raw.lastMergeSourceCommit).commitId) } : {}),
    title: text(raw.title) ?? `#${ref.number}`,
    body: typeof raw.description === "string" ? raw.description : "",
    state: state(raw),
    draft: raw.isDraft === true,
    baseRef: branchName(raw.targetRefName) ?? "",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    reviewers,
    labels: list(raw.labels).flatMap((label) => text(label.name) ? [{ name: text(label.name)! }] : []),
    checks,
    comments: parseAzureThreads(threads).comments,
    commits: list(record(JSON.parse(commits)).value).flatMap((commit) => {
      const oid = text(commit.commitId);
      const who = record(commit.author);
      return oid ? [{ oid, headline: (text(commit.comment) ?? "").split("\n")[0] ?? "", committedAt: text(who.date) ?? "", ...(text(who.name) ? { author: text(who.name) } : {}) }] : [];
    }),
  };
}

export function createAzureProvider(tools: ProviderTools): SourceControlProvider {
  const kind = "azure-devops" as const;
  const noun = (ref: PullRequestRef) => `PR #${ref.number}`;

  const az = async (target: { host: string; repo: string }, args: string[], action: string): Promise<string> => {
    const { organizationUrl } = place(target.host, target.repo);
    return tools.cli(kind, { args: [...args, "--organization", organizationUrl, "--output", "json", "--only-show-errors"] }, action, { host: target.host });
  };
  const inRepository = (target: { host: string; repo: string }) => {
    const { project, repository } = place(target.host, target.repo);
    return ["--project", project, "--repository", repository];
  };

  /** One call of the threads API; a body goes through a file of its own, removed afterwards. */
  const invoke = async (ref: PullRequestRef, resource: string, route: Record<string, string | number>, action: string, method = "GET", body?: unknown): Promise<string> => {
    const { project, repository } = place(ref.host, ref.repo);
    const routes = Object.entries({ project, repositoryId: repository, pullRequestId: ref.number, ...route }).map(([key, value]) => `${key}=${value}`);
    const args = ["devops", "invoke", "--area", "git", "--resource", resource, "--route-parameters", ...routes, "--http-method", method, "--api-version", API_VERSION];
    if (body === undefined) return az(ref, args, action);
    const folder = await mkdtemp(join(tmpdir(), "tau-az-"));
    try {
      const file = join(folder, "body.json");
      await writeFile(file, JSON.stringify(body), { mode: 0o600 });
      return await az(ref, [...args, "--in-file", file], action);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  };

  const threads = (ref: PullRequestRef, fresh: boolean) => tools.cached("az-threads", ref, fresh, () => invoke(ref, "pullRequestThreads", {}, `Reading the conversations of ${noun(ref)}`));
  const checks = async (ref: PullRequestRef) => parseAzurePolicies(await az(ref, ["repos", "pr", "policy", "list", "--id", String(ref.number)], `Reading the checks of ${noun(ref)}`));
  const refFor = (target: RepositoryTarget, number: number): PullRequestRef => ({ service: kind, host: target.host, repo: target.repo, number, url: `${place(target.host, target.repo).web}/pullrequest/${number}` });
  const update = (target: RepositoryTarget, number: number, args: string[], action: string) =>
    az({ host: target.host, repo: target.repo }, ["repos", "pr", "update", "--id", String(number), ...args], action);

  return {
    kind,
    info: PROVIDERS["azure-devops"],
    missing: () => missingCli(kind, tools.findCommand),
    repository: azureRepository,
    requestUrl: (target, number) => `${place(target.host, target.repo).web}/pullrequest/${number}`,
    signedIn: async (target) => {
      try {
        await az(target, ["repos", "show", ...inRepository(target)], "Checking the sign-in");
        return true;
      } catch (error) {
        // Without the DevOps extension no sign-in helps; say so instead.
        if (error instanceof Error && /azure-devops|extension/iu.test(error.message)) throw new HostCommandError("The Azure CLI needs its DevOps extension. Run `az extension add --name azure-devops` in a terminal, then try again.");
        return false;
      }
    },
    viewer: async () => text(record(record(JSON.parse(await tools.cli(kind, { args: ["account", "show", "--output", "json", "--only-show-errors"] }, "Reading the signed-in account"))).user).name),
    status: async () => {
      const extension = await tools.cli(kind, { args: ["extension", "show", "--name", "azure-devops", "--output", "json", "--only-show-errors"] }, "Checking the DevOps extension").then(() => true, () => false);
      if (!extension) return { hint: "Add the DevOps extension: `az extension add --name azure-devops`." };
      const account = await tools.cli(kind, { args: ["account", "show", "--output", "json", "--only-show-errors"] }, "Checking the sign-in")
        .then((output) => text(record(record(JSON.parse(output)).user).name), () => undefined);
      // A personal access token from `az devops login` shows only when a repository is asked.
      return account ? { signedIn: true, account } : { hint: "Sign in with `az login`, or with a personal access token through `az devops login`." };
    },

    current: async (target) => {
      const rows = list(JSON.parse(await az(target, ["repos", "pr", "list", ...inRepository(target), "--source-branch", target.branch, "--status", "all", "--top", "10"], `Looking for the pull request of ${target.branch}`)))
        .filter((row) => branchName(row.sourceRefName) === target.branch);
      const raw = rows.find((row) => state(row) === "open") ?? rows[0];
      const number = typeof raw?.pullRequestId === "number" ? raw.pullRequestId : undefined;
      if (!raw || !number) return undefined;
      const ref = refFor(target, number);
      const found = await checks(ref).catch(() => []);
      const failed = found.filter((check) => check.status === "failed" || check.status === "cancelled").length;
      const pending = found.filter((check) => check.status === "pending").length;
      const request: ReviewRequest = {
        provider: kind, number, title: text(raw.title) ?? `#${number}`, url: ref.url, baseRef: branchName(raw.targetRefName) ?? "",
        ...(branchName(raw.sourceRefName) ? { headRef: branchName(raw.sourceRefName) } : {}),
        state: state(raw), draft: raw.isDraft === true,
        ...(typeof raw.description === "string" ? { body: raw.description } : {}),
        ...(found.length > 0 ? { checks: { passed: found.length - failed - pending, failed, pending, total: found.length } } : {}),
      };
      return request;
    },
    create: async (target, input) => {
      const created = record(JSON.parse(await az(target, [
        "repos", "pr", "create", ...inRepository(target), "--source-branch", input.head, "--target-branch", input.base,
        "--title", input.title, "--description", input.body || " ", ...(input.draft ? ["--draft", "true"] : []),
      ], "Creating the pull request")));
      return typeof created.pullRequestId === "number" ? refFor(target, created.pullRequestId).url : undefined;
    },
    merge: async (target, request, method) => {
      await update(target, request.number, ["--status", "completed", "--squash", method === "squash" ? "true" : "false"], `Merging PR #${request.number}`);
    },
    edit: async (target, request, input) => {
      await update(target, request.number, [...(input.title !== undefined ? ["--title", input.title] : []), ...(input.body !== undefined ? ["--description", input.body || " "] : [])], `Editing PR #${request.number}`);
    },
    setDraft: async (target, request, draft) => {
      await update(target, request.number, ["--draft", draft ? "true" : "false"], `Editing PR #${request.number}`);
    },

    list: async (target, input, viewer) => {
      const top = input.search ? MAX_LIST : input.limit + 1;
      const output = await az(target, ["repos", "pr", "list", ...inRepository(target), "--status", STATUS[input.state], "--top", String(top)], `Listing the pull requests of ${place(target.host, target.repo).repository}`);
      const words = input.search?.toLowerCase();
      // `az` searches nothing; the rows are narrowed here.
      const entries = parseAzureList(output, target.host, target.repo, viewer).filter((entry) => !words || entry.title.toLowerCase().includes(words) || `#${entry.ref.number}` === words);
      return { entries: entries.slice(0, input.limit), more: entries.length > input.limit };
    },

    detail: async (ref, fresh) => {
      const [pull, threadList, commits, found] = await Promise.all([
        az(ref, ["repos", "pr", "show", "--id", String(ref.number)], `Reading ${noun(ref)}`),
        threads(ref, fresh),
        invoke(ref, "pullRequestCommits", {}, `Reading the commits of ${noun(ref)}`).catch(() => "{}"),
        checks(ref).catch(() => []),
      ]);
      return parseAzureDetail(ref, pull, threadList, commits, found);
    },
    checks,
    threads: async (ref, fresh) => parseAzureThreads(await threads(ref, fresh)).threads,
    comment: async (ref, body) => {
      await invoke(ref, "pullRequestThreads", {}, `Commenting on ${noun(ref)}`, "POST", { comments: [{ parentCommentId: 0, content: body, commentType: 1 }], status: 1 });
    },
    reply: async (ref, threadId, body) => {
      await invoke(ref, "pullRequestThreadComments", { threadId }, `Commenting on ${noun(ref)}`, "POST", { parentCommentId: 1, content: body, commentType: 1 });
    },
    update: async (ref, input) => {
      await update(ref, ref.number, [...(input.title !== undefined ? ["--title", input.title] : []), ...(input.body !== undefined ? ["--description", input.body || " "] : [])], `Editing ${noun(ref)}`);
    },
    /** A review is a vote, and its text a comment beside it. */
    review: async (ref, input) => {
      if (input.body) await invoke(ref, "pullRequestThreads", {}, `Submitting the review of ${noun(ref)}`, "POST", { comments: [{ parentCommentId: 0, content: input.body, commentType: 1 }], status: 1 });
      const vote = input.event === "approve" ? "approve" : input.event === "request-changes" ? "wait-for-author" : undefined;
      if (vote) await az(ref, ["repos", "pr", "set-vote", "--id", String(ref.number), "--vote", vote], `Submitting the review of ${noun(ref)}`);
    },
    resolve: async (ref, threadId, resolved) => {
      await invoke(ref, "pullRequestThreads", { threadId }, `${resolved ? "Resolving" : "Reopening"} a conversation on ${noun(ref)}`, "PATCH", { status: resolved ? "fixed" : "active" });
    },
    reviewers: async (ref, add, remove) => {
      const action = `Changing the reviewers of ${noun(ref)}`;
      if (add.length > 0) await az(ref, ["repos", "pr", "reviewer", "add", "--id", String(ref.number), "--reviewers", ...add], action);
      if (remove.length > 0) await az(ref, ["repos", "pr", "reviewer", "remove", "--id", String(ref.number), "--reviewers", ...remove], action);
    },
  };
}
