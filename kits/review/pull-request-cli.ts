import type { PendingReviewComment, PullRequestListState, PullRequestRef, PullRequestReviewEvent, RequestService } from "./protocol.js";

/** One CLI call: its arguments and, for a write, the JSON or text it reads from stdin. */
export interface CliCall {
  args: string[];
  input?: string;
}

export const GITHUB_VIEW_FIELDS = [
  "id", "number", "title", "body", "url", "state", "isDraft", "author", "createdAt", "updatedAt", "mergedAt", "closedAt",
  "baseRefName", "headRefName", "headRefOid", "additions", "deletions", "changedFiles", "labels", "reviewRequests",
  "latestReviews", "reviews", "comments", "commits", "statusCheckRollup", "autoMergeRequest",
].join(",");

/**
 * One page of the review threads and one of the files; a connection already
 * read to its end is left out with `@include`, so each further page costs
 * only what is still missing.
 */
export const GITHUB_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $withThreads: Boolean!, $withFiles: Boolean!, $threadsAfter: String, $filesAfter: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      reviewThreads(first: 100, after: $threadsAfter) @include(if: $withThreads) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved isOutdated path line originalLine diffSide
          comments(first: 100) { nodes { id body createdAt url author { login } } } }
      }
      files(first: 100, after: $filesAfter) @include(if: $withFiles) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}`;

const REPLY_MUTATION = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } }
}`;

const RESOLVE_MUTATION = (resolved: boolean) => `mutation($threadId: ID!) {
  ${resolved ? "resolveReviewThread" : "unresolveReviewThread"}(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

/** GitHub keeps three kinds of comment, each with its own edit. */
const EDIT_MUTATIONS: Record<"comment" | "review" | "review-comment", string> = {
  comment: "mutation($id: ID!, $body: String!) { updateIssueComment(input: { id: $id, body: $body }) { issueComment { id } } }",
  review: "mutation($id: ID!, $body: String!) { updatePullRequestReview(input: { pullRequestReviewId: $id, body: $body }) { pullRequestReview { id } } }",
  "review-comment": "mutation($id: ID!, $body: String!) { updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $id, body: $body }) { pullRequestReviewComment { id } } }",
};

const ASSIGNABLE_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { assignableUsers(first: 100) { nodes { login name } } }
}`;

export const GITHUB_LIST_FIELDS = [
  "number", "title", "url", "author", "headRefName", "baseRefName", "state", "isDraft", "mergeable", "additions", "deletions",
  "createdAt", "updatedAt", "labels", "reviewDecision", "reviewRequests", "statusCheckRollup",
].join(",");

const GITLAB_LIST_STATES: Record<PullRequestListState, string> = { open: "opened", closed: "closed", merged: "merged", all: "all" };

const REVIEW_EVENTS: Record<PullRequestReviewEvent, string> = { comment: "COMMENT", approve: "APPROVE", "request-changes": "REQUEST_CHANGES" };

const viewedMutation = (viewed: boolean) => `mutation($pullRequestId: ID!, $path: String!) {
  ${viewed ? "markFileAsViewed" : "unmarkFileAsViewed"}(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId }
}`;

function github(ref: PullRequestRef) {
  const [owner = "", name = ""] = ref.repo.split("/");
  return { owner, name, api: ["api", "--hostname", ref.host] };
}

function gitlab(ref: PullRequestRef) {
  const base = `projects/${encodeURIComponent(ref.repo)}/merge_requests/${ref.number}`;
  const api = (path: string): CliCall => ({ args: ["api", "--hostname", ref.host, path] });
  const send = (method: "POST" | "PUT", path: string, body: unknown): CliCall => ({
    args: ["api", "--hostname", ref.host, "--method", method, "--header", "Content-Type: application/json", "--input", "-", path],
    input: JSON.stringify(body),
  });
  return { base, api, send };
}

export const pullRequestCalls = {
  /** The request itself; on GitLab its discussions and commits are two more calls. */
  view(ref: PullRequestRef): CliCall[] {
    if (ref.service === "github") return [{ args: ["pr", "view", ref.url, "--json", GITHUB_VIEW_FIELDS] }];
    const { base, api } = gitlab(ref);
    return [api(base), api(`${base}/discussions?per_page=100`), api(`${base}/commits?per_page=100`)];
  },
  checks(ref: PullRequestRef): CliCall {
    return ref.service === "github"
      ? { args: ["pr", "view", ref.url, "--json", "statusCheckRollup"] }
      : gitlab(ref).api(gitlab(ref).base);
  },
  /** A page of the conversations: GitHub by cursor per connection, GitLab by page number. */
  threads(ref: PullRequestRef, page: { threadsAfter?: string | null; filesAfter?: string | null; page?: number } = {}): CliCall {
    if (ref.service === "gitlab") return gitlab(ref).api(`${gitlab(ref).base}/discussions?per_page=100&page=${page.page ?? 1}`);
    const { owner, name, api } = github(ref);
    const withThreads = page.threadsAfter !== null;
    const withFiles = page.filesAfter !== null;
    return {
      args: [
        ...api, "graphql", "-f", `query=${GITHUB_THREADS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${ref.number}`,
        "-F", `withThreads=${withThreads}`, "-F", `withFiles=${withFiles}`,
        ...(page.threadsAfter ? ["-f", `threadsAfter=${page.threadsAfter}`] : []),
        ...(page.filesAfter ? ["-f", `filesAfter=${page.filesAfter}`] : []),
      ],
    };
  },
  diff(ref: PullRequestRef, page = 1): CliCall {
    return ref.service === "github"
      ? { args: ["pr", "diff", ref.url, "--color", "never"] }
      : gitlab(ref).api(`${gitlab(ref).base}/diffs?per_page=100&page=${page}`);
  },
  /** GitHub's per-file listing, for a diff `gh pr diff` refuses (over 300 files or too large); one JSON object per line. */
  files(ref: PullRequestRef): CliCall {
    return { args: [...github(ref).api, "--paginate", `repos/${ref.repo}/pulls/${ref.number}/files?per_page=100`, "--jq", ".[]"] };
  },
  comment(ref: PullRequestRef, body: string): CliCall {
    if (ref.service === "github") return { args: ["pr", "comment", ref.url, "--body-file", "-"], input: body };
    return gitlab(ref).send("POST", `${gitlab(ref).base}/notes`, { body });
  },
  reply(ref: PullRequestRef, threadId: string, body: string): CliCall {
    if (ref.service === "gitlab") return gitlab(ref).send("POST", `${gitlab(ref).base}/discussions/${encodeURIComponent(threadId)}/notes`, { body });
    return { args: [...github(ref).api, "graphql", "--input", "-"], input: JSON.stringify({ query: REPLY_MUTATION, variables: { threadId, body } }) };
  },
  /** A new comment on one line of the diff, published at once rather than held for a review. */
  lineComment(ref: PullRequestRef, input: { path: string; line: number; side: "new" | "old"; body: string; headSha?: string; diffRefs?: { base: string; head: string; start: string } }): CliCall {
    if (ref.service === "github") {
      return {
        args: [...github(ref).api, "--method", "POST", `repos/${ref.repo}/pulls/${ref.number}/comments`, "--input", "-"],
        input: JSON.stringify({ body: input.body, commit_id: input.headSha, path: input.path, line: input.line, side: input.side === "old" ? "LEFT" : "RIGHT" }),
      };
    }
    const refs = input.diffRefs;
    return gitlab(ref).send("POST", `${gitlab(ref).base}/discussions`, {
      body: input.body,
      position: {
        position_type: "text",
        base_sha: refs?.base,
        head_sha: refs?.head,
        start_sha: refs?.start,
        new_path: input.path,
        old_path: input.path,
        ...(input.side === "old" ? { old_line: input.line } : { new_line: input.line }),
      },
    });
  },
  edit(ref: PullRequestRef, input: { title?: string; body?: string }): CliCall {
    if (ref.service === "gitlab") {
      return gitlab(ref).send("PUT", gitlab(ref).base, { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.body !== undefined ? { description: input.body } : {}) });
    }
    return {
      args: ["pr", "edit", ref.url, ...(input.title !== undefined ? ["--title", input.title] : []), ...(input.body !== undefined ? ["--body-file", "-"] : [])],
      ...(input.body !== undefined ? { input: input.body } : {}),
    };
  },
  /** GitHub only: the mark lives on the host. GitLab's live in the kit's own store. */
  viewed(ref: PullRequestRef, pullRequestId: string, path: string, viewed: boolean): CliCall {
    return { args: [...github(ref).api, "graphql", "--input", "-"], input: JSON.stringify({ query: viewedMutation(viewed), variables: { pullRequestId, path } }) };
  },
  /** A whole review at once: its verdict, its text and the line comments held for it (GitHub). */
  review(ref: PullRequestRef, input: { event: PullRequestReviewEvent; body: string; comments: readonly PendingReviewComment[]; headSha?: string }): CliCall {
    return {
      args: [...github(ref).api, "--method", "POST", `repos/${ref.repo}/pulls/${ref.number}/reviews`, "--input", "-"],
      input: JSON.stringify({
        ...(input.headSha ? { commit_id: input.headSha } : {}),
        event: REVIEW_EVENTS[input.event],
        ...(input.body ? { body: input.body } : {}),
        comments: input.comments.map((comment) => ({ path: comment.path, line: comment.line, side: comment.side === "old" ? "LEFT" : "RIGHT", body: comment.body })),
      }),
    };
  },
  /** GitLab only: an approval is its own call. */
  approve(ref: PullRequestRef): CliCall {
    return gitlab(ref).send("POST", `${gitlab(ref).base}/approve`, {});
  },
  resolve(ref: PullRequestRef, threadId: string, resolved: boolean): CliCall {
    if (ref.service === "gitlab") return gitlab(ref).send("PUT", `${gitlab(ref).base}/discussions/${encodeURIComponent(threadId)}`, { resolved });
    return { args: [...github(ref).api, "graphql", "--input", "-"], input: JSON.stringify({ query: RESOLVE_MUTATION(resolved), variables: { threadId } }) };
  },
  editComment(ref: PullRequestRef, input: { id: string; kind: "comment" | "review" | "review-comment"; body: string }): CliCall {
    if (ref.service === "gitlab") return gitlab(ref).send("PUT", `${gitlab(ref).base}/notes/${encodeURIComponent(input.id)}`, { body: input.body });
    return { args: [...github(ref).api, "graphql", "--input", "-"], input: JSON.stringify({ query: EDIT_MUTATIONS[input.kind], variables: { id: input.id, body: input.body } }) };
  },
  reviewers(ref: PullRequestRef, add: readonly string[], remove: readonly string[]): CliCall {
    if (ref.service === "gitlab") {
      return { args: ["mr", "update", String(ref.number), "--repo", `https://${ref.host}/${ref.repo}`, "--yes", ...add.map((login) => `--reviewer=+${login}`), ...remove.map((login) => `--reviewer=-${login}`)] };
    }
    return { args: ["pr", "edit", ref.url, ...(add.length > 0 ? ["--add-reviewer", add.join(",")] : []), ...(remove.length > 0 ? ["--remove-reviewer", remove.join(",")] : [])] };
  },
  labels(ref: PullRequestRef, add: readonly string[], remove: readonly string[]): CliCall {
    if (ref.service === "gitlab") {
      return gitlab(ref).send("PUT", gitlab(ref).base, { ...(add.length > 0 ? { add_labels: add.join(",") } : {}), ...(remove.length > 0 ? { remove_labels: remove.join(",") } : {}) });
    }
    return { args: ["pr", "edit", ref.url, ...(add.length > 0 ? ["--add-label", add.join(",")] : []), ...(remove.length > 0 ? ["--remove-label", remove.join(",")] : [])] };
  },
  /** The labels a request can be given: the repository's own. */
  repoLabels(ref: PullRequestRef): CliCall {
    if (ref.service === "gitlab") return gitlab(ref).api(`projects/${encodeURIComponent(ref.repo)}/labels?per_page=100`);
    return { args: ["label", "list", "--repo", `${ref.host}/${ref.repo}`, "--json", "name,color", "--limit", "200"] };
  },
  /** Who may be asked for a review. */
  assignable(ref: PullRequestRef): CliCall {
    if (ref.service === "gitlab") return gitlab(ref).api(`projects/${encodeURIComponent(ref.repo)}/members/all?per_page=100`);
    const { owner, name, api } = github(ref);
    return { args: [...api, "graphql", "-f", `query=${ASSIGNABLE_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`] };
  },
};

/** One page of a repository's requests: `limit + 1` rows are asked for, so a longer list is known to go on. */
export function listCall(service: RequestService, host: string, repo: string, input: { state: PullRequestListState; limit: number; search?: string; page?: number }): CliCall {
  if (service === "gitlab") {
    const query = new URLSearchParams({ state: GITLAB_LIST_STATES[input.state], per_page: "100", page: String(input.page ?? 1), order_by: "updated_at", ...(input.search ? { search: input.search } : {}) });
    return { args: ["api", "--hostname", host, `projects/${encodeURIComponent(repo)}/merge_requests?${query.toString()}`] };
  }
  return {
    args: ["pr", "list", "--repo", `${host}/${repo}`, "--state", input.state, "--limit", String(input.limit + 1), "--json", GITHUB_LIST_FIELDS, ...(input.search ? ["--search", input.search] : [])],
  };
}
