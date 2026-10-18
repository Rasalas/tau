import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  EMPTY_POLICY,
  NO_CLEANUP,
  decodePolicy,
  evaluateWorktree,
  manualRemovalRefusal,
  patchPolicy,
  policyActive,
  rulesFor,
  type WorktreeFacts,
} from "./worktree-cleanup.js";

const NOW = 100 * DAY_MS;

/** A clean, idle worktree Tau made, with nothing of its own. */
const facts = (patch: Partial<WorktreeFacts> = {}): WorktreeFacts => ({
  recorded: true,
  exists: true,
  insideWorktreesDir: true,
  linked: true,
  hostWorkspace: false,
  threads: 1,
  openThreads: 0,
  threadDeleted: false,
  dirtyFiles: 0,
  ignoredFiles: 0,
  unpushedCommits: 0,
  commitsBeyondBase: 0,
  integrated: true,
  lastActivityAt: NOW - DAY_MS,
  ...patch,
});

describe("worktree cleanup rules", () => {
  it("removes nothing while every rule is off", () => {
    expect(evaluateWorktree(facts(), NO_CLEANUP, NOW)).toEqual({ remove: false, reasons: [], blockers: [] });
  });

  it("names each rule that matches", () => {
    const all = { afterDays: 7, onMerge: true, onThreadDelete: true, unchanged: true };
    expect(evaluateWorktree(facts({ threads: 0, threadDeleted: true, lastActivityAt: NOW - 8 * DAY_MS }), all, NOW).reasons)
      .toEqual(["thread-deleted", "inactive", "unchanged"]);
    expect(evaluateWorktree(facts({ commitsBeyondBase: 2, integrated: true }), all, NOW).reasons).toEqual(["merged"]);
    // Commits of its own that the default branch does not have are neither merged nor unchanged.
    expect(evaluateWorktree(facts({ commitsBeyondBase: 2, integrated: false }), all, NOW).reasons).toEqual([]);
    // A squash or rebase merge leaves the commits outside the default branch; the request says it merged.
    expect(evaluateWorktree(facts({ commitsBeyondBase: 2, integrated: false, requestMerged: true }), all, NOW).reasons).toEqual(["merged"]);
    expect(evaluateWorktree(facts({ commitsBeyondBase: 2, requestMerged: true }), { ...all, onMerge: false }, NOW).reasons).toEqual([]);
  });

  it("counts inactivity from the last thing that happened there", () => {
    const rules = { ...NO_CLEANUP, afterDays: 7 };
    expect(evaluateWorktree(facts({ lastActivityAt: NOW - 6 * DAY_MS }), rules, NOW).remove).toBe(false);
    expect(evaluateWorktree(facts({ lastActivityAt: NOW - 7 * DAY_MS }), rules, NOW).remove).toBe(true);
  });

  it("takes a deleted thread's worktree only once no thread is left in it", () => {
    const rules = { ...NO_CLEANUP, onThreadDelete: true };
    expect(evaluateWorktree(facts({ threadDeleted: true, threads: 1 }), rules, NOW).remove).toBe(false);
    expect(evaluateWorktree(facts({ threadDeleted: true, threads: 0 }), rules, NOW).remove).toBe(true);
  });

  it("retains settled worktrees until both the last settlement and activity are old enough", () => {
    const rules = { ...NO_CLEANUP, afterSettledDays: 7 };
    const old = { settledAt: NOW - 8 * DAY_MS, lastActivityAt: NOW - 8 * DAY_MS };
    expect(evaluateWorktree(facts(old), rules, NOW).reasons).toEqual(["settled"]);
    expect(evaluateWorktree(facts({ ...old, settledAt: NOW - 6 * DAY_MS }), rules, NOW).remove).toBe(false);
    expect(evaluateWorktree(facts({ ...old, lastActivityAt: NOW - 6 * DAY_MS }), rules, NOW).remove).toBe(false);
    expect(evaluateWorktree(facts({ ...old, settledAt: undefined }), rules, NOW).remove).toBe(false);
    expect(evaluateWorktree(facts(old), NO_CLEANUP, NOW).remove).toBe(false);
    for (const protection of [{ dirtyFiles: 1 }, { ignoredFiles: 1 }, { unpushedCommits: 1 }, { openThreads: 1 }, { hostWorkspace: true }]) {
      expect(evaluateWorktree(facts({ ...old, ...protection }), rules, NOW).remove).toBe(false);
    }
  });

  it("never removes uncommitted work, ignored files, unpushed commits or an open thread's checkout", () => {
    const rules = { ...NO_CLEANUP, unchanged: true };
    expect(evaluateWorktree(facts({ dirtyFiles: 1 }), rules, NOW)).toEqual({ remove: false, reasons: ["unchanged"], blockers: ["uncommitted"] });
    expect(evaluateWorktree(facts({ ignoredFiles: 1 }), rules, NOW).blockers).toEqual(["ignored-files"]);
    expect(evaluateWorktree(facts({ unpushedCommits: 1 }), rules, NOW).blockers).toEqual(["unpushed"]);
    expect(evaluateWorktree(facts({ openThreads: 1 }), rules, NOW).blockers).toEqual(["thread-open"]);
    expect(evaluateWorktree(facts({ hostWorkspace: true }), rules, NOW).blockers).toEqual(["host-workspace"]);
  });

  it("fails closed on anything it cannot vouch for", () => {
    const rules = { ...NO_CLEANUP, unchanged: true };
    for (const [patch, blocker] of [
      [{ recorded: false }, "not-recorded"],
      [{ insideWorktreesDir: false }, "outside-worktrees-dir"],
      [{ linked: false }, "not-linked"],
      [{ exists: false }, "missing"],
      [{ inspectionError: "fatal" }, "inspection-failed"],
    ] as const) {
      const verdict = evaluateWorktree(facts(patch), rules, NOW);
      expect(verdict.remove).toBe(false);
      expect(verdict.blockers).toContain(blocker);
    }
  });

  it("lets a hand removal override only what a confirmation can answer", () => {
    const rules = { ...NO_CLEANUP };
    expect(manualRemovalRefusal(evaluateWorktree(facts({ dirtyFiles: 3, unpushedCommits: 1 }), rules, NOW))).toBeUndefined();
    expect(manualRemovalRefusal(evaluateWorktree(facts({ openThreads: 1 }), rules, NOW))).toBe("thread-open");
    expect(manualRemovalRefusal(evaluateWorktree(facts({ insideWorktreesDir: false }), rules, NOW))).toBe("outside-worktrees-dir");
  });
});

describe("cleanup policy", () => {
  it("reads what it knows and drops the rest", () => {
    expect(decodePolicy(undefined)).toEqual(EMPTY_POLICY);
    expect(decodePolicy({
      host: { afterDays: 0.4, onMerge: "yes", unchanged: true },
      projects: { "/repo": { mode: "custom", rules: { afterDays: 99_999 } }, "/other": { mode: "off" }, "/bad": { mode: "sometimes" } },
    })).toEqual({
      host: { afterDays: 1, afterSettledDays: null, onMerge: false, onThreadDelete: false, unchanged: true },
      projects: { "/repo": { mode: "custom", rules: { afterDays: 3_650 } }, "/other": { mode: "off" } },
    });
  });

  it("layers a project's override over the host's rules", () => {
    let policy = patchPolicy(EMPTY_POLICY, { rules: { onThreadDelete: true, afterDays: 30 } });
    expect(rulesFor(policy, "/repo")).toEqual({ afterDays: 30, afterSettledDays: null, onMerge: false, onThreadDelete: true, unchanged: false });
    policy = patchPolicy(policy, { project: "/repo", mode: "custom", rules: { afterDays: null, unchanged: true } });
    policy = patchPolicy(policy, { project: "/repo", mode: "custom", rules: { onMerge: true } });
    expect(rulesFor(policy, "/repo")).toEqual({ afterDays: null, afterSettledDays: null, onMerge: true, onThreadDelete: true, unchanged: true });
    expect(rulesFor(patchPolicy(policy, { project: "/repo", mode: "off" }), "/repo")).toEqual(NO_CLEANUP);
    expect(rulesFor(patchPolicy(policy, { project: "/repo", mode: "inherit" }), "/repo")).toEqual(policy.host);
  });

  it("is active once any repository has a rule on", () => {
    expect(policyActive(EMPTY_POLICY)).toBe(false);
    expect(policyActive(patchPolicy(EMPTY_POLICY, { project: "/repo", mode: "custom", rules: { unchanged: true } }))).toBe(true);
    expect(policyActive(patchPolicy(EMPTY_POLICY, { project: "/repo", mode: "off" }))).toBe(false);
  });

  it("bounds settle retention, persists overrides, and leaves old policies opted out", () => {
    expect(decodePolicy({ host: { onMerge: true } }).host.afterSettledDays).toBeNull();
    const policy = patchPolicy(EMPTY_POLICY, { rules: { afterSettledDays: 99_999 } });
    expect(policy.host.afterSettledDays).toBe(3650);
    expect(policyActive(policy)).toBe(true);
    const custom = patchPolicy(policy, { project: "/repo", mode: "custom", rules: { afterSettledDays: 0 } });
    expect(rulesFor(decodePolicy(JSON.parse(JSON.stringify(custom))), "/repo").afterSettledDays).toBe(1);
    expect(rulesFor(patchPolicy(custom, { project: "/repo", mode: "custom", rules: { afterSettledDays: null } }), "/repo").afterSettledDays).toBeNull();
    expect(rulesFor(patchPolicy(custom, { project: "/repo", mode: "off" }), "/repo").afterSettledDays).toBeNull();
    expect(rulesFor(patchPolicy(custom, { project: "/repo", mode: "inherit" }), "/repo").afterSettledDays).toBe(3650);
    for (const value of ["7", NaN, Infinity]) expect(patchPolicy(EMPTY_POLICY, { rules: { afterSettledDays: value } }).host.afterSettledDays).toBeNull();
  });
});
