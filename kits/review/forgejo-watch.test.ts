import { expect, it } from "vitest";
import { forgejoWatchSnapshot } from "./forgejo-watch.js";
import { markRequiredForgejoChecks } from "./forgejo-required-checks.js";
import { watchChanges, watchStanding } from "./pr-watch-protocol.js";
const pull = { state: "open", head: { sha: "head" }, mergeable: true };
const policy = { enable_status_check: true, status_check_contexts: ["build"] };
it("finishes when required checks finish, and wakes once for a distinct advisory failure", () => {
  const before = forgejoWatchSnapshot(pull, markRequiredForgejoChecks([{ name: "build", status: "pending" }, { name: "lint", status: "pending" }], policy), []);
  const optional = forgejoWatchSnapshot(pull, markRequiredForgejoChecks([{ name: "build", status: "pending" }, { name: "lint", status: "failed" }], policy), []);
  expect(watchChanges(before, optional)).toEqual(["optional a check failed (lint)"]);
  expect(watchChanges(optional, optional)).toEqual([]);
  const after = forgejoWatchSnapshot(pull, markRequiredForgejoChecks([{ name: "build", status: "skipped" }, { name: "lint", status: "failed" }, { name: "metrics", status: "pending" }], policy), []);
  expect(after.checks).toBe("done");
  expect(watchChanges(optional, after)).toEqual(["required checks passed"]);
  expect(watchStanding(after)).toContain("optional a check failed (lint)");
});
it("keeps unknown policies gating, missing checks pending and required failures distinct", () => {
  expect(forgejoWatchSnapshot(pull, markRequiredForgejoChecks([], policy), []).checks).toBe("pending");
  const failed = forgejoWatchSnapshot(pull, markRequiredForgejoChecks([{ name: "build", status: "failed" }], {}), []);
  expect(failed.failed).toHaveLength(1);
  expect(failed.advisoryFailed).toEqual([]);
  const before = forgejoWatchSnapshot(pull, markRequiredForgejoChecks([{ name: "build", status: "pending" }], policy), []);
  expect(watchChanges(before, failed)).toEqual(["checks finished, a check failed (build)"]);
});
it("fingerprints older remark edits independently of ordering without persisting their bodies", () => {
  const remarks = [{ id: 1, body: "first", updated_at: "one" }, { id: "review:2", body: "last", updated_at: "two" }];
  const before = forgejoWatchSnapshot(pull, [], remarks);
  expect(forgejoWatchSnapshot(pull, [], [...remarks].reverse()).comments).toBe(before.comments);
  const after = forgejoWatchSnapshot(pull, [], [{ ...remarks[0], body: "edited" }, remarks[1]!]);
  expect(watchChanges(before, after)).toEqual(["new comments or reviews"]);
  expect(after.comments).toHaveLength(64);
});
