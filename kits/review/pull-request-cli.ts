import type { PullRequestRef } from "./protocol.js";

/** One CLI call: its arguments and, for a write, the JSON or text it reads from stdin. */
export interface CliCall {
  args: string[];
  input?: string;
}

export const GITHUB_VIEW_FIELDS = [
  "id", "number", "title", "body", "url", "state", "isDraft", "author", "createdAt", "updatedAt", "mergedAt", "closedAt",
  "baseRefName", "headRefName", "headRefOid", "additions", "deletions", "changedFiles", "labels", "reviewRequests",
  "latestReviews", "reviews", "comments", "commits", "statusCheckRollup",
].join(",");

export const GITHUB_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      reviewThreads(first: 100) {
        nodes { id isResolved isOutdated path line originalLine diffSide
          comments(first: 100) { nodes { id body createdAt url author { login } } } }
      }
      files(first: 100) { nodes { path viewerViewedState } }
    }
  }
}`;

const REPLY_MUTATION = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } }
}`;

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
  threads(ref: PullRequestRef): CliCall {
    if (ref.service === "gitlab") return gitlab(ref).api(`${gitlab(ref).base}/discussions?per_page=100`);
    const { owner, name, api } = github(ref);
    return { args: [...api, "graphql", "-f", `query=${GITHUB_THREADS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${ref.number}`] };
  },
  diff(ref: PullRequestRef): CliCall {
    return ref.service === "github"
      ? { args: ["pr", "diff", ref.url, "--color", "never"] }
      : gitlab(ref).api(`${gitlab(ref).base}/diffs?per_page=100`);
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
};
