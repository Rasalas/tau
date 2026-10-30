import { describe, expect, it } from "vitest";
import { markRequiredForgejoChecks } from "./forgejo-required-checks.js";
import { parseForgejoChecks } from "./provider-forgejo.js";
import { checksRollup, checksSummary, checksUnfinished, asReviewRequest } from "./pull-request-logic.js";
import type { PullRequestCheck, PullRequestDetail } from "./protocol.js";

const observed: PullRequestCheck[] = [{ name: "build/linux", status: "passed" }, { name: "lint", status: "failed" }];
const branch = (contexts: unknown) => ({ protected: true, enable_status_check: true, status_check_contexts: contexts });

describe("Forgejo required status policy", () => {
  it("separates advisory failures and synthesizes missing required contexts including globs", () => {
    const checks = markRequiredForgejoChecks(observed, branch(["build/*", "deploy?", "deploy?"]));
    expect(checks.map(({ name, required, expected }) => [name, required, expected])).toEqual([["build/linux", true, undefined], ["lint", false, undefined], ["deploy?", true, true]]);
    expect(checks[2]?.description).toBe('Waiting for "deploy?" to report');
    expect(checksRollup(checks)).toBe("pending");
    expect(checksUnfinished(checks)).toBe(true);
    expect(checksSummary(checks)).toBe("1 of 2 required checks passed");
    const ready = markRequiredForgejoChecks(observed, branch(["build/*"]));
    expect(checksRollup(ready)).toBe("passing");
    expect(checksUnfinished(ready)).toBe(false);
    const detail = { ref: { service: "forgejo", number: 1 }, state: "open" } as PullRequestDetail;
    expect(asReviewRequest(detail, ready).checks).toEqual({ passed: 1, pending: 0, failed: 0, total: 1 });
  });

  it.each([[], [""], ["   "], [null], ["build/[ab]"], ["build/{a,b}"], ["build\\*"]].map((contexts) => ({ contexts })))("keeps invalid or unsupported contexts %j pending and unknown", ({ contexts }) => {
    const checks = markRequiredForgejoChecks([{ name: "build/a", status: "passed" }], branch(contexts));
    expect(checks.every((check) => check.required === undefined && check.requirementUnknown)).toBe(true);
    expect(checks.at(-1)).toMatchObject({ status: "pending", expected: true });
    expect(checksRollup(checks)).toBe("pending");
  });

  it("keeps unreadable metadata gating, including empty status coverage", () => {
    expect(checksRollup(markRequiredForgejoChecks(observed, {}))).toBe("failing");
    expect(checksRollup(markRequiredForgejoChecks([], {}))).toBe("pending");
    expect(markRequiredForgejoChecks([], branch(["ci/*"]))).toMatchObject([{ required: true, status: "pending", expected: true }]);
  });

  it("distinguishes disabled checks from an enabled empty or unknown rule and accepts skipped required checks", () => {
    expect(markRequiredForgejoChecks(observed, { enable_status_check: false }).every((check) => check.required === false)).toBe(true);
    expect(checksRollup(markRequiredForgejoChecks(observed, { protected: false }))).toBeUndefined();
    expect(checksSummary(markRequiredForgejoChecks(observed, { protected: false }))).toBe("No required checks");
    expect(checksRollup(markRequiredForgejoChecks([{ name: "build", status: "skipped" }], branch(["build"])))).toBe("passing");
  });

  it("bounds work before matching malicious patterns", () => {
    const checks = Array.from({ length: 200 }, (_, i) => ({ name: `${i}${"a".repeat(100)}`, status: "passed" as const }));
    expect(markRequiredForgejoChecks(checks, branch(["*a".repeat(100)])).at(-1)).toMatchObject({ expected: true, status: "pending", requirementUnknown: true });
  });

  it("retains workflow identity, newest job updates and concurrently running duplicates", () => {
    const statuses = [
      { id: 7, context: "test", workflow: "a", target_url: "/runs/2", status: "pending", updated_at: "2026-10-29T12:00:00Z" },
      { id: 8, context: "test", workflow: "b", target_url: "/runs/3", status: "success", updated_at: "2026-10-29T12:01:00Z" },
      { id: 9, context: "test", workflow: "a", target_url: "/runs/1", status: "success", updated_at: "2026-10-29T12:02:00Z" },
      { id: 1, context: "test", workflow: "b", target_url: "/runs/3", status: "pending", updated_at: "2026-10-29T11:00:00Z" },
    ];
    const checks = parseForgejoChecks(JSON.stringify(statuses), "https://forge.test/acme/repo/pulls/1");
    expect(checks).toMatchObject([{ name: "test", workflow: "a", status: "pending" }, { name: "test", workflow: "b", status: "passed" }]);
    expect(markRequiredForgejoChecks(checks, branch(["test"])).every((check) => check.required === true)).toBe(true);
  });
});

it("chooses the newest completed duplicate even when the API rows arrive out of order", () => {
  const rows = [
    { id: 1, context: "test", status: "success", target_url: "/old", updated_at: "2026-10-29T10:00:00Z" },
    { id: 2, context: "test", status: "failure", target_url: "/new", updated_at: "2026-10-29T12:00:00+01:00" },
  ];
  expect(parseForgejoChecks(JSON.stringify(rows), "https://forge.test/acme/repo/pulls/1")).toMatchObject([{ name: "test", status: "failed" }]);
});
