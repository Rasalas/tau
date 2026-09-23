import { HostCommandError } from "tau/host-extension";
import { PROVIDERS, type PullRequestRef, type ReviewRequest } from "./protocol.js";
import { readPages, type ProviderTools, type SourceControlProvider } from "./provider.js";
import { cliAuthStatus, missingCli, parseCandidates } from "./provider-github.js";
import { listCall, pullRequestCalls } from "./pull-request-cli.js";
import { parseRemote } from "./pull-request-hosting.js";
import { parseGitLabChecks, parseGitLabDetail, parseGitLabDiffs, parseGitLabThreads } from "./pull-request-json.js";
import { parseGitLabList } from "./pull-request-list-json.js";
import { authArgs, createArgs, createdUrl, draftArgs, editArgs, mergeArgs } from "./request-cli.js";

const LIST_BUFFER = 32 * 1024 * 1024;

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};

/** GitLab through `glab`: its own verbs for the branch's request, `glab api` with JSON on stdin for the rest. */
export function createGitLabProvider(tools: ProviderTools): SourceControlProvider {
  const kind = "gitlab" as const;
  const noun = (ref: PullRequestRef) => `MR #${ref.number}`;
  const cli = (ref: PullRequestRef, call: Parameters<ProviderTools["cli"]>[1], action: string) => tools.cli(kind, call, action, { host: ref.host });

  const discussions = (ref: PullRequestRef, fresh: boolean) => tools.cached("discussions", ref, fresh, () =>
    readPages((page) => cli(ref, pullRequestCalls.threads(ref, { page }), `Reading the conversations of ${noun(ref)}`)));

  return {
    kind,
    info: PROVIDERS.gitlab,
    missing: () => missingCli(kind, tools.findCommand),
    repository: (remoteUrl) => parseRemote(remoteUrl),
    requestUrl: ({ host, repo }, number) => `https://${host}/${repo}/-/merge_requests/${number}`,
    signedIn: ({ cwd }) => tools.cli(kind, { args: authArgs() }, "Checking the sign-in", { cwd }).then(() => true, () => false),
    viewer: async (host) => {
      const raw = JSON.parse(await tools.cli(kind, { args: ["api", "--hostname", host, "user"] }, "Reading the signed-in account")) as Record<string, unknown>;
      return typeof raw.username === "string" && raw.username ? raw.username : undefined;
    },
    status: () => cliAuthStatus(tools, kind, "gitlab.com"),

    current: async (branch) => await tools.workspace("review-request", branch.workspace ? { workspace: branch.workspace } : { fresh: branch.fresh }) as ReviewRequest | undefined,
    create: async ({ cwd }, input) => createdUrl(await tools.cli(kind, { args: createArgs(kind, input) }, "Creating the merge request", { cwd })),
    merge: async ({ cwd }, request, method) => { await tools.cli(kind, { args: mergeArgs(kind, request.number, method) }, `Merging MR #${request.number}`, { cwd }); },
    edit: async ({ cwd }, request, input) => { await tools.cli(kind, { args: editArgs(kind, request.number, input) }, `Editing MR #${request.number}`, { cwd }); },
    setDraft: async ({ cwd }, request, draft) => { await tools.cli(kind, { args: draftArgs(kind, request.number, draft) }, `Editing MR #${request.number}`, { cwd }); },

    list: async ({ host, repo, cwd }, input, viewer) => {
      const entries = [];
      for (let page = 1; entries.length <= input.limit; page += 1) {
        const output = await tools.cli(kind, listCall(kind, host, repo, { ...input, page }), `Listing the merge requests of ${repo}`, { maxBuffer: LIST_BUFFER, cwd, host });
        entries.push(...parseGitLabList(output, viewer));
        if ((JSON.parse(output) as unknown[]).length < 100) break;
      }
      return { entries: entries.slice(0, input.limit), more: entries.length > input.limit };
    },

    detail: async (ref, fresh) => {
      const [request, , commits] = pullRequestCalls.view(ref);
      const [output, notes, commitList] = await Promise.all([
        cli(ref, request!, `Reading ${noun(ref)}`),
        discussions(ref, fresh),
        cli(ref, commits!, `Reading the commits of ${noun(ref)}`),
      ]);
      return parseGitLabDetail(ref, output, notes, commitList);
    },
    checks: async (ref) => {
      const raw = record(JSON.parse(await cli(ref, pullRequestCalls.checks(ref), `Reading the checks of ${noun(ref)}`)));
      return parseGitLabChecks(raw.head_pipeline ?? raw.pipeline);
    },
    threads: async (ref, fresh) => parseGitLabThreads(await discussions(ref, fresh)),
    changes: async (ref) => parseGitLabDiffs(await readPages((page) => cli(ref, pullRequestCalls.diff(ref, page), `Reading the diff of ${noun(ref)}`))),
    comment: async (ref, body) => { await cli(ref, pullRequestCalls.comment(ref, body), `Commenting on ${noun(ref)}`); },
    reply: async (ref, threadId, body) => { await cli(ref, pullRequestCalls.reply(ref, threadId, body), `Commenting on ${noun(ref)}`); },
    lineComment: async (ref, input, known) => {
      await cli(ref, pullRequestCalls.lineComment(ref, { ...input, ...(known.diffRefs ? { diffRefs: known.diffRefs } : {}) }), `Commenting on ${noun(ref)}`);
    },
    update: async (ref, input) => { await cli(ref, pullRequestCalls.edit(ref, input), `Editing ${noun(ref)}`); },
    /** GitLab takes a review as its parts: the line comments, the text, then the approval. */
    review: async (ref, input, known) => {
      if (input.event === "request-changes") throw new HostCommandError("GitLab takes no request for changes through its API; comment instead.");
      const action = `Submitting the review of ${noun(ref)}`;
      for (const comment of input.comments) {
        await cli(ref, pullRequestCalls.lineComment(ref, { ...comment, ...(known.diffRefs ? { diffRefs: known.diffRefs } : {}) }), action);
      }
      if (input.body) await cli(ref, pullRequestCalls.comment(ref, input.body), action);
      if (input.event === "approve") await cli(ref, pullRequestCalls.approve(ref), `Approving ${noun(ref)}`);
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
}
