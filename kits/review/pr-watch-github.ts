import { HostCommandError } from "tau/host-extension";
import type { ProviderTools } from "./provider.js";
import type { PullRequestRef } from "./protocol.js";
import type { FailedCheck, WatchSnapshot } from "./pr-watch-protocol.js";
const QUERY = `query($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
    state mergeable headRefOid
    comments(last:1) { totalCount nodes { id updatedAt } }
    reviews(last:1) { totalCount nodes { id submittedAt state } }
    reviewThreads(last:100) { totalCount pageInfo { hasPreviousPage } nodes { comments(last:1) { totalCount nodes { id updatedAt } } } }
    commits(last:1) { nodes { commit {
      checkSuites(first:100) { pageInfo { hasNextPage } nodes { status workflowRun { databaseId } } }
      statusCheckRollup { state contexts(first:100) { pageInfo { hasNextPage } nodes { ... on CheckRun { databaseId name status conclusion } ... on StatusContext { context state targetUrl } } } }
    } } }
  } }
}`;
interface CheckContext { databaseId?: number; name?: string; status?: string; conclusion?: string; context?: string; state?: string; targetUrl?: string }
const PENDING = new Set<unknown>(["PENDING", "EXPECTED"]);
const FAILED_STATES = new Set<unknown>(["FAILURE", "ERROR"]);
const FAILED_CONCLUSIONS = new Set<unknown>(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
/** A single small read per PR, shared by every thread watching it; no file or conversation pagination. */
export function readWatchSnapshot(tools: ProviderTools, ref: PullRequestRef): Promise<WatchSnapshot> {
  return tools.cached("watch", ref, true, async () => {
    const [owner, repo] = ref.repo.split("/");
    const output = await tools.cli("github", { args: ["api", "graphql", "--hostname", ref.host, "-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${ref.number}`] }, `Watching PR #${ref.number}`, { host: ref.host });
    const result = JSON.parse(output);
    const pr = result.data?.repository?.pullRequest;
    if (result.errors?.length || !pr || !["OPEN", "MERGED", "CLOSED"].includes(pr.state) || typeof pr.headRefOid !== "string") throw new HostCommandError("GitHub did not return a readable pull request.");
    if (pr.reviewThreads?.pageInfo?.hasPreviousPage) throw new HostCommandError("This PR has more than 100 review threads; watching cannot reliably detect every reply.");
    const commit = pr.commits?.nodes?.[0]?.commit, rollup = commit?.statusCheckRollup;
    if (rollup?.contexts?.pageInfo?.hasNextPage || commit?.checkSuites?.pageInfo?.hasNextPage) throw new HostCommandError("This PR has more than 100 checks; watching cannot reliably detect every check finishing.");
    const contexts: CheckContext[] = rollup?.contexts?.nodes ?? [];
    // A workflow run stays unfinished until its later jobs (like smoke) have run, before their check runs exist.
    const running = (commit?.checkSuites?.nodes ?? []).some((suite: { status?: string; workflowRun?: unknown }) => suite.workflowRun && suite.status !== "COMPLETED");
    const pending = running || PENDING.has(rollup?.state) || contexts.some((node) => node.context ? PENDING.has(node.state) : node.status !== undefined && node.status !== "COMPLETED");
    const failed = contexts.flatMap((node): FailedCheck[] => node.context
      ? FAILED_STATES.has(node.state) ? [{ id: `${node.context} ${node.targetUrl ?? ""}`, name: node.context }] : []
      : node.status === "COMPLETED" && FAILED_CONCLUSIONS.has(node.conclusion) ? [{ id: String(node.databaseId), name: node.name ?? "check" }] : []);
    const checks = pending ? "pending" : rollup ? "done" : "none";
    return { state: pr.state, head: pr.headRefOid, checks, failed, comments: JSON.stringify([pr.comments, pr.reviews, pr.reviewThreads]), conflict: pr.mergeable === "CONFLICTING" };
  }, true);
}
