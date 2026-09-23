import { HostCommandError } from "tau/host-extension";
import type { MergeMethod, PullRequestRef, PullRequestStack, PullRequestStackLayer, PullRequestStackMembership, StackAction } from "./protocol.js";
import type { ProviderTools, RepositoryTarget } from "./provider.js";

/*
 * GitHub's stacks: requests based on one another that GitHub lists, merges
 * and rebases as one (`/repos/{owner}/{repo}/stacks`, still a preview). A
 * stack step compares every layer with the stack the user confirmed, so a
 * push in between refuses the step instead of acting on code nobody saw.
 */

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const whole = (value: unknown): number | undefined => typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/** A merge GitHub runs on its own is asked after about this long at most. */
const MERGE_DEADLINE_MS = 5 * 60_000;
/** Listed requests asked about at once. */
const MEMBERSHIP_BATCH = 100;

function layerState(raw: Json): PullRequestStackLayer["state"] {
  if (text(raw.merged_at)) return "merged";
  return text(raw.state)?.toLowerCase() === "closed" ? "closed" : "open";
}

/** The first stack of `GET …/stacks?pull_request=N`: a request is in one stack at most, and `[]` means none. */
export function parseGitHubStack(output: string, host: string, repo: string): PullRequestStack | undefined {
  const rows = JSON.parse(output) as unknown;
  const raw = record(Array.isArray(rows) ? rows[0] : undefined);
  const number = whole(raw.number);
  if (number === undefined || !Array.isArray(raw.pull_requests)) return undefined;
  const base = typeof raw.base === "string" ? raw.base : text(record(raw.base).ref) ?? "";
  const layers = raw.pull_requests.map(record).flatMap((layer): PullRequestStackLayer[] => {
    const layerNumber = whole(layer.number);
    const head = record(layer.head);
    const headRef = text(head.ref);
    if (layerNumber === undefined || !headRef) return [];
    return [{
      number: layerNumber,
      url: `https://${host}/${repo}/pull/${layerNumber}`,
      headRef,
      ...(text(head.sha) ? { headSha: text(head.sha) } : {}),
      state: layerState(layer),
      ...(typeof layer.draft === "boolean" ? { draft: layer.draft } : {}),
      ...(text(layer.title) ? { title: text(layer.title) } : {}),
    }];
  });
  return layers.length > 0 ? { number, base, layers } : undefined;
}

/** One query for many listed requests' stack positions, each under its own alias. */
export function stackMembershipQuery(numbers: readonly number[]): string {
  const fields = numbers.map((number) => `r${number}: pullRequest(number: ${number}) { stack { number size } stackEntry { position } }`).join(" ");
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
}

/** Where each listed request sits; a request on its own is left out. */
export function parseStackMemberships(output: string): Map<number, PullRequestStackMembership> {
  const found = new Map<number, PullRequestStackMembership>();
  const repository = record(record(record(JSON.parse(output)).data).repository);
  for (const [alias, value] of Object.entries(repository)) {
    const number = Number(alias.slice(1));
    const stack = record(record(value).stack);
    const position = whole(record(record(value).stackEntry).position);
    const stackNumber = whole(stack.number);
    const size = whole(stack.size);
    if (Number.isInteger(number) && stackNumber !== undefined && size !== undefined && position !== undefined) found.set(number, { number: stackNumber, size, position });
  }
  return found;
}

const titleQuery = (numbers: readonly number[]) =>
  `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${numbers.map((number) => `r${number}: pullRequest(number: ${number}) { title }`).join(" ")} } }`;

const permissionQuery = (numbers: readonly number[]) =>
  `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${numbers.map((number) => `r${number}: pullRequest(number: ${number}) { headRepository { viewerPermission } maintainerCanModify }`).join(" ")} } }`;

const LAYER_QUERY = `query($owner: String!, $name: String!, $number: Int!, $sha: String!, $done: [ID!]!) {
  done: nodes(ids: $done) { ... on PullRequest { headRefOid } }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id headRefOid baseRef { compare(headRef: $sha) { behindBy } } } }
}`;

const REBASE_MUTATION = `mutation($id: ID!, $sha: GitObjectID!) {
  updatePullRequestBranch(input: { pullRequestId: $id, expectedHeadOid: $sha, updateMethod: REBASE }) { pullRequest { headRefOid } }
}`;

const changed = (number: number, completed: number) => new HostCommandError(completed > 0
  ? `The stack changed at PR #${number} after ${completed} ${completed === 1 ? "layer" : "layers"}; those updates stay on GitHub. Refresh it before trying again.`
  : "The stack changed since you looked at it. Refresh it before trying again.");

/** GitHub's stacks for one provider: reading them, the list's positions and the two stack steps. */
export function createGitHubStacks(tools: ProviderTools) {
  const noStacks = new Map<string, number>();
  const cli = (host: string, args: string[], action: string, input?: string) =>
    tools.cli("github", { args: ["api", "--hostname", host, ...args], ...(input !== undefined ? { input } : {}) }, action, { host });
  const graphql = async (host: string, query: string, variables: Record<string, unknown>, action: string): Promise<Json> =>
    record(record(JSON.parse(await cli(host, ["graphql", "--input", "-"], action, JSON.stringify({ query, variables })))).data);
  const owner = (repo: string) => { const [login = "", name = ""] = repo.split("/"); return { owner: login, name }; };

  const read = async (ref: Pick<PullRequestRef, "host" | "repo" | "number">): Promise<PullRequestStack | undefined> => {
    const stack = parseGitHubStack(await cli(ref.host, [`repos/${ref.repo}/stacks?pull_request=${ref.number}`], `Reading the stack of PR #${ref.number}`), ref.host, ref.repo);
    if (!stack) return undefined;
    // The stacks API names no titles; one query adds them where it can.
    const titles = await graphql(ref.host, titleQuery(stack.layers.map((layer) => layer.number)), owner(ref.repo), "Reading the stack's titles").catch(() => ({}));
    const repository = record(record(titles).repository);
    return { ...stack, layers: stack.layers.map((layer) => ({ ...layer, ...(text(record(repository[`r${layer.number}`]).title) ? { title: text(record(repository[`r${layer.number}`]).title) } : {}) })) };
  };

  const current = async (ref: PullRequestRef, seen: PullRequestStack): Promise<{ stack: PullRequestStack; index: number }> => {
    const stack = await read(ref);
    const index = stack?.layers.findIndex((layer) => layer.number === ref.number) ?? -1;
    if (!stack || stack.number !== seen.number || index < 0) throw changed(ref.number, 0);
    return { stack, index };
  };

  /** Every open layer the step touches must still have the head the user saw. */
  const unmoved = (layers: readonly PullRequestStackLayer[], seen: PullRequestStack, number: number) => {
    for (const layer of layers) {
      const before = seen.layers.find((entry) => entry.number === layer.number);
      if (!before || !layer.headSha || before.headSha !== layer.headSha) throw changed(number, 0);
    }
  };

  const merge = async (ref: PullRequestRef, seen: PullRequestStack, method: MergeMethod) => {
    const { stack, index } = await current(ref, seen);
    const target = stack.layers[index]!;
    const open = stack.layers.slice(0, index + 1).filter((layer) => layer.state !== "merged");
    if (target.state !== "open") throw new HostCommandError(`PR #${target.number} is ${target.state}; only an open layer merges its stack.`);
    if (open.some((layer) => layer.state !== "open")) throw new HostCommandError("A closed layer sits below this one; reopen or remove it on GitHub first.");
    const draft = open.find((layer) => layer.draft);
    if (draft) throw new HostCommandError(`PR #${draft.number} is still a draft; mark it ready first.`);
    unmoved(open, seen, ref.number);
    const endpoint = `repos/${ref.repo}/pulls/${ref.number}/merge-async`;
    const answer = (output: string) => {
      const raw = record(JSON.parse(output));
      return { status: text(raw.status), uuid: text(record(raw.details).uuid), message: text(record(raw.details).message) };
    };
    let result = answer(await cli(ref.host, ["--method", "PUT", endpoint, "-f", `merge_method=${method}`, "-f", "merge_action=default", "-f", `sha=${target.headSha}`], `Merging the stack up to PR #${ref.number}`));
    const deadline = tools.now() + MERGE_DEADLINE_MS;
    for (let attempt = 0; result.status === "pending" && tools.now() < deadline; attempt += 1) {
      if (!result.uuid) throw new HostCommandError("GitHub answered the stack merge without an id to follow.");
      await tools.wait(Math.min(1_000 * 2 ** attempt, 10_000));
      result = answer(await cli(ref.host, [`${endpoint}/${encodeURIComponent(result.uuid)}`], "Following the stack merge"));
    }
    if (result.status === "pending") throw new HostCommandError("The merge is still running on GitHub. Check it there before asking again.");
    if (result.status === "failed") throw new HostCommandError(`GitHub refused the stack merge${result.message ? `: ${result.message}` : ""}. Check the branch rules and merge requirements.`);
    if (result.status !== "merged" && result.status !== "enqueued") throw new HostCommandError("GitHub answered the stack merge in a way Tau cannot read.");
  };

  const rebase = async (ref: PullRequestRef, seen: PullRequestStack) => {
    const { stack } = await current(ref, seen);
    const open = stack.layers.filter((layer) => layer.state !== "merged");
    if (open.length === 0 || open.some((layer) => layer.state !== "open")) throw new HostCommandError("Only a stack whose unmerged layers are all open can be rebased.");
    unmoved(open, seen, ref.number);
    const names = owner(ref.repo);
    const access = record((await graphql(ref.host, permissionQuery(open.map((layer) => layer.number)), names, "Checking who may update the stack")).repository);
    // An up-to-date layer reports it cannot be updated, so write access is asked on its own.
    const blocked = open.find((layer) => {
      const pr = record(access[`r${layer.number}`]);
      const permission = text(record(pr.headRepository).viewerPermission) ?? "";
      return !pr.headRepository || (pr.maintainerCanModify !== true && !["ADMIN", "MAINTAIN", "WRITE"].includes(permission));
    });
    if (blocked) throw new HostCommandError(`You cannot update the branch of PR #${blocked.number}. Check write access and whether maintainers may edit it.`);
    const done: Array<{ id: string; number: number; sha: string }> = [];
    for (const [index, layer] of open.entries()) {
      try {
        const data = await graphql(ref.host, LAYER_QUERY, { ...names, number: layer.number, sha: layer.headSha, done: done.map((entry) => entry.id) }, `Reading PR #${layer.number}`);
        const observed = Array.isArray(data.done) ? data.done.map(record) : [];
        // A push to a layer already done must not become the next layer's base unseen.
        const moved = done.find((entry, at) => text(observed[at]?.headRefOid) !== entry.sha);
        if (moved) throw changed(moved.number, index);
        const pr = record(record(data.repository).pullRequest);
        const id = text(pr.id);
        if (!id || text(pr.headRefOid) !== layer.headSha) throw changed(layer.number, index);
        const behind = record(record(pr.baseRef).compare).behindBy;
        if (behind === 0) { done.push({ id, number: layer.number, sha: layer.headSha! }); continue; }
        const updated = await graphql(ref.host, REBASE_MUTATION, { id, sha: layer.headSha }, `Rebasing PR #${layer.number}`);
        const sha = text(record(record(updated.updatePullRequestBranch).pullRequest).headRefOid);
        if (!sha) throw new HostCommandError("GitHub answered the rebase in a way Tau cannot read.");
        done.push({ id, number: layer.number, sha });
      } catch (error) {
        if (error instanceof HostCommandError && error.message.startsWith("The stack changed")) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        throw new HostCommandError(`The stack's rebase stopped at PR #${layer.number} after ${index} ${index === 1 ? "layer" : "layers"}; those updates stay on GitHub. Resolve that layer before trying again. (${reason})`);
      }
    }
  };

  return {
    stack: (ref: PullRequestRef, fresh: boolean) => tools.cached("stack", ref, fresh, () => read(ref)),
    memberships: async (target: RepositoryTarget, numbers: readonly number[]): Promise<Map<number, PullRequestStackMembership>> => {
      const found = new Map<number, PullRequestStackMembership>();
      const quiet = noStacks.get(target.host);
      if (numbers.length === 0 || (quiet !== undefined && tools.now() - quiet < 10 * 60_000)) return found;
      try {
        for (let at = 0; at < numbers.length; at += MEMBERSHIP_BATCH) {
          const batch = numbers.slice(at, at + MEMBERSHIP_BATCH);
          const output = await cli(target.host, ["graphql", "--input", "-"], "Reading stack positions", JSON.stringify({ query: stackMembershipQuery(batch), variables: owner(target.repo) }));
          for (const [number, membership] of parseStackMemberships(output)) found.set(number, membership);
        }
      } catch (error) {
        // A server without stacks refuses the fields; it is left alone for a while.
        noStacks.set(target.host, tools.now());
        tools.log("request.stacks-unavailable", `${target.host} · ${error instanceof Error ? error.message : String(error)}`);
      }
      return found;
    },
    act: async (ref: PullRequestRef, input: { action: StackAction; seen: PullRequestStack; method?: MergeMethod }) => {
      if (input.action === "merge") await merge(ref, input.seen, input.method ?? "merge");
      else await rebase(ref, input.seen);
      for (const layer of input.seen.layers) tools.forget({ ...ref, number: layer.number, url: layer.url });
    },
  };
}
