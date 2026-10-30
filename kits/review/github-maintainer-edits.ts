import { canSetMaintainerEdits } from "./maintainer-access.js";
import { HostCommandError } from "tau/host-extension";
import type { PullRequestDetail, PullRequestRef } from "./protocol.js";
import type { ProviderTools } from "./provider.js";

const READ = `query MaintainerAccess($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    id state maintainerCanModify viewerCanUpdate author { login }
    headRepository { nameWithOwner owner { __typename login } }
  } }
}`;
const UPDATE = `mutation MaintainerAccess($id: ID!, $allow: Boolean!) {
  updatePullRequest(input: { pullRequestId: $id, maintainerCanModify: $allow }) {
    pullRequest { id maintainerCanModify }
  }
}`;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

/** The shared PR authors/capabilities GraphQL response. */
export function parseMaintainerAccess(data: Record<string, unknown>): Partial<PullRequestDetail> {
  const pull = record(record(data.repository).pullRequest);
  const head = record(pull.headRepository);
  const viewer = record(data.viewer).login;
  // viewerCanUpdate also covers upstream maintainers. The fork owner must
  // be a personal account and the viewer the author before offering this grant.
  const permitted = pull.viewerCanUpdate === true && typeof viewer === "string" && record(pull.author).login === viewer
    && record(head.owner)["__typename"] === "User" && record(head.owner).login === viewer;
  return {
    ...(typeof pull.id === "string" ? { nodeId: pull.id } : {}),
    ...(typeof head.nameWithOwner === "string" ? { headRepository: head.nameWithOwner } : {}),
    ...(typeof pull.maintainerCanModify === "boolean" ? { maintainerCanModify: pull.maintainerCanModify } : {}),
    ...(typeof pull.viewerCanUpdate === "boolean" ? { viewerCanUpdate: pull.viewerCanUpdate } : {}),
    ...(pull.state === "OPEN" ? { state: "open" as const } : pull.state === "CLOSED" ? { state: "closed" as const } : pull.state === "MERGED" ? { state: "merged" as const } : {}),
    viewerCanAllowMaintainerEdits: permitted,
  };
}

export function createMaintainerEdits(tools: ProviderTools) {
  const query = async (ref: PullRequestRef, document: string, variables: unknown, cli = tools.cli) => {
    const output = await cli("github", { args: ["api", "--hostname", ref.host, "graphql", "--input", "-"], input: JSON.stringify({ query: document, variables }) }, "Reading or saving maintainer access", { host: ref.host });
    const raw = record(JSON.parse(output));
    if (Array.isArray(raw.errors) && raw.errors.length) throw new HostCommandError(String(record(raw.errors[0]).message ?? "GitHub could not read or save maintainer access."));
    return record(raw.data);
  };
  const read = async (ref: PullRequestRef, cli = tools.cli): Promise<Partial<PullRequestDetail>> => {
    const [owner, name] = ref.repo.split("/");
    const data = await query(ref, READ, { owner, name, number: ref.number }, cli);
    return parseMaintainerAccess(data);
  };
  const save = async (ref: PullRequestRef, allow: boolean, expected: boolean) => {
    const session = await tools.githubSession?.(ref.host);
    const cli = session?.cli ?? tools.cli;
    const fresh = await read(ref, cli);
    if (!canSetMaintainerEdits({ ref, ...fresh } as PullRequestDetail) || !fresh.nodeId) throw new HostCommandError("GitHub does not allow this account to change maintainer access on this request.");
    if (fresh.maintainerCanModify !== expected) throw new HostCommandError("Maintainer access changed; refresh before saving.");
    const data = await query(ref, UPDATE, { id: fresh.nodeId, allow }, cli);
    const updated = record(record(data.updatePullRequest).pullRequest);
    if (updated.id !== fresh.nodeId || updated.maintainerCanModify !== allow) throw new HostCommandError("GitHub did not confirm the saved maintainer access. Refresh before trying again.");
  };
  return { read, save };
}
