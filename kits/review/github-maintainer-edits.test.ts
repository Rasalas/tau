import { describe, expect, it, vi } from "vitest";
import { createMaintainerEdits, parseMaintainerAccess } from "./github-maintainer-edits.js";
import { canSetMaintainerEdits } from "./maintainer-access.js";
import { createGitHubProvider } from "./provider-github.js";
import { createArgs } from "./request-cli.js";
import type { ProviderTools } from "./provider.js";
import type { PullRequestDetail, PullRequestRef } from "./protocol.js";

const ref: PullRequestRef = { service: "github", host: "github.example", repo: "acme/repo", number: 7, url: "https://github.example/acme/repo/pull/7" };
const pull = { id: "PR_7", state: "OPEN", author: { login: "octo" }, viewerCanUpdate: true, maintainerCanModify: true,
  headRepository: { nameWithOwner: "octo/repo", owner: { __typename: "User", login: "octo" } } };
const data = (patch = {}, viewer = "octo") => ({ viewer: { login: viewer }, repository: { pullRequest: { ...pull, ...patch } } });
function harness(options: { patch?: Record<string, unknown>; viewer?: string; failure?: boolean; confirmed?: boolean } = {}) {
  const cli = vi.fn<ProviderTools["cli"]>(async (_kind, call) => {
    const input = JSON.parse(call.input!);
    if (input.query.startsWith("mutation")) return JSON.stringify(options.failure ? { errors: [{ message: "permission denied" }] } : { data: { updatePullRequest: { pullRequest: { id: "PR_7", maintainerCanModify: options.confirmed ?? input.variables.allow } } } });
    return JSON.stringify({ data: data(options.patch, options.viewer) });
  });
  return { cli, access: createMaintainerEdits({ cli } as unknown as ProviderTools) };
}

describe("explicit GitHub maintainer access", () => {
  it("loads state and permission and sends an explicit false through GraphQL on the named host", async () => {
    const { access, cli } = harness();
    const loaded = await access.read(ref);
    expect(loaded).toMatchObject({ maintainerCanModify: true, viewerCanUpdate: true, viewerCanAllowMaintainerEdits: true });
    await access.save(ref, false, true);
    const write = cli.mock.calls.at(-1)!;
    expect(write[1].args).toContain("github.example");
    expect(JSON.parse(write[1].input!).variables).toEqual({ id: "PR_7", allow: false });
    expect(cli.mock.calls.filter(([, call]) => JSON.parse(call.input!).query.startsWith("mutation"))).toHaveLength(1);
  });
  it.each([
    { viewerCanUpdate: false }, { state: "CLOSED" }, { state: "MERGED" }, { maintainerCanModify: null },
    { headRepository: null }, { headRepository: { ...pull.headRepository, nameWithOwner: ref.repo } },
    { headRepository: { ...pull.headRepository, owner: { __typename: "Organization", login: "octo" } } },
  ])("refuses missing capability or ineligible fork state %j before a mutation", async (patch) => {
    const { access, cli } = harness({ patch });
    await expect(access.save(ref, false, true)).rejects.toThrow("does not allow");
    expect(cli).toHaveBeenCalledTimes(1);
  });
  it("does not confuse upstream edit permission with the author's grant", async () => {
    const { access, cli } = harness({ viewer: "upstream-maintainer" });
    await expect(access.save(ref, false, true)).rejects.toThrow("does not allow");
    expect(cli).toHaveBeenCalledTimes(1);
    expect(canSetMaintainerEdits({ ref, ...parseMaintainerAccess({}) } as PullRequestDetail)).toBe(false);
  });
  it("rejects stale expectations, GraphQL errors and unconfirmed writes", async () => {
    await expect(harness({ patch: { maintainerCanModify: false } }).access.save(ref, false, true)).rejects.toThrow("changed");
    await expect(harness({ failure: true }).access.save(ref, false, true)).rejects.toThrow("permission denied");
    await expect(harness({ confirmed: true }).access.save(ref, false, true)).rejects.toThrow("did not confirm");
  });
  it("does not change maintainer access during ordinary title/body updates", async () => {
    const cli = vi.fn<ProviderTools["cli"]>(async () => "{}");
    await createGitHubProvider({ cli } as unknown as ProviderTools).update(ref, { title: "Title", body: "Body" });
    expect(cli).toHaveBeenCalledTimes(1);
    expect(cli.mock.calls[0]?.[1]).not.toBeUndefined();
    expect(JSON.stringify(cli.mock.calls)).not.toContain("maintainerCanModify");
  });
  it("keeps creation's default on and forwards an explicit opt-out", () => {
    const input = { title: "Title", body: "Body", head: "feature", base: "main", draft: false };
    expect(createArgs("github", { ...input, maintainerCanModify: true })).not.toContain("--no-maintainer-edit");
    expect(createArgs("github", { ...input, maintainerCanModify: false })).toContain("--no-maintainer-edit");
  });
});

it("pins the signed-in credential across the permission check and mutation", async () => {
  const pinned = harness();
  const changing = vi.fn<ProviderTools["cli"]>(async () => { throw new Error("unscoped credential must not be used"); });
  const access = createMaintainerEdits({ cli: changing, githubSession: async () => ({ identity: "octo", cli: pinned.cli }) } as unknown as ProviderTools);
  await access.save(ref, false, true);
  expect(changing).not.toHaveBeenCalled();
  expect(pinned.cli).toHaveBeenCalledTimes(2);
});
