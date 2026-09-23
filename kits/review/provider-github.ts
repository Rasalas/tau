import { HostCommandError } from "tau/host-extension";
import { PROVIDERS, type PullRequestLabel, type PullRequestRef, type PullRequestViewedState } from "./protocol.js";
import type { ChangedFileEntry, ProviderTools, SourceControlProvider } from "./provider.js";
import { listCall, pullRequestCalls } from "./pull-request-cli.js";
import { parseRemote } from "./pull-request-hosting.js";
import { parseGitHubChecks, parseGitHubDetail, parseGitHubFiles, parseGitHubThreads, isDiffTooLarge, parseUnifiedDiff } from "./pull-request-json.js";
import { parseGitHubList } from "./pull-request-list-json.js";
import { GITHUB_BRANCH_FIELDS, parseGitHubBranchRequest } from "./branch-request-json.js";
import { authArgs, createArgs, createdUrl, draftArgs, editArgs, mergeArgs, SERVICES } from "./request-cli.js";

const DIFF_BUFFER = 16 * 1024 * 1024;
const LIST_BUFFER = 32 * 1024 * 1024;
/** Pages of 100 read at most per connection: 3,000 threads or files. */
const MAX_PAGES = 30;

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

/** The label and people answers of `gh` or `glab`, as a picker offers them. */
export function parseCandidates(labelOutput: string, peopleOutput: string): { labels: PullRequestLabel[]; reviewers: string[] } {
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
}

export const missingCli = (kind: keyof typeof SERVICES, findCommand: (name: string) => string | undefined): string | undefined => {
  const facts = SERVICES[kind];
  return findCommand(facts.tool) ? undefined : `${facts.label} is not installed or not on your PATH. Install it from ${facts.install}, then run \`${facts.login}\`.`;
};

/** `gh auth status` or `glab auth status`: signed in when it exits 0, with the accounts it names. */
export async function cliAuthStatus(tools: ProviderTools, kind: "github" | "gitlab", home: string): Promise<{ signedIn: boolean; account?: string; hint?: string }> {
  let stderr = "";
  try {
    const stdout = await tools.cli(kind, { args: authArgs() }, "Checking the sign-in", { inspect: (_output, error) => { stderr = error; } });
    const accounts = [...`${stdout}\n${stderr}`.matchAll(/Logged in to (\S+) (?:account|as) ([^\s(]+)/gu)].map((match) => match[1] === home ? match[2]! : `${match[2]} on ${match[1]}`);
    return { signedIn: true, ...(accounts.length > 0 ? { account: [...new Set(accounts)].join(", ") } : {}) };
  } catch {
    return { signedIn: false, hint: `Run \`${SERVICES[kind].login}\` in a terminal.` };
  }
}

/** GitHub through `gh`: its own verbs where it has them, `gh api` and GraphQL for the rest. */
export function createGitHubProvider(tools: ProviderTools): SourceControlProvider {
  const kind = "github" as const;
  const noun = (ref: PullRequestRef) => `PR #${ref.number}`;
  const cli = (ref: PullRequestRef, call: Parameters<ProviderTools["cli"]>[1], action: string, maxBuffer?: number) =>
    tools.cli(kind, call, action, { host: ref.host, ...(maxBuffer ? { maxBuffer } : {}) });

  /** Every page of the threads and the viewed marks, each connection read to its end. */
  const threads = (ref: PullRequestRef, fresh: boolean) => tools.cached("threads", ref, fresh, async () => {
    const first = parseGitHubThreads(await cli(ref, pullRequestCalls.threads(ref), `Reading the conversations of ${noun(ref)}`));
    const read = [...first.threads];
    const viewed = new Map(first.viewed);
    let threadsAfter: string | null = first.threadsAfter ?? null;
    let filesAfter: string | null = first.filesAfter ?? null;
    for (let page = 1; page < MAX_PAGES && (threadsAfter || filesAfter); page += 1) {
      const next = parseGitHubThreads(await cli(ref, pullRequestCalls.threads(ref, { threadsAfter, filesAfter }), `Reading the conversations of ${noun(ref)}`));
      if (threadsAfter) { read.push(...next.threads); threadsAfter = next.threadsAfter ?? null; }
      if (filesAfter) { for (const [path, state] of next.viewed) viewed.set(path, state); filesAfter = next.filesAfter ?? null; }
    }
    return { threads: read, viewed, ...(first.nodeId ? { nodeId: first.nodeId } : {}) };
  });

  const provider: SourceControlProvider = {
    kind,
    info: PROVIDERS.github,
    missing: () => missingCli(kind, tools.findCommand),
    repository: (remoteUrl) => parseRemote(remoteUrl),
    requestUrl: ({ host, repo }, number) => `https://${host}/${repo}/pull/${number}`,
    signedIn: ({ cwd }) => tools.cli(kind, { args: authArgs() }, "Checking the sign-in", { cwd }).then(() => true, () => false),
    viewer: async (host) => {
      const raw = JSON.parse(await tools.cli(kind, { args: ["api", "--hostname", host, "user"] }, "Reading the signed-in account")) as Record<string, unknown>;
      return typeof raw.login === "string" && raw.login ? raw.login : undefined;
    },
    status: () => cliAuthStatus(tools, kind, "github.com"),

    // `gh` finds the request of the branch the checkout has; none, no login or no CLI all answer undefined.
    current: async ({ cwd, host }) => {
      const output = await tools.cli(kind, { args: ["pr", "view", "--json", GITHUB_BRANCH_FIELDS] }, "Reading the branch's pull request", { cwd, ...(host ? { host } : {}) }).catch(() => undefined);
      return output ? parseGitHubBranchRequest(output) : undefined;
    },
    create: async ({ cwd }, input) => createdUrl(await tools.cli(kind, { args: createArgs(kind, input) }, "Creating the pull request", { cwd })),
    merge: async ({ cwd }, request, method) => { await tools.cli(kind, { args: mergeArgs(kind, request.number, method) }, `Merging PR #${request.number}`, { cwd }); },
    edit: async ({ cwd }, request, input) => { await tools.cli(kind, { args: editArgs(kind, request.number, input) }, `Editing PR #${request.number}`, { cwd }); },
    setDraft: async ({ cwd }, request, draft) => { await tools.cli(kind, { args: draftArgs(kind, request.number, draft) }, `Editing PR #${request.number}`, { cwd }); },

    list: async ({ host, repo, cwd }, input, viewer) => {
      const output = await tools.cli(kind, listCall(kind, host, repo, input), `Listing the pull requests of ${repo}`, { maxBuffer: LIST_BUFFER, cwd, host });
      const entries = parseGitHubList(output, viewer);
      return { entries: entries.slice(0, input.limit), more: entries.length > input.limit };
    },

    detail: async (ref) => parseGitHubDetail(ref, await cli(ref, pullRequestCalls.view(ref)[0]!, `Reading ${noun(ref)}`)),
    checks: async (ref) => parseGitHubChecks(record(JSON.parse(await cli(ref, pullRequestCalls.checks(ref), `Reading the checks of ${noun(ref)}`))).statusCheckRollup),
    threads: async (ref, fresh) => (await threads(ref, fresh)).threads,
    changes: async (ref): Promise<ChangedFileEntry[]> => {
      try {
        return parseUnifiedDiff(await cli(ref, pullRequestCalls.diff(ref), `Reading the diff of ${noun(ref)}`, DIFF_BUFFER));
      } catch (error) {
        if (!(error instanceof Error) || !isDiffTooLarge(error.message)) throw error;
        tools.log("request.diff-fallback", `${noun(ref)} · per-file listing`);
        return parseGitHubFiles(await cli(ref, pullRequestCalls.files(ref), `Reading the files of ${noun(ref)}`, DIFF_BUFFER));
      }
    },
    viewedMarks: {
      states: async (ref, fresh): Promise<Map<string, PullRequestViewedState>> => (await threads(ref, fresh)).viewed,
      set: async (ref, path, viewed, detail) => {
        const nodeId = (await threads(ref, false)).nodeId ?? (await detail()).nodeId;
        if (!nodeId) throw new HostCommandError(`GitHub did not name ${noun(ref)}'s id; refresh and try again.`);
        await cli(ref, pullRequestCalls.viewed(ref, nodeId, path, viewed), `Marking ${path} ${viewed ? "viewed" : "not viewed"}`);
        tools.drop("threads", ref);
      },
    },
    comment: async (ref, body) => { await cli(ref, pullRequestCalls.comment(ref, body), `Commenting on ${noun(ref)}`); },
    reply: async (ref, threadId, body) => { await cli(ref, pullRequestCalls.reply(ref, threadId, body), `Commenting on ${noun(ref)}`); },
    lineComment: async (ref, input, known) => {
      await cli(ref, pullRequestCalls.lineComment(ref, { ...input, ...(known.headSha ? { headSha: known.headSha } : {}) }), `Commenting on ${noun(ref)}`);
    },
    update: async (ref, input) => { await cli(ref, pullRequestCalls.edit(ref, input), `Editing ${noun(ref)}`); },
    review: async (ref, input, known) => {
      await cli(ref, pullRequestCalls.review(ref, { ...input, ...(known.headSha ? { headSha: known.headSha } : {}) }), `Submitting the review of ${noun(ref)}`);
    },
    resolve: async (ref, threadId, resolved) => {
      await cli(ref, pullRequestCalls.resolve(ref, threadId, resolved), `${resolved ? "Resolving" : "Reopening"} a conversation on ${noun(ref)}`);
    },
    editComment: async (ref, input) => { await cli(ref, pullRequestCalls.editComment(ref, input), `Editing a comment on ${noun(ref)}`); },
    reviewers: async (ref, add, remove) => { await cli(ref, pullRequestCalls.reviewers(ref, add, remove), `Changing the reviewers of ${noun(ref)}`); },
    labels: async (ref, add, remove) => { await cli(ref, pullRequestCalls.labels(ref, add, remove), `Changing the labels of ${noun(ref)}`); },
    candidates: async (ref) => {
      const [labelOutput, peopleOutput] = await Promise.all([
        cli(ref, pullRequestCalls.repoLabels(ref), `Reading the labels of ${ref.repo}`).catch(() => "[]"),
        cli(ref, pullRequestCalls.assignable(ref), `Reading who can review ${noun(ref)}`).catch(() => "[]"),
      ]);
      return parseCandidates(labelOutput, peopleOutput);
    },
  };
  return provider;
}
