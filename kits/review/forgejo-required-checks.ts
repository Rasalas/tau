import type { PullRequestCheck } from "./protocol.js";

export const REQUIRED_CHECKS_UNKNOWN = "Required checks unknown: Tau can't read this branch's protection rules.";
type BranchPolicy = { protected?: unknown; enable_status_check?: unknown; status_check_contexts?: unknown };

/** Bounded glob evaluation: Forgejo uses gobwas/glob without a path separator.
 * Only * and ? are supported here. Classes, alternation and escapes stay unknown.
 * The limits bound the dynamic program even for adversarial patterns. */
function matches(pattern: string, context: string): boolean {
  const chars = Array.from(context);
  let row = Array<boolean>(chars.length + 1).fill(false);
  row[0] = true;
  for (const token of Array.from(pattern)) {
    const next = Array<boolean>(chars.length + 1).fill(false);
    next[0] = token === "*" && row[0]!;
    for (let i = 1; i <= chars.length; i++) next[i] = token === "*" ? row[i]! || next[i - 1]! : row[i - 1]! && (token === "?" || token === chars[i - 1]);
    row = next;
  }
  return row[chars.length]!;
}

/** Unknown policy retains the old all-status rollup. Empty coverage needs an explicit
 * pending expectation so no caller mistakes an unreadable policy for successful checks. */
export function unknownForgejoChecks(checks: readonly PullRequestCheck[], reason?: string): PullRequestCheck[] {
  const marked = checks.map(({ required: _required, ...check }) => ({ ...check, requirementUnknown: true }));
  return reason || !marked.length ? [...marked, { name: "Required checks", status: "pending", expected: true, requirementUnknown: true, description: reason ?? REQUIRED_CHECKS_UNKNOWN }] : marked;
}

export function markRequiredForgejoChecks(checks: readonly PullRequestCheck[], policy: BranchPolicy): PullRequestCheck[] {
  if ((policy.protected === false && policy.enable_status_check !== true) || policy.enable_status_check === false) return checks.map((check) => ({ ...check, required: false }));
  if (policy.enable_status_check !== true || !Array.isArray(policy.status_check_contexts)) return unknownForgejoChecks(checks);
  const contexts: unknown[] = policy.status_check_contexts;
  // Enabled checks with no valid contexts are not evidence of an unprotected branch.
  if (!contexts.length || contexts.length > 100 || contexts.some((value) => typeof value !== "string" || !value.trim() || value.length > 256 || /[[\]{}\\]/u.test(value)) || checks.some((check) => check.name.length > 512)) {
    return unknownForgejoChecks(checks, "Required check patterns cannot be evaluated.");
  }
  const patterns = [...new Set(contexts as string[])];
  if (patterns.reduce((sum, pattern) => sum + pattern.length, 0) * checks.reduce((sum, check) => sum + check.name.length + 1, 0) > 2_000_000) return unknownForgejoChecks(checks, "Required check patterns exceed the evaluation limit.");
  const marked = checks.map((check) => ({ ...check, required: patterns.some((pattern) => matches(pattern, check.name)) }));
  return [...marked, ...patterns.filter((pattern) => !checks.some((check) => matches(pattern, check.name))).map((name): PullRequestCheck => ({
    name, status: "pending", required: true, expected: true, description: `Waiting for "${name}" to report`,
  }))];
}
