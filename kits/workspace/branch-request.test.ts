import { describe, expect, it, vi } from "vitest";
import { createBranchRequests } from "./branch-request.js";

const REQUEST = { provider: "forgejo", number: 12, title: "Bases", url: "https://codeberg.org/acme/tau/pulls/12", baseRef: "main", state: "merged" };

function git(branch: string, remotes: string) {
  return vi.fn(async (_cwd: string, args: string[]) => {
    if (args[0] === "branch") return `${branch}\n`;
    if (args[0] === "remote" && args[1] === "get-url") return `https://codeberg.org/acme/${args[2]}.git\n`;
    if (args[0] === "remote") return remotes;
    throw new Error(`unexpected git ${args.join(" ")}`);
  });
}

describe("a branch's request, asked of Review Kit", () => {
  it("names the branch and the primary remote and passes the answer on", async () => {
    const ask = vi.fn(async () => REQUEST);
    const detect = createBranchRequests(ask, git("feature/bases", "upstream\norigin\n"));
    await expect(detect("/worktree", { fresh: true })).resolves.toEqual(REQUEST);
    expect(ask).toHaveBeenCalledWith({ root: "/worktree", branch: "feature/bases", remote: "https://codeberg.org/acme/origin.git", fresh: true });
  });

  it("goes by Git alone without a branch, a remote, a request or Review Kit", async () => {
    const ask = vi.fn(async () => REQUEST);
    await expect(createBranchRequests(ask, git("", "origin\n"))("/w")).resolves.toBeUndefined();
    await expect(createBranchRequests(ask, git("topic", ""))("/w")).resolves.toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
    await expect(createBranchRequests(async () => undefined, git("topic", "origin\n"))("/w")).resolves.toBeUndefined();
    await expect(createBranchRequests(async () => { throw new Error("Host extension tau.review is not installed."); }, git("topic", "origin\n"))("/w")).resolves.toBeUndefined();
    await expect(createBranchRequests(async () => ({ number: "12" }), git("topic", "origin\n"))("/w")).resolves.toBeUndefined();
  });
});
