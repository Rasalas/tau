import { HostCommandError } from "tau/host-extension";
import type { ProviderTools } from "./provider.js";
import type { PullRequestRef } from "./protocol.js";
import type { WatchSnapshot } from "./pr-watch-protocol.js";
const QUERY = `query($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
    state mergeable headRefOid
    comments(last:1) { totalCount nodes { id updatedAt } }
    reviews(last:1) { totalCount nodes { id submittedAt state } }
    reviewThreads(last:100) { totalCount pageInfo { hasPreviousPage } nodes { comments(last:1) { totalCount nodes { id updatedAt } } } }
    commits(last:1) { nodes { commit { statusCheckRollup { state contexts(first:100) { pageInfo { hasNextPage } nodes { ... on CheckRun { databaseId status conclusion completedAt } ... on StatusContext { context state targetUrl } } } } } } }
  } }
}`;
/** A single small read per PR, shared by every thread watching it; no file or conversation pagination. */
export function readWatchSnapshot(tools: ProviderTools, ref: PullRequestRef): Promise<WatchSnapshot> {
  return tools.cached("watch", ref, true, async () => {
    const [owner, repo] = ref.repo.split("/");
    const output = await tools.cli("github", { args: ["api", "graphql", "--hostname", ref.host, "-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${ref.number}`] }, `Watching PR #${ref.number}`, { host: ref.host });
    const result = JSON.parse(output);
    const pr = result.data?.repository?.pullRequest;
    if (result.errors?.length || !pr || !["OPEN", "MERGED", "CLOSED"].includes(pr.state) || typeof pr.headRefOid !== "string") throw new HostCommandError("GitHub did not return a readable pull request.");
    if (pr.reviewThreads?.pageInfo?.hasPreviousPage) throw new HostCommandError("This PR has more than 100 review threads; watching cannot reliably detect every reply.");
    const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
    if (rollup?.contexts?.pageInfo?.hasNextPage) throw new HostCommandError("This PR has more than 100 checks; watching cannot reliably detect every check finishing.");
    const terminal = (rollup?.contexts?.nodes ?? []).flatMap((node: { databaseId?: number; status?: string; conclusion?: string; completedAt?: string; context?: string; state?: string; targetUrl?: string }) => {
      if (node.status === "COMPLETED") return [[node.databaseId, node.conclusion, node.completedAt]];
      if (node.context && node.state && node.state !== "PENDING") return [[node.context, node.state, node.targetUrl]];
      return [];
    }).sort((left: unknown[], right: unknown[]) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const state = rollup?.state ?? "NONE";
    const checks = !rollup?.contexts || (terminal.length === 0 && ["NONE", "PENDING"].includes(state)) ? state : JSON.stringify([state, terminal]);
    return { state: pr.state, head: pr.headRefOid, checks, comments: JSON.stringify([pr.comments, pr.reviews, pr.reviewThreads]), conflict: pr.mergeable === "CONFLICTING" };
  }, true);
}
