import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import type {
  PendingReviewComment,
  PullRequestCheck,
  PullRequestDetail,
  PullRequestFiles,
  PullRequestLabel,
  PullRequestRef,
  PullRequestReviewEvent,
  PullRequestThread,
  PullRequestViewedState,
} from "./protocol.js";
import { pullRequestCalls, type CliCall } from "./pull-request-cli.js";
import type { Hosting } from "./pull-request-hosting.js";
import {
  diffFingerprint,
  isDiffTooLarge,
  parseGitHubChecks,
  parseGitHubDetail,
  parseGitHubFiles,
  parseGitHubThreads,
  parseGitLabChecks,
  parseGitLabDetail,
  parseGitLabDiffs,
  parseGitLabThreads,
  parseRequestUrl,
  parseUnifiedDiff,
} from "./pull-request-json.js";
import { LocalViewedStore } from "./pull-request-viewed.js";
import { SERVICES } from "./request-cli.js";

/** A read is reused this long, for a tab reopened or a second client; `fresh` skips it. */
const READ_TTL_MS = 60_000;
const DIFF_BUFFER = 16 * 1024 * 1024;
/** Pages of 100 read at most per connection: 3,000 threads or files. */
const MAX_PAGES = 30;

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const names = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))] : [];

export interface PullRequestCommandOptions {
  now?(): number;
}

/** The view's cached read of a request, for the kit's other commands (a link's snapshot). */
export interface PullRequestReads {
  detail(ref: PullRequestRef, fresh: boolean): Promise<PullRequestDetail>;
}

/** GitLab answers 100 rows a page; this reads pages until a short one. */
async function gitlabPages(read: (page: number) => Promise<string>): Promise<string> {
  const rows: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const answer = JSON.parse(await read(page)) as unknown;
    const batch = Array.isArray(answer) ? answer : [];
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return JSON.stringify(rows);
}

/**
 * The pull-request view's host half: one request, addressed by its URL, read
 * and written through `gh` or `glab`. Reads are cached per request for a
 * minute and every write drops that request's cache, so the view's next read
 * shows what the write did.
 */
export function registerPullRequestCommands(context: HostExtensionContext, hosting: Hosting, options: PullRequestCommandOptions = {}): PullRequestReads {
  const { services } = context;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Promise<unknown> }>();
  const viewedStore = new LocalViewedStore(services.stateDir, now);

  const target = (input: unknown): PullRequestRef => {
    const url = text(record(input).url);
    const ref = url ? parseRequestUrl(url) : undefined;
    if (!ref) throw new HostCommandError("Name a pull or merge request by its URL.");
    return ref;
  };

  const cli = (ref: PullRequestRef, call: CliCall, action: string, maxBuffer?: number) =>
    hosting.cli(ref.service, call, action, maxBuffer ? { maxBuffer } : {});

  const cached = <T>(kind: string, ref: PullRequestRef, fresh: boolean, read: () => Promise<T>): Promise<T> => {
    const key = `${kind}\0${ref.url}`;
    const entry = cache.get(key);
    if (entry && !fresh && now() - entry.at < READ_TTL_MS) return entry.value as Promise<T>;
    const value = read();
    cache.set(key, { at: now(), value });
    value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
    return value;
  };

  const forget = (ref: PullRequestRef) => {
    for (const key of cache.keys()) if (key.endsWith(`\0${ref.url}`)) cache.delete(key);
  };

  const noun = (ref: PullRequestRef) => `${SERVICES[ref.service].short} #${ref.number}`;

  const gitlabDiscussions = (ref: PullRequestRef, fresh: boolean) => cached("discussions", ref, fresh, () =>
    gitlabPages((page) => cli(ref, pullRequestCalls.threads(ref, { page }), `Reading the conversations of ${noun(ref)}`)));

  const detail = (ref: PullRequestRef, fresh: boolean) => cached("view", ref, fresh, async (): Promise<PullRequestDetail> => {
    const viewer = hosting.viewer(ref.service, ref.host);
    let read: PullRequestDetail;
    if (ref.service === "github") {
      read = parseGitHubDetail(ref, await cli(ref, pullRequestCalls.view(ref)[0]!, `Reading ${noun(ref)}`));
    } else {
      const [request, , commits] = pullRequestCalls.view(ref);
      const [output, discussions, commitList] = await Promise.all([
        cli(ref, request!, `Reading ${noun(ref)}`),
        gitlabDiscussions(ref, fresh),
        cli(ref, commits!, `Reading the commits of ${noun(ref)}`),
      ]);
      read = parseGitLabDetail(ref, output, discussions, commitList);
    }
    const login = await viewer;
    return login ? { ...read, viewer: login } : read;
  });

  /** Every page of the threads and the viewed marks, each connection read to its end. */
  const githubThreads = (ref: PullRequestRef, fresh: boolean) => cached("threads", ref, fresh, async () => {
    const first = parseGitHubThreads(await cli(ref, pullRequestCalls.threads(ref), `Reading the conversations of ${noun(ref)}`));
    const threads = [...first.threads];
    const viewed = new Map(first.viewed);
    let threadsAfter: string | null = first.threadsAfter ?? null;
    let filesAfter: string | null = first.filesAfter ?? null;
    for (let page = 1; page < MAX_PAGES && (threadsAfter || filesAfter); page += 1) {
      const next = parseGitHubThreads(await cli(ref, pullRequestCalls.threads(ref, { threadsAfter, filesAfter }), `Reading the conversations of ${noun(ref)}`));
      if (threadsAfter) { threads.push(...next.threads); threadsAfter = next.threadsAfter ?? null; }
      if (filesAfter) { for (const [path, state] of next.viewed) viewed.set(path, state); filesAfter = next.filesAfter ?? null; }
    }
    return { threads, viewed, ...(first.nodeId ? { nodeId: first.nodeId } : {}) };
  });

  const threads = (ref: PullRequestRef, fresh: boolean): Promise<PullRequestThread[]> => ref.service === "github"
    ? githubThreads(ref, fresh).then((read) => read.threads)
    : gitlabDiscussions(ref, fresh).then(parseGitLabThreads);

  const changes = (ref: PullRequestRef, fresh: boolean) => cached("diff", ref, fresh, async () => {
    if (ref.service === "gitlab") {
      return parseGitLabDiffs(await gitlabPages((page) => cli(ref, pullRequestCalls.diff(ref, page), `Reading the diff of ${noun(ref)}`)));
    }
    try {
      return parseUnifiedDiff(await cli(ref, pullRequestCalls.diff(ref), `Reading the diff of ${noun(ref)}`, DIFF_BUFFER));
    } catch (error) {
      if (!(error instanceof Error) || !isDiffTooLarge(error.message)) throw error;
      services.log("request.diff-fallback", `${noun(ref)} · per-file listing`);
      return parseGitHubFiles(await cli(ref, pullRequestCalls.files(ref), `Reading the files of ${noun(ref)}`, DIFF_BUFFER));
    }
  });

  const files = async (ref: PullRequestRef, fresh: boolean): Promise<PullRequestFiles> => {
    const entries = await changes(ref, fresh);
    let states: Map<string, PullRequestViewedState>;
    if (ref.service === "github") {
      states = (await githubThreads(ref, fresh)).viewed;
    } else {
      states = await viewedStore.states(ref.url, new Map(entries.map((entry) => [entry.file.path, diffFingerprint(entry.diff)])));
    }
    return {
      files: entries.map((entry) => ({ ...entry.file, viewed: states.get(entry.file.path) ?? "unviewed" })),
      diffs: entries.map((entry) => entry.diff),
      viewedOn: ref.service === "github" ? "host" : "local",
    };
  };

  const fresh = (input: unknown) => record(input).fresh === true;

  /** A write, then the cache it made stale goes, and the log says what happened. */
  const write = async (ref: PullRequestRef, call: CliCall, action: string, log: string) => {
    await cli(ref, call, action);
    forget(ref);
    services.log(log, noun(ref));
  };

  context.registerCommand("pr-view", (input) => detail(target(input), fresh(input)), { long: true });

  context.registerCommand("pr-checks", async (input): Promise<PullRequestCheck[]> => {
    const ref = target(input);
    // Checks move on their own, so they are never served from the cache.
    const output = await cli(ref, pullRequestCalls.checks(ref), `Reading the checks of ${noun(ref)}`);
    const raw = record(JSON.parse(output));
    return ref.service === "github" ? parseGitHubChecks(raw.statusCheckRollup) : parseGitLabChecks(raw.head_pipeline ?? raw.pipeline);
  });

  context.registerCommand("pr-comments", (input) => threads(target(input), fresh(input)), { long: true });

  context.registerCommand("pr-files", (input) => files(target(input), fresh(input)), { long: true });

  context.registerCommand("pr-comment", async (input) => {
    const ref = target(input);
    const fields = record(input);
    const body = text(fields.body)?.trim();
    if (!body) throw new HostCommandError("Write a comment first.");
    const threadId = text(fields.threadId);
    const path = text(fields.path);
    const line = typeof fields.line === "number" && Number.isInteger(fields.line) && fields.line > 0 ? fields.line : undefined;
    let call: CliCall;
    if (threadId) {
      call = pullRequestCalls.reply(ref, threadId, body);
    } else if (path && line !== undefined) {
      const known = await detail(ref, false);
      call = pullRequestCalls.lineComment(ref, {
        path, line, body,
        side: fields.side === "old" ? "old" : "new",
        ...(known.headSha ? { headSha: known.headSha } : {}),
        ...(known.diffRefs ? { diffRefs: known.diffRefs } : {}),
      });
    } else {
      call = pullRequestCalls.comment(ref, body);
    }
    await cli(ref, call, `Commenting on ${noun(ref)}`);
    forget(ref);
    services.log("request.commented", `${noun(ref)}${threadId ? " · reply" : path ? ` · ${path}:${line}` : ""}`);
    return { ok: true };
  }, { long: true });

  context.registerCommand("pr-update", async (input): Promise<PullRequestDetail> => {
    const ref = target(input);
    const fields = record(input);
    const title = text(fields.title)?.trim();
    const body = text(fields.body);
    if (text(fields.title) !== undefined && !title) throw new HostCommandError("A title is required.");
    if (title === undefined && body === undefined) throw new HostCommandError("Nothing to change.");
    await write(ref, pullRequestCalls.edit(ref, { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) }), `Editing ${noun(ref)}`, "request.edited");
    return detail(ref, true);
  }, { long: true });

  context.registerCommand("pr-viewed", async (input): Promise<{ viewed: PullRequestViewedState }> => {
    const ref = target(input);
    const fields = record(input);
    const path = text(fields.path);
    if (!path) throw new HostCommandError("Name the file to mark.");
    const viewed = fields.viewed === true;
    if (ref.service === "github") {
      const nodeId = (await githubThreads(ref, false)).nodeId ?? (await detail(ref, false)).nodeId;
      if (!nodeId) throw new HostCommandError(`GitHub did not name ${noun(ref)}'s id; refresh and try again.`);
      await cli(ref, pullRequestCalls.viewed(ref, nodeId, path, viewed), `Marking ${path} ${viewed ? "viewed" : "not viewed"}`);
      cache.delete(`threads\0${ref.url}`);
    } else {
      const entry = (await changes(ref, false)).find((candidate) => candidate.file.path === path);
      if (!entry) throw new HostCommandError(`${path} is not part of ${noun(ref)}.`);
      await viewedStore.set(ref.url, path, diffFingerprint(entry.diff), viewed);
    }
    return { viewed: viewed ? "viewed" : "unviewed" };
  }, { long: true });

  /**
   * A review in one step, as T3 Code submits it: the verdict, its text and
   * every line comment held for it. GitHub takes them as one review; GitLab
   * posts the comments and the text, then approves.
   */
  context.registerCommand("pr-review", async (input): Promise<PullRequestDetail> => {
    const ref = target(input);
    const fields = record(input);
    const event = (["comment", "approve", "request-changes"] as const).find((candidate) => candidate === fields.event) as PullRequestReviewEvent | undefined;
    if (!event) throw new HostCommandError("Choose comment, approve or request changes.");
    const body = text(fields.body)?.trim() ?? "";
    const comments: PendingReviewComment[] = (Array.isArray(fields.comments) ? fields.comments : []).map(record).flatMap((comment) => {
      const path = text(comment.path);
      const line = typeof comment.line === "number" && Number.isInteger(comment.line) && comment.line > 0 ? comment.line : undefined;
      const commentBody = text(comment.body)?.trim();
      return path && line !== undefined && commentBody ? [{ id: text(comment.id) ?? "", path, line, side: comment.side === "old" ? "old" as const : "new" as const, body: commentBody }] : [];
    });
    if (event !== "approve" && !body && comments.length === 0) throw new HostCommandError(event === "comment" ? "Write a comment or add line comments first." : "Say what has to change.");
    const known = await detail(ref, false);
    const action = `Submitting the review of ${noun(ref)}`;
    if (ref.service === "github") {
      await cli(ref, pullRequestCalls.review(ref, { event, body, comments, ...(known.headSha ? { headSha: known.headSha } : {}) }), action);
    } else {
      if (event === "request-changes") throw new HostCommandError("GitLab takes no request for changes through its API; comment instead.");
      for (const comment of comments) {
        await cli(ref, pullRequestCalls.lineComment(ref, { ...comment, ...(known.diffRefs ? { diffRefs: known.diffRefs } : {}) }), action);
      }
      if (body) await cli(ref, pullRequestCalls.comment(ref, body), action);
      if (event === "approve") await cli(ref, pullRequestCalls.approve(ref), `Approving ${noun(ref)}`);
    }
    forget(ref);
    services.log("request.reviewed", `${noun(ref)} · ${event}${comments.length ? ` · ${comments.length} line comments` : ""}`);
    return detail(ref, true);
  }, { long: true });

  context.registerCommand("pr-resolve", async (input) => {
    const ref = target(input);
    const fields = record(input);
    const threadId = text(fields.threadId);
    if (!threadId) throw new HostCommandError("Name the conversation.");
    const resolved = fields.resolved !== false;
    await write(ref, pullRequestCalls.resolve(ref, threadId, resolved), `${resolved ? "Resolving" : "Reopening"} a conversation on ${noun(ref)}`, resolved ? "request.resolved" : "request.unresolved");
    return threads(ref, true);
  }, { long: true });

  context.registerCommand("pr-edit-comment", async (input) => {
    const ref = target(input);
    const fields = record(input);
    const id = text(fields.id);
    const body = text(fields.body)?.trim();
    const kind = (["comment", "review", "review-comment"] as const).find((candidate) => candidate === fields.kind);
    if (!id || !kind) throw new HostCommandError("Name the comment to edit.");
    if (!body) throw new HostCommandError("A comment cannot be empty.");
    await write(ref, pullRequestCalls.editComment(ref, { id, kind, body }), `Editing a comment on ${noun(ref)}`, "request.comment-edited");
    return { ok: true };
  }, { long: true });

  context.registerCommand("pr-reviewers", async (input): Promise<PullRequestDetail> => {
    const ref = target(input);
    const add = names(record(input).add);
    const remove = names(record(input).remove);
    if (add.length === 0 && remove.length === 0) throw new HostCommandError("Nothing to change.");
    await write(ref, pullRequestCalls.reviewers(ref, add, remove), `Changing the reviewers of ${noun(ref)}`, "request.reviewers");
    return detail(ref, true);
  }, { long: true });

  context.registerCommand("pr-labels", async (input): Promise<PullRequestDetail> => {
    const ref = target(input);
    const add = names(record(input).add);
    const remove = names(record(input).remove);
    if (add.length === 0 && remove.length === 0) throw new HostCommandError("Nothing to change.");
    await write(ref, pullRequestCalls.labels(ref, add, remove), `Changing the labels of ${noun(ref)}`, "request.labels");
    return detail(ref, true);
  }, { long: true });

  /** The repository's labels and the accounts that can review, for the pickers; either may come back empty. */
  context.registerCommand("pr-candidates", async (input): Promise<{ labels: PullRequestLabel[]; reviewers: string[] }> => {
    const ref = target(input);
    return cached("candidates", ref, fresh(input), async () => {
      const [labelOutput, peopleOutput] = await Promise.all([
        cli(ref, pullRequestCalls.repoLabels(ref), `Reading the labels of ${ref.repo}`).catch(() => "[]"),
        cli(ref, pullRequestCalls.assignable(ref), `Reading who can review ${noun(ref)}`).catch(() => "[]"),
      ]);
      const labels = (JSON.parse(labelOutput) as unknown[]).map(record).flatMap((label): PullRequestLabel[] => {
        const name = text(label.name);
        const color = text(label.color)?.replace(/^#/u, "");
        return name ? [{ name, ...(color && /^[0-9a-f]{6}$/iu.test(color) ? { color: color.toLowerCase() } : {}) }] : [];
      });
      const people = JSON.parse(peopleOutput) as unknown;
      const nodes = Array.isArray(people) ? people : record(record(record(record(people).data).repository).assignableUsers).nodes;
      const reviewers = (Array.isArray(nodes) ? nodes : []).map(record).flatMap((person) => {
        const login = text(person.login) ?? text(person.username);
        return login ? [login] : [];
      });
      return { labels, reviewers };
    });
  }, { long: true });

  return { detail };
}
