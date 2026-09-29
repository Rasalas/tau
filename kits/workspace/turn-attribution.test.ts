import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attributeTurnChanges,
  headSteps,
  legacyHeadMove,
  parseReflog,
  readHeadReflog,
  recordedAttribution,
  reflogStepKind,
} from "./turn-attribution.js";
import { attributeSnapshotPair, pageAttribution, reviseLegacyCheckpoint } from "./workspace-kit-checkpoints.js";
import { createTurnWorkspaceSnapshot, diffWorkspaceSnapshotPage, diffWorkspaceSnapshots, type WorkspaceSnapshot } from "./workspace-git.js";
import { boundedTurnCheckpointSummary, parseStoredTurnCheckpoint, turnSnapshotRef } from "./turn-checkpoint-codec.js";
import type { StoredTurnCheckpoint, TurnChangesSummary } from "./turn-checkpoint-types.js";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function repo(name = "tau-attribution-"): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), name));
  dirs.push(cwd);
  git(cwd, "init", "-q", "-b", "feat");
  git(cwd, "config", "user.email", "tau@example.test");
  git(cwd, "config", "user.name", "Tau Test");
  await writeFile(join(cwd, "README.md"), "readme\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "base");
  return cwd;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

let turn = 0;
/** One turn: before snapshot, what happens in it, after snapshot, the summary as the lifecycle computes it. */
async function runTurn(cwd: string, during: () => Promise<void> | void): Promise<{ summary: TurnChangesSummary; before: WorkspaceSnapshot; after: WorkspaceSnapshot; turnId: string }> {
  const turnId = `turn-${(turn += 1)}`;
  const before = await createTurnWorkspaceSnapshot(cwd, "session", turnId, "before");
  await during();
  const after = await createTurnWorkspaceSnapshot(cwd, "session", turnId, "after");
  const changes = await diffWorkspaceSnapshots(cwd, before.id, after.id);
  return { summary: await attributeSnapshotPair(cwd, changes, before, after), before, after, turnId };
}

/** A branch that differs from feat in `count` files. */
async function stageBranch(cwd: string, count: number): Promise<void> {
  git(cwd, "switch", "-q", "-c", "stage");
  for (let index = 0; index < count; index += 1) await writeFile(join(cwd, `stage-${index}.txt`), `stage ${index}\n`);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "stage work");
  git(cwd, "switch", "-q", "feat");
}

const paths = (summary: TurnChangesSummary) => summary.files.map((file) => file.path);

describe("turn attribution when HEAD moves", () => {
  it("leaves out what a branch switch during the turn brought in", async () => {
    const cwd = await repo();
    await stageBranch(cwd, 5);
    const { summary } = await runTurn(cwd, async () => {
      await writeFile(join(cwd, "notes.md"), "agent\n");
      git(cwd, "switch", "-q", "stage");
    });
    expect(paths(summary)).toEqual(["notes.md"]);
    expect(summary.fileCount).toBe(1);
    expect(summary.added).toBe(1);
    expect(summary.head).toMatchObject({ beforeBranch: "feat", afterBranch: "stage" });
    expect(summary.headMove).toMatchObject({ kind: "checkout", excludedFileCount: 5, uncertainFileCount: 0 });
  });

  it("leaves out what a pull brought in and keeps the turn's own edit", async () => {
    const cwd = await repo();
    const origin = await mkdtemp(join(tmpdir(), "tau-attribution-origin-"));
    const other = await mkdtemp(join(tmpdir(), "tau-attribution-other-"));
    dirs.push(origin, other);
    git(origin, "init", "-q", "--bare");
    git(cwd, "remote", "add", "origin", origin);
    git(cwd, "push", "-q", "-u", "origin", "feat");
    git(other, "clone", "-q", "-b", "feat", origin, ".");
    git(other, "config", "user.email", "other@example.test");
    git(other, "config", "user.name", "Other");
    for (let index = 0; index < 3; index += 1) await writeFile(join(other, `upstream-${index}.txt`), `${index}\n`);
    git(other, "add", "-A");
    git(other, "commit", "-qm", "upstream");
    git(other, "push", "-q", "origin", "feat");

    const { summary } = await runTurn(cwd, async () => {
      await writeFile(join(cwd, "README.md"), "readme\nagent line\n");
      git(cwd, "pull", "-q", "--ff-only");
    });
    expect(paths(summary)).toEqual(["README.md"]);
    expect(summary.headMove).toMatchObject({ kind: "pull", excludedFileCount: 3, uncertainFileCount: 0 });
  });

  it("keeps the files of a commit the agent made in the turn", async () => {
    const cwd = await repo();
    const { summary } = await runTurn(cwd, async () => {
      await writeFile(join(cwd, "feature.ts"), "export const x = 1;\n");
      git(cwd, "add", "feature.ts");
      git(cwd, "commit", "-qm", "feat: x");
      await writeFile(join(cwd, "README.md"), "readme\nmore\n");
    });
    expect(paths(summary)).toEqual(["feature.ts", "README.md"]);
    expect(summary.head?.before).not.toBe(summary.head?.after);
    expect(summary.headMove).toBeUndefined();
  });

  it("keeps an outside edit made during the turn, which Git cannot tell apart, and leaves out one made before it", async () => {
    const cwd = await repo();
    await writeFile(join(cwd, "before-turn.txt"), "dirty already\n");
    const { summary } = await runTurn(cwd, async () => {
      await writeFile(join(cwd, "editor.txt"), "typed in an editor\n");
    });
    expect(paths(summary)).toEqual(["editor.txt"]);
    expect(summary.head?.before).toBe(summary.head?.after);
    expect(summary.headMove).toBeUndefined();
  });

  it("counts a file both the switch and the turn changed as uncertain, not as the turn's", async () => {
    const cwd = await repo();
    await stageBranch(cwd, 2);
    const { summary } = await runTurn(cwd, async () => {
      await writeFile(join(cwd, "own.txt"), "own\n");
      git(cwd, "switch", "-q", "stage");
      await writeFile(join(cwd, "stage-0.txt"), "stage 0\nedited after the switch\n");
    });
    expect(paths(summary)).toEqual(["own.txt"]);
    expect(summary.headMove).toMatchObject({ kind: "checkout", excludedFileCount: 1, uncertainFileCount: 1 });
  });

  it("follows the agent's commit and the switch after it without counting the switch", async () => {
    const cwd = await repo();
    await stageBranch(cwd, 3);
    const { summary } = await runTurn(cwd, async () => {
      await writeFile(join(cwd, "committed.txt"), "agent\n");
      git(cwd, "add", "committed.txt");
      git(cwd, "commit", "-qm", "agent work");
      git(cwd, "switch", "-q", "stage");
    });
    // The committed file stays on feat; the files stage brought are not the turn's.
    expect(paths(summary)).toEqual([]);
    expect(summary.headMove).toMatchObject({ kind: "checkout", excludedFileCount: 3, uncertainFileCount: 0 });
    expect(summary.headMove?.steps.map((step) => step.commit)).toEqual([true, false]);
  });

  it("says it cannot tell without a reflog", async () => {
    const cwd = await repo();
    git(cwd, "config", "core.logAllRefUpdates", "false");
    await rm(join(cwd, ".git", "logs"), { recursive: true, force: true });
    await stageBranch(cwd, 2);
    const { summary } = await runTurn(cwd, async () => {
      await writeFile(join(cwd, "own.txt"), "own\n");
      git(cwd, "switch", "-q", "stage");
    });
    expect(paths(summary)).toEqual(["own.txt"]);
    expect(summary.headMove).toMatchObject({ kind: "unknown", uncertainFileCount: 2, steps: [] });
  });

  it("pages only the kept files, from the recorded move, and survives the session round trip", async () => {
    const cwd = await repo();
    await stageBranch(cwd, 4);
    const { summary, before, after, turnId } = await runTurn(cwd, async () => {
      await writeFile(join(cwd, "notes.md"), "agent\n");
      git(cwd, "switch", "-q", "stage");
    });
    const stored = parseStoredTurnCheckpoint({
      id: turnId,
      turnId,
      sessionId: "session",
      anchorMessageId: "answer",
      beforeSnapshotId: before.id,
      afterSnapshotId: after.id,
      startedAt: 1,
      endedAt: 2,
      ...boundedTurnCheckpointSummary(summary),
    }, "session") as StoredTurnCheckpoint;
    expect(stored.headMove).toEqual(summary.headMove);
    expect(stored.beforeSnapshotId).toBe(turnSnapshotRef("session", turnId, "before"));
    const page = await diffWorkspaceSnapshotPage(cwd, before.id, after.id, { sessionId: "session", turnId, ...pageAttribution(cwd, stored) });
    expect(page.files.map((file) => file.path)).toEqual(["notes.md"]);
    expect(page.fileCount).toBe(1);
    const again = await attributeTurnChanges(cwd, await diffWorkspaceSnapshots(cwd, before.id, after.id), recordedAttribution({ ...stored, head: stored.head!, headMove: stored.headMove! }));
    expect(again.headMove).toEqual(summary.headMove);
  });

  it("re-reads a record written before HEAD was stored from the reflog in the turn's time", async () => {
    const cwd = await repo();
    await stageBranch(cwd, 6);
    // Reflog times are whole seconds: start the turn in a second of its own.
    await new Promise((resolve) => setTimeout(resolve, 1_000 - (Date.now() % 1_000) + 20));
    const startedAt = Date.now();
    const { before, after } = await runTurn(cwd, async () => {
      await writeFile(join(cwd, "notes.md"), "agent\n");
      git(cwd, "switch", "-q", "stage");
    });
    const endedAt = Date.now();
    const reflog = await readHeadReflog(cwd);
    const legacy = legacyHeadMove(reflog!, startedAt, endedAt);
    expect(legacy?.steps?.map((step) => step.kind)).toEqual(["checkout"]);
    const summary = await attributeTurnChanges(cwd, await diffWorkspaceSnapshots(cwd, before.id, after.id), {
      beforeTree: before.id,
      afterTree: after.id,
      head: legacy!.head,
      steps: legacy!.steps,
    });
    expect(paths(summary)).toEqual(["notes.md"]);
    expect(summary.headMove?.excludedFileCount).toBe(6);
    // Outside the turn's time the reflog says nothing about it.
    expect(legacyHeadMove(reflog!, endedAt + 5_000, endedAt + 10_000)).toBeUndefined();
  });

  it("revises a stored record without HEAD, and says the branch changed once its refs are gone", async () => {
    const cwd = await repo();
    await stageBranch(cwd, 7);
    await new Promise((resolve) => setTimeout(resolve, 1_000 - (Date.now() % 1_000) + 20));
    const startedAt = Date.now();
    const { summary, before, after, turnId } = await runTurn(cwd, async () => {
      await writeFile(join(cwd, "notes.md"), "agent\n");
      git(cwd, "switch", "-q", "stage");
    });
    const endedAt = Date.now();
    const full = await diffWorkspaceSnapshots(cwd, before.id, after.id);
    // What an older Tau wrote: the whole tree diff and no HEAD.
    const legacy = parseStoredTurnCheckpoint({
      id: turnId, turnId, sessionId: "session", anchorMessageId: "answer",
      beforeSnapshotId: before.id, afterSnapshotId: after.id, startedAt, endedAt,
      ...boundedTurnCheckpointSummary(full),
    }, "session")!;
    expect(legacy.fileCount).toBe(8);
    expect(legacy.head).toBeUndefined();
    const reflog = await readHeadReflog(cwd);

    const revised = await reviseLegacyCheckpoint(cwd, legacy, reflog);
    expect(revised.fileCount).toBe(1);
    expect(revised.files.map((file) => file.path)).toEqual(["notes.md"]);
    expect(revised.headMove).toEqual(summary.headMove);
    expect(await reviseLegacyCheckpoint(cwd, { ...legacy, startedAt: endedAt + 5_000, endedAt: endedAt + 9_000 }, reflog)).toMatchObject({ fileCount: 8 });
    expect(await reviseLegacyCheckpoint(cwd, revised, reflog)).toBe(revised);

    git(cwd, "update-ref", "-d", before.id);
    const orphaned = await reviseLegacyCheckpoint(cwd, legacy, reflog);
    expect(orphaned).toMatchObject({ fileCount: 0, files: [], headMove: { kind: "unknown", uncertainFileCount: 8 } });
  });
});

describe("reflog reading", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const c = "c".repeat(40);

  it("parses entries, their times and messages", () => {
    const entries = parseReflog([
      `${"0".repeat(40)} ${a} Tau Test <tau@example.test> 1700000000 +0200\tcommit (initial): base`,
      `${a} ${b} Tau Test <tau@example.test> 1700000010 +0200\tcheckout: moving from feat to stage`,
      "garbage",
      "",
    ].join("\n"));
    expect(entries).toEqual([
      { from: "", to: a, at: 1_700_000_000_000, message: "commit (initial): base" },
      { from: a, to: b, at: 1_700_000_010_000, message: "checkout: moving from feat to stage" },
    ]);
  });

  it("tells commits from steps that rewrite files", () => {
    expect(reflogStepKind("commit: x")).toEqual({ commit: true, kind: "commit" });
    expect(reflogStepKind("commit (amend): x")).toEqual({ commit: true, kind: "commit" });
    expect(reflogStepKind("commit (merge): x")).toEqual({ commit: false, kind: "commit" });
    expect(reflogStepKind("pull: Fast-forward")).toEqual({ commit: false, kind: "pull" });
    expect(reflogStepKind("reset: moving to HEAD~1")).toEqual({ commit: false, kind: "reset" });
    expect(reflogStepKind("rebase (finish): returning to refs/heads/x")).toEqual({ commit: false, kind: "rebase" });
  });

  it("walks back from the after HEAD to the before HEAD and gives up on a gap", () => {
    const entries = parseReflog([
      `${a} ${b} T <t@t> 100 +0000\tcheckout: moving from x to y`,
      `${b} ${c} T <t@t> 101 +0000\tcommit: z`,
    ].join("\n"));
    expect(headSteps(entries, { before: a, after: c })?.map((step) => step.kind)).toEqual(["checkout", "commit"]);
    expect(headSteps(entries, { before: a, after: a })).toEqual([]);
    expect(headSteps(entries, { before: c, after: a })).toBeUndefined();
    expect(headSteps(entries, { before: "d".repeat(40), after: c })).toBeUndefined();
  });
});
