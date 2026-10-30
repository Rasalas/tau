import type { PullRequestCheck } from "./protocol.js";

/** Advisory status is explicitly false. Unreadable policy keeps all checks gating. */
export const gatingChecks = (checks: readonly PullRequestCheck[]): PullRequestCheck[] => checks.filter((check) => check.required !== false);
export const hasCheckPolicy = (checks: readonly PullRequestCheck[]): boolean => checks.some((check) => check.required !== undefined);
