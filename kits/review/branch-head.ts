import type { PullRequestBranchHead } from "./protocol.js";

/** A bounded branch identity for a confirmed operation or a provider fetch source. */
export function readBranchHead(input: unknown): PullRequestBranchHead | undefined {
  if (!input || typeof input !== "object") return undefined;
  const { repository, branch, sha } = input as Partial<PullRequestBranchHead>;
  if (typeof repository !== "string" || repository.length > 300 || !/^[\w.-]+\/[\w.-]+$/u.test(repository) || repository.split("/").some((part) => part === "." || part === "..")) return undefined;
  if (typeof branch !== "string" || !branch || branch.length > 1024 || branch.includes("..") || branch.split("/").some((part) => !part)) return undefined;
  if (typeof sha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(sha)) return undefined;
  return { repository, branch, sha };
}
