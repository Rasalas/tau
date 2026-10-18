import type { MergeOutcome, PullRequestBranchHead, PullRequestRef } from "./protocol.js";
import type { ProviderTools } from "./provider.js";
import { readBranchHead } from "./branch-deletion.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const ASSOCIATIONS = "query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) { ref(qualifiedName: $branch) { name associatedPullRequests(states: OPEN, first: 1) { totalCount } } } }";

/** Explicit deletion uses fresh GitHub facts, including the fork's own repository. */
export async function deleteClosedBranch(tools: ProviderTools, ref: PullRequestRef, seen: PullRequestBranchHead): Promise<MergeOutcome> {
  const keep = (branchKept: string): MergeOutcome => ({ branchKept });
  const call = (args: string[]) => tools.cli("github", { args }, `Checking or deleting the branch of PR #${ref.number}`, { host: ref.host });
  const api = (path: string) => call(["api", "--hostname", ref.host, path]);
  const read = async () => record(JSON.parse(await call(["pr", "view", String(ref.number), "--repo", `${ref.host}/${ref.repo}`, "--json", "state,headRefName,headRefOid,headRepository,headRepositoryOwner"])));
  const fits = (raw: Record<string, unknown>) => {
    const owner = record(raw.headRepositoryOwner).login;
    const name = record(raw.headRepository).name;
    if (typeof owner !== "string" || !owner || typeof name !== "string" || !name) return false;
    const head = readBranchHead({ repository: `${owner}/${name}`, branch: raw.headRefName, sha: raw.headRefOid });
    return head && head.repository.toLowerCase() === seen.repository.toLowerCase() && head.branch === seen.branch && head.sha === seen.sha;
  };
  try {
    if (!readBranchHead(seen)) return keep("Refresh the request and confirm its repository, branch and commit.");
    const current = await read();
    if (current.state !== "CLOSED" && current.state !== "MERGED") return keep("Only a closed or merged pull request's branch can be deleted.");
    if (!fits(current)) return keep("The request's repository, branch or commit changed. Refresh and confirm again.");
    const where = `repos/${seen.repository}`;
    const repo = record(JSON.parse(await api(where)));
    if (typeof repo.default_branch !== "string" || !repo.default_branch || typeof repo.full_name !== "string" || repo.full_name.toLowerCase() !== seen.repository.toLowerCase()) return keep("GitHub did not confirm the head repository and its default branch.");
    if (repo.default_branch === seen.branch) return keep(`${seen.branch} is the default branch of ${seen.repository}.`);
    const [headOwner, headName] = seen.repository.split("/");
    // Ref associations include requests targeting other repositories in the
    // fork network, not just requests listed on this PR's base repository.
    const response = record(JSON.parse(await tools.cli("github", {
      args: ["api", "--hostname", ref.host, "graphql", "--input", "-"],
      input: JSON.stringify({ query: ASSOCIATIONS, variables: { owner: headOwner, name: headName, branch: `refs/heads/${seen.branch}` } }),
    }, "Checking open pull requests of the head branch", { host: ref.host })));
    if (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length > 0)) return keep("GitHub could not confirm the branch's open pull requests.");
    const associated = record(record(record(response.data).repository).ref);
    const count = record(associated.associatedPullRequests).totalCount;
    if (associated.name !== seen.branch || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return keep("GitHub could not confirm the branch's open pull requests.");
    if (count > 0) return keep("Another open pull request uses the branch.");
    for (const repository of new Set([ref.repo, seen.repository])) {
      const requests: unknown = JSON.parse(await api(`repos/${repository}/pulls?state=open&base=${encodeURIComponent(seen.branch)}&per_page=1`));
      if (!Array.isArray(requests)) return keep("GitHub could not confirm whether other open requests use the branch.");
      if (requests.length > 0) return keep("Another open pull request uses the branch.");
    }
    const branchPath = seen.branch.split("/").map(encodeURIComponent).join("/");
    const tip = record(JSON.parse(await api(`${where}/git/ref/heads/${branchPath}`)));
    if (tip.ref !== `refs/heads/${seen.branch}` || record(tip.object).type !== "commit" || record(tip.object).sha !== seen.sha) return keep("The remote branch is missing or moved to another commit.");
    const latest = await read();
    if ((latest.state !== "CLOSED" && latest.state !== "MERGED") || !fits(latest)) return keep("The request changed while checking the branch. Refresh and confirm again.");
    // GitHub offers no expected-SHA parameter on DELETE. These reads and the
    // deletion are separate requests, so they do not form an atomic lease.
    await call(["api", "--hostname", ref.host, "--method", "DELETE", `${where}/git/refs/heads/${branchPath}`]);
    return { branchDeleted: seen.branch };
  } catch (error) { return keep(error instanceof Error ? error.message : String(error)); }
}
