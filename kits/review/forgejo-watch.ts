import { createHash } from "node:crypto";
import type { PullRequestCheck } from "./protocol.js";
import type { FailedCheck, WatchSnapshot } from "./pr-watch-protocol.js";
import { gatingChecks, hasCheckPolicy } from "./required-checks.js";

type Row = Record<string, unknown>;
/** A fresh, completely paginated Forgejo read. Status policy remains distinct
 * from merge permission; an optional failure wakes once without holding done. */
export function forgejoWatchSnapshot(pull: Row, checks: readonly PullRequestCheck[], remarks: readonly Row[]): WatchSnapshot {
  const head = (pull.head as Row | undefined)?.sha;
  if (typeof head !== "string" || !head || !["open", "closed"].includes(String(pull.state))) throw new Error("Forgejo did not return a readable PR watch snapshot.");
  const gating = gatingChecks(checks);
  const failures = (items: readonly PullRequestCheck[]): FailedCheck[] => items.filter((check) => ["failed", "cancelled", "action-required"].includes(check.status)).map((check) => ({
    id: createHash("sha256").update(JSON.stringify([check.workflow ?? "", check.name, check.url ?? ""])).digest("hex"), name: (check.workflow ? `${check.workflow} / ${check.name}` : check.name).slice(0, 200),
  }));
  const known = hasCheckPolicy(checks);
  return {
    head, state: pull.merged === true ? "MERGED" : pull.state === "closed" ? "CLOSED" : "OPEN",
    checks: gating.some((check) => ["pending", "action-required"].includes(check.status)) ? "pending" : gating.length || known ? "done" : "none",
    failed: failures(gating), ...(known ? { requiredChecks: true } : {}), advisoryFailed: failures(checks.filter((check) => check.required === false)),
    comments: createHash("sha256").update(JSON.stringify(remarks.map((row) => [row.id, row.updated_at ?? row.submitted_at ?? row.created_at, row.state, row.body]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest("hex"),
    conflict: pull.mergeable === false,
  };
}
