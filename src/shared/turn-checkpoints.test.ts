import { describe, expect, it } from "vitest";
import type { UiTurnCheckpoint } from "./turn-checkpoint-types.js";
import {
  boundedTurnCheckpointSummary,
  createTurnCheckpointBatch,
  TURN_CHECKPOINT_CUSTOM_TYPE,
  TURN_CHECKPOINT_BATCH_CUSTOM_TYPE,
  TURN_RESTORE_BACKUP_CUSTOM_TYPE,
  TURN_RESTORE_TRANSACTION_CUSTOM_TYPE,
  turnRestoreTransactionsFromEntries,
  turnCheckpointsFromEntries,
  turnRestoreBackupsFromEntries,
  turnSnapshotRef,
} from "./turn-checkpoint-codec.js";
import {
  recordTurnAssistant,
  recordTurnOutcome,
  shouldPersistTurnCapture,
  startTurnCapture,
  TurnCheckpointLifecycle,
  type TurnCaptureState,
} from "./turn-checkpoint-lifecycle.js";
import { normalizeDiffLoadOptions } from "./turn-checkpoint-diff.js";

const file = (path: string, added: number, removed: number) => ({
  path,
  name: path.split("/").at(-1)!,
  directory: path.split("/").slice(0, -1).join("/"),
  status: "modified" as const,
  added,
  removed,
});

describe("turn checkpoints", () => {
  it("reads immutable summaries from append-only session entries", () => {
    const checkpoint: UiTurnCheckpoint = {
      id: "turn-1",
      turnId: "turn-1",
      sessionId: "session",
      anchorMessageId: "assistant-entry",
      beforeSnapshotId: "refs/tau/checkpoints/session/turn-1/before",
      afterSnapshotId: "refs/tau/checkpoints/session/turn-1/after",
      startedAt: 10,
      endedAt: 20,
      files: [file("src/app.ts", 1, 0)],
      added: 1,
      removed: 0,
      branch: "main",
    };
    const entries = [
      { type: "custom", id: "custom-1", customType: TURN_CHECKPOINT_CUSTOM_TYPE, data: checkpoint },
      { type: "custom", id: "custom-2", customType: "other", data: checkpoint },
    ];

    const result = turnCheckpointsFromEntries(entries, "session");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject(checkpoint);
    expect("diffs" in (result[0] ?? {})).toBe(false);

    checkpoint.files[0]!.added = 99;
    expect(result[0]?.files[0]?.added).toBe(1);
  });

  it("rejects malformed or cross-thread entries", () => {
    expect(turnCheckpointsFromEntries([
      { type: "custom", customType: TURN_CHECKPOINT_CUSTOM_TYPE, data: { id: "bad" } },
      { type: "custom", customType: TURN_CHECKPOINT_CUSTOM_TYPE, data: { id: "other", turnId: "other", sessionId: "other", anchorMessageId: "a", beforeSnapshotId: "before", afterSnapshotId: "after", startedAt: 1, endedAt: 2, files: [], added: 0, removed: 0 } },
    ], "session")).toEqual([]);
  });

  it("rejects swapped and foreign snapshot refs even when their shapes are valid", () => {
    const base = {
      id: "turn-refs",
      turnId: "turn-refs",
      sessionId: "session",
      anchorMessageId: "assistant",
      startedAt: 1,
      endedAt: 2,
      files: [],
      added: 0,
      removed: 0,
    };
    const swapped = {
      ...base,
      beforeSnapshotId: turnSnapshotRef("session", "turn-refs", "after"),
      afterSnapshotId: turnSnapshotRef("session", "turn-refs", "before"),
    };
    const foreign = {
      ...base,
      beforeSnapshotId: turnSnapshotRef("other-session", "turn-refs", "before"),
      afterSnapshotId: turnSnapshotRef("other-session", "turn-refs", "after"),
    };
    expect(turnCheckpointsFromEntries([
      { type: "custom", customType: TURN_CHECKPOINT_CUSTOM_TYPE, data: swapped },
      { type: "custom", customType: TURN_CHECKPOINT_CUSTOM_TYPE, data: foreign },
    ], "session")).toEqual([]);
  });

  it("keeps only session-bound restore backup markers", () => {
    const backup = {
      version: 1,
      backupId: "backup-1",
      sessionId: "backup-session",
      turnId: "restore-backup-1",
      sourceSessionId: "source-session",
      sourceCheckpointId: "turn-1",
      cwd: "/workspace",
      beforeSnapshotId: turnSnapshotRef("backup-session", "restore-backup-1", "before"),
      afterSnapshotId: turnSnapshotRef("backup-session", "restore-backup-1", "after"),
      createdAt: 10,
    };
    expect(turnRestoreBackupsFromEntries([
      { type: "custom", customType: TURN_RESTORE_BACKUP_CUSTOM_TYPE, data: backup },
      { type: "custom", customType: TURN_RESTORE_BACKUP_CUSTOM_TYPE, data: { ...backup, backupId: "foreign", sessionId: "other" } },
      { type: "custom", customType: TURN_RESTORE_BACKUP_CUSTOM_TYPE, data: { ...backup, backupId: "swapped", afterSnapshotId: backup.beforeSnapshotId } },
    ], "backup-session")).toEqual([backup]);
  });

  it("keeps the latest valid restore journal state and rejects foreign refs", () => {
    const transaction = {
      version: 1,
      transactionId: "restore-1",
      state: "prepared" as const,
      sessionId: "backup-session",
      backupSessionId: "backup-session",
      backupTurnId: "restore-backup-1",
      sourceSessionId: "source-session",
      sourceTurnId: "turn-1",
      sourceCheckpointId: "turn-1",
      targetSessionId: "target-session",
      cwd: "/workspace",
      targetAfterSnapshotId: turnSnapshotRef("source-session", "turn-1", "after"),
      backupAfterSnapshotId: turnSnapshotRef("backup-session", "restore-backup-1", "after"),
      createdAt: 10,
    };
    expect(turnRestoreTransactionsFromEntries([
      { type: "custom", customType: TURN_RESTORE_TRANSACTION_CUSTOM_TYPE, data: transaction },
      { type: "custom", customType: TURN_RESTORE_TRANSACTION_CUSTOM_TYPE, data: { ...transaction, state: "committed" } },
      { type: "custom", customType: TURN_RESTORE_TRANSACTION_CUSTOM_TYPE, data: { ...transaction, targetAfterSnapshotId: turnSnapshotRef("foreign", "turn-1", "after") } },
    ], "backup-session")).toMatchObject([{ ...transaction, state: "committed" }]);

    const backupOpen = {
      ...transaction,
      kind: "backup-open" as const,
      targetSessionId: "backup-session",
      sourceSessionId: "backup-session",
      sourceTurnId: "restore-backup-1",
      targetAfterSnapshotId: turnSnapshotRef("backup-session", "restore-backup-1", "after"),
    };
    expect(turnRestoreTransactionsFromEntries([
      { type: "custom", customType: TURN_RESTORE_TRANSACTION_CUSTOM_TYPE, data: backupOpen },
    ], "backup-session")).toMatchObject([backupOpen]);
  });

  it("exposes fork records only after every record precedes its commit marker", () => {
    const checkpoint = {
      id: "turn",
      turnId: "turn",
      sessionId: "fork",
      anchorMessageId: "assistant",
      beforeSnapshotId: turnSnapshotRef("fork", "turn", "before"),
      afterSnapshotId: turnSnapshotRef("fork", "turn", "after"),
      startedAt: 1,
      endedAt: 2,
      files: [],
      added: 0,
      removed: 0,
      transactionId: "tx",
    };
    const marker = createTurnCheckpointBatch("tx", "fork", ["turn"]);
    expect(turnCheckpointsFromEntries([
      { type: "custom", customType: TURN_CHECKPOINT_BATCH_CUSTOM_TYPE, data: marker },
      { type: "custom", customType: TURN_CHECKPOINT_CUSTOM_TYPE, data: checkpoint },
    ], "fork")).toEqual([]);
    expect(turnCheckpointsFromEntries([
      { type: "custom", customType: TURN_CHECKPOINT_CUSTOM_TYPE, data: checkpoint },
      { type: "custom", customType: TURN_CHECKPOINT_BATCH_CUSTOM_TYPE, data: marker },
    ], "fork")).toMatchObject([checkpoint]);
  });

  it("shares retry, abort, and lazy paging semantics without retaining patch bytes", () => {
    const capture: TurnCaptureState = {
      id: "turn-1",
      startedAt: 1,
      beforeSnapshot: Promise.resolve(undefined),
      started: true,
    };
    recordTurnOutcome(capture, {
      messages: [{ role: "assistant", stopReason: "error", timestamp: 2 }],
      willRetry: true,
    });
    expect(capture.outcome).toBeUndefined();
    recordTurnOutcome(capture, { messages: [{ role: "assistant", stopReason: "stop", timestamp: 3 }] });
    expect(shouldPersistTurnCapture(capture)).toBe(true);
    recordTurnAssistant(capture, { role: "assistant", timestamp: 4 });
    expect(capture.lastAssistant?.timestamp).toBe(4);

    recordTurnOutcome(capture, { messages: [{ role: "assistant", stopReason: "aborted" }] });
    expect(shouldPersistTurnCapture(capture)).toBe(false);
    expect(normalizeDiffLoadOptions({ hunkOffset: -4, hunkLimit: 999 }, 120)).toEqual({ hunkOffset: 0, hunkLimit: 120 });

    const parsed = turnCheckpointsFromEntries([{
      type: "custom",
      customType: TURN_CHECKPOINT_CUSTOM_TYPE,
      data: {
        ...{
          id: "turn-2",
          turnId: "turn-2",
          sessionId: "session",
          anchorMessageId: "assistant",
          beforeSnapshotId: "refs/tau/checkpoints/session/turn-2/before",
          afterSnapshotId: "refs/tau/checkpoints/session/turn-2/after",
          startedAt: 1,
          endedAt: 2,
          files: [],
          added: 0,
          removed: 0,
        },
        // Legacy/bad data must not cross the transport as a file-diff payload.
        diffs: { "secret.txt": { path: "secret.txt", hunks: [{ lines: [{ text: "bytes" }] }] } },
      },
    }], "session");
    expect(parsed[0]).not.toHaveProperty("diffs");
  });

  it("keeps queued user turns separate and freezes the previous after boundary first", async () => {
    const calls: string[] = [];
    const persisted: Array<{ id: string; before: string; after: string }> = [];
    const lifecycle = new TurnCheckpointLifecycle<{ id: string }>({
      createBefore: async (id) => { calls.push(`before:${id}`); return { id: `before:${id}` }; },
      createAfter: async (id) => { calls.push(`after:${id}`); return { id: `after:${id}` }; },
      summarize: async (before, after, id) => {
        calls.push(`summary:${id}:${before.id}->${after.id}`);
        return { files: [], added: 0, removed: 0 };
      },
      discardSnapshot: async (snapshot) => { calls.push(`discard:${snapshot.id}`); },
      persist: async (result, capture) => {
        persisted.push({ id: capture.id, before: result.beforeSnapshot.id, after: result.afterSnapshot.id });
      },
    });

    lifecycle.acceptUserTurn("turn-a");
    await lifecycle.acceptInput("turn-a");
    await lifecycle.beginTurn();
    await lifecycle.endTurn({ role: "assistant", stopReason: "stop", timestamp: 1 }, "assistant-a");
    expect(calls).toEqual(["before:turn-a", "after:turn-a"]);

    lifecycle.acceptUserTurn("turn-b", { deferBefore: true });
    await lifecycle.acceptInput("turn-b", { deferBefore: true });
    await lifecycle.beginTurn();
    expect(calls.slice(0, 4)).toEqual([
      "before:turn-a",
      "after:turn-a",
      "summary:turn-a:before:turn-a->after:turn-a",
      "before:turn-b",
    ]);
    await lifecycle.endTurn({ role: "assistant", stopReason: "stop", timestamp: 2 }, "assistant-b");
    await lifecycle.close();

    expect(persisted).toEqual([
      { id: "turn-a", before: "before:turn-a", after: "after:turn-a" },
      { id: "turn-b", before: "before:turn-b", after: "after:turn-b" },
    ]);
    expect(calls.filter((call) => call.startsWith("after:")).sort()).toEqual(["after:turn-a", "after:turn-b"]);
  });

  it("assigns two queued client turns to separate assistant boundaries", async () => {
    const persisted: string[] = [];
    const lifecycle = new TurnCheckpointLifecycle<{ id: string }>({
      createBefore: async (id) => ({ id: `before:${id}` }),
      createAfter: async (id) => ({ id: `after:${id}` }),
      summarize: async () => ({ files: [], added: 0, removed: 0 }),
      discardSnapshot: () => undefined,
      persist: async (_result, capture) => { persisted.push(capture.id); },
    });

    lifecycle.acceptUserTurn("first");
    await lifecycle.beginTurn();
    lifecycle.acceptUserTurn("second", { deferBefore: true });
    lifecycle.acceptUserTurn("third", { deferBefore: true });
    await lifecycle.acceptInput("second", { deferBefore: true });
    await lifecycle.acceptInput("third", { deferBefore: true });

    await lifecycle.endTurn({ role: "assistant", stopReason: "stop" }, "assistant-first");
    await lifecycle.beginTurn();
    await lifecycle.endTurn({ role: "assistant", stopReason: "stop" }, "assistant-second");
    await lifecycle.beginTurn();
    await lifecycle.endTurn({ role: "assistant", stopReason: "stop" }, "assistant-third");
    await lifecycle.close();

    expect(persisted).toEqual(["first", "second", "third"]);
  });

  it("delivers direct follow-ups without an input event to separate captures", async () => {
    const persisted: string[] = [];
    const lifecycle = new TurnCheckpointLifecycle<{ id: string }>({
      createBefore: async (id) => ({ id: `before:${id}` }),
      createAfter: async (id) => ({ id: `after:${id}` }),
      summarize: async () => ({ files: [], added: 0, removed: 0 }),
      discardSnapshot: () => undefined,
      persist: async (_result, capture) => { persisted.push(capture.id); },
    });

    lifecycle.acceptUserTurn("first");
    await lifecycle.beginTurn();
    lifecycle.acceptUserTurn("second", { deferBefore: true, expectsInput: false });
    lifecycle.acceptUserTurn("third", { deferBefore: true, expectsInput: false });
    await lifecycle.endTurn({ role: "assistant", stopReason: "stop" }, "assistant-first");
    await lifecycle.beginTurn();
    await lifecycle.userMessage();
    await lifecycle.endTurn({ role: "assistant", stopReason: "stop" }, "assistant-second");
    await lifecycle.beginTurn();
    await lifecycle.userMessage();
    await lifecycle.endTurn({ role: "assistant", stopReason: "stop" }, "assistant-third");
    await lifecycle.close();

    expect(persisted).toEqual(["first", "second", "third"]);
  });

  it("does not promote an unfinished tool-use capture when a follow-up arrives", async () => {
    const persisted: string[] = [];
    const discarded: string[] = [];
    const lifecycle = new TurnCheckpointLifecycle<{ id: string }>({
      createBefore: async (id) => ({ id: `before:${id}` }),
      createAfter: async (id) => ({ id: `after:${id}` }),
      summarize: async () => ({ files: [], added: 0, removed: 0 }),
      discardSnapshot: (snapshot) => { discarded.push(snapshot.id); },
      persist: async (_result, capture) => { persisted.push(capture.id); },
    });

    lifecycle.acceptUserTurn("first");
    await lifecycle.beginTurn();
    await lifecycle.endTurn({ role: "assistant", stopReason: "toolUse" }, "assistant-tool");
    lifecycle.acceptUserTurn("follow-up", { deferBefore: true, expectsInput: false });
    await lifecycle.beginTurn();
    await lifecycle.userMessage();
    await lifecycle.endTurn({ role: "assistant", stopReason: "stop" }, "assistant-follow-up");
    await lifecycle.close();

    expect(persisted).toEqual(["follow-up"]);
    expect(discarded).toContain("before:first");
  });

  it("does not create a deferred snapshot for a rejected queued prompt", async () => {
    let beforeCalls = 0;
    const lifecycle = new TurnCheckpointLifecycle<{ id: string }>({
      createBefore: async () => { beforeCalls += 1; return { id: "before" }; },
      createAfter: async () => ({ id: "after" }),
      summarize: async () => ({ files: [], added: 0, removed: 0 }),
      discardSnapshot: () => undefined,
      persist: async () => undefined,
    });
    lifecycle.acceptUserTurn("rejected", { deferBefore: true });
    await lifecycle.reject("rejected");
    expect(beforeCalls).toBe(0);
    expect(lifecycle.pendingCount).toBe(0);
  });

  it("cleans snapshots for aborted turns and never persists their assistant anchor", async () => {
    const discarded: string[] = [];
    let persisted = 0;
    const lifecycle = new TurnCheckpointLifecycle<{ id: string }>({
      createBefore: async () => ({ id: "before" }),
      createAfter: async () => ({ id: "after" }),
      summarize: async () => ({ files: [], added: 0, removed: 0 }),
      discardSnapshot: (snapshot) => { discarded.push(snapshot.id); },
      persist: async () => { persisted += 1; },
    });
    lifecycle.acceptUserTurn("aborted");
    await lifecycle.beginTurn();
    await lifecycle.endTurn({ role: "assistant", stopReason: "aborted" }, "assistant-aborted");
    await lifecycle.close();
    expect(persisted).toBe(0);
    expect(discarded).toEqual(["before"]);
  });

  it("bounds the persistence seam while retaining the complete file count", () => {
    const changes = {
      files: Array.from({ length: 12 }, (_, index) => file(`file-${index}.ts`, index + 1, 0)),
      fileCount: 12,
      added: 78,
      removed: 0,
    };
    const summary = boundedTurnCheckpointSummary(changes);
    expect(summary.files).toHaveLength(8);
    expect(summary.fileCount).toBe(12);
    expect(summary.files.map((entry) => entry.path)).toEqual(changes.files.slice(0, 8).map((entry) => entry.path));
  });

  it("persists partial coverage even when no changed file was fully captured", () => {
    const summary = boundedTurnCheckpointSummary({
      files: [],
      fileCount: 0,
      added: 0,
      removed: 0,
      completeness: "partial",
      incompleteReason: "Snapshot coverage is partial: file-count limit.",
      omittedFileCount: 3,
    });
    expect(summary).toMatchObject({
      completeness: "partial",
      omittedFileCount: 3,
      incompleteReason: "Snapshot coverage is partial: file-count limit.",
    });
  });

  it("passes only the bounded summary to the persistence adapter", async () => {
    let persisted: UiTurnCheckpoint | undefined;
    const lifecycle = new TurnCheckpointLifecycle<{ id: string }>({
      createBefore: async () => ({ id: "before" }),
      createAfter: async () => ({ id: "after" }),
      summarize: async () => ({
        files: Array.from({ length: 20 }, (_, index) => file(`path-${index}`, 1, 0)),
        added: 20,
        removed: 0,
      }),
      discardSnapshot: () => undefined,
      persist: async (result) => {
        persisted = {
          id: "turn",
          turnId: "turn",
          sessionId: "session",
          anchorMessageId: result.anchorMessageId,
          beforeSnapshotId: "before",
          afterSnapshotId: "after",
          startedAt: 1,
          endedAt: result.endedAt,
          ...result.changes,
        };
      },
    });
    lifecycle.acceptUserTurn("turn", { startedAt: 1 });
    await lifecycle.beginTurn();
    await lifecycle.endTurn({ role: "assistant", stopReason: "stop" }, "assistant");
    await lifecycle.close();
    expect(persisted?.files).toHaveLength(8);
    expect(persisted?.fileCount).toBe(20);
  });

  it("always attempts both ref deletions when summary persistence fails", async () => {
    const discarded: string[] = [];
    const errors: unknown[] = [];
    const lifecycle = new TurnCheckpointLifecycle<{ id: string }>({
      createBefore: async () => ({ id: "before" }),
      createAfter: async () => ({ id: "after" }),
      summarize: async () => { throw new Error("summary failed"); },
      discardSnapshot: (snapshot) => {
        discarded.push(snapshot.id);
        if (snapshot.id === "after") throw new Error("after deletion failed");
      },
      persist: async () => undefined,
      onError: (error) => errors.push(error),
    });
    lifecycle.acceptUserTurn("failed");
    await lifecycle.beginTurn();
    await lifecycle.endTurn({ role: "assistant", stopReason: "stop" }, "assistant-failed");
    await lifecycle.close();
    expect(discarded.sort()).toEqual(["after", "before"]);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(lifecycle.pendingCount).toBe(0);
  });

  it("holds the workspace lease until the bounded checkpoint entry is durable", async () => {
    let persistStarted = false;
    let resolvePersist!: () => void;
    const persisted = new Promise<void>((resolve) => { resolvePersist = resolve; });
    const released: string[] = [];
    const lifecycle = new TurnCheckpointLifecycle<{ id: string }>({
      createBefore: async () => ({ id: "before" }),
      createAfter: async () => ({ id: "after" }),
      summarize: async () => ({ files: [], added: 0, removed: 0 }),
      discardSnapshot: () => undefined,
      acquireLease: async () => ({ release: () => { released.push("lease"); } }),
      persist: async (_result, capture) => {
        persistStarted = true;
        await persisted;
        released.push(`persist:${capture.id}`);
      },
      onReleased: (capture) => { released.push(`context:${capture.id}`); },
    });

    lifecycle.acceptUserTurn("turn", { startedAt: 1 });
    await lifecycle.beginTurn();
    await lifecycle.endTurn({ role: "assistant", stopReason: "stop" }, "assistant");
    const settling = lifecycle.close();
    while (!persistStarted) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toEqual([]);
    resolvePersist();
    await settling;
    expect(released).toEqual(["persist:turn", "lease", "context:turn"]);
    expect(lifecycle.pendingCount).toBe(0);
  });

  it("runs the turn without a checkpoint when the workspace lease stays busy past the timeout", async () => {
    const statuses: string[] = [];
    const calls: string[] = [];
    const errors: unknown[] = [];
    let ticketAborted = false;
    const lifecycle = new TurnCheckpointLifecycle<{ id: string }>({
      createBefore: async () => { calls.push("before"); return { id: "before" }; },
      createAfter: async () => { calls.push("after"); return { id: "after" }; },
      summarize: async () => ({ files: [], added: 0, removed: 0 }),
      discardSnapshot: (snapshot) => { calls.push(`discard:${snapshot.id}`); },
      discardTurnSnapshot: (_turnId, phase) => { calls.push(`discard-phase:${phase}`); },
      acquireLease: (_turnId, signal) => new Promise((_resolve, reject) => {
        const abort = () => { ticketAborted = true; reject(new Error("aborted")); };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }),
      persist: async () => { calls.push("persist"); },
      onError: (error) => errors.push(error),
      onStatus: (status) => statuses.push(status),
    }, { leaseTimeoutMs: 10 });

    lifecycle.acceptUserTurn("turn");
    await lifecycle.prepare("turn");
    expect(ticketAborted).toBe(true);
    expect(statuses).toEqual(["queued", "waiting", "skipped"]);
    expect(lifecycle.get("turn")?.skipped).toBe(true);

    await lifecycle.beginTurn();
    await lifecycle.endTurn({ role: "assistant", stopReason: "stop" }, "assistant");
    await lifecycle.close();
    expect(calls).toEqual([]);
    expect(errors).toEqual([]);
    expect(statuses).toEqual(["queued", "waiting", "skipped"]);
    expect(lifecycle.pendingCount).toBe(0);
  });

  it("keeps the checkpoint when the lease arrives inside the timeout", async () => {
    const released: string[] = [];
    const statuses: string[] = [];
    const lifecycle = new TurnCheckpointLifecycle<{ id: string }>({
      createBefore: async () => ({ id: "before" }),
      createAfter: async () => ({ id: "after" }),
      summarize: async () => ({ files: [], added: 0, removed: 0 }),
      discardSnapshot: () => undefined,
      acquireLease: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { release: () => { released.push("lease"); } };
      },
      persist: async () => { released.push("persist"); },
      onStatus: (status) => statuses.push(status),
    }, { leaseTimeoutMs: 1_000 });

    lifecycle.acceptUserTurn("turn");
    await lifecycle.beginTurn();
    await lifecycle.endTurn({ role: "assistant", stopReason: "stop" }, "assistant");
    await lifecycle.close();
    expect(released).toEqual(["persist", "lease"]);
    expect(statuses).toEqual(["queued", "waiting", "capturing", "persisting", "ready"]);
    expect(lifecycle.get("turn")).toBeUndefined();
  });

  it("reports a client abort during the lease wait as failed, not skipped", async () => {
    const statuses: string[] = [];
    const lifecycle = new TurnCheckpointLifecycle<{ id: string }>({
      createBefore: async () => ({ id: "before" }),
      createAfter: async () => ({ id: "after" }),
      summarize: async () => ({ files: [], added: 0, removed: 0 }),
      discardSnapshot: () => undefined,
      // Like the real lease manager, a waiter checks the signal before it polls.
      acquireLease: (_turnId, signal) => new Promise((_resolve, reject) => {
        const abort = () => reject(new Error("aborted"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }),
      persist: async () => undefined,
      onStatus: (status) => statuses.push(status),
    }, { leaseTimeoutMs: 1_000 });

    lifecycle.acceptUserTurn("turn");
    const preparing = lifecycle.prepare("turn");
    await lifecycle.reject("turn");
    await preparing;
    expect(statuses).not.toContain("skipped");
    expect(statuses).toContain("failed");
    expect(lifecycle.pendingCount).toBe(0);
  });

  it("serializes concurrent settle calls for one thread", async () => {
    let persistCalls = 0;
    let resolvePersist!: () => void;
    const persisted = new Promise<void>((resolve) => { resolvePersist = resolve; });
    const lifecycle = new TurnCheckpointLifecycle<{ id: string }>({
      createBefore: async () => ({ id: "before" }),
      createAfter: async () => ({ id: "after" }),
      summarize: async () => ({ files: [], added: 0, removed: 0 }),
      discardSnapshot: () => undefined,
      persist: async () => { persistCalls += 1; await persisted; },
    });
    lifecycle.acceptUserTurn("turn");
    await lifecycle.beginTurn();
    await lifecycle.endTurn({ role: "assistant", stopReason: "stop" }, "assistant");
    const first = lifecycle.settle();
    const second = lifecycle.settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(persistCalls).toBe(1);
    resolvePersist();
    await Promise.all([first, second]);
    expect(lifecycle.pendingCount).toBe(0);
  });

  it("detaches a settled capture so a new client turn can prepare without losing it", async () => {
    let persistCalls = 0;
    let releaseFirst!: () => void;
    const firstPersist = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const persisted: string[] = [];
    const lifecycle = new TurnCheckpointLifecycle<{ id: string }>({
      createBefore: async (id) => ({ id: `before:${id}` }),
      createAfter: async (id) => ({ id: `after:${id}` }),
      summarize: async () => ({ files: [], added: 0, removed: 0 }),
      discardSnapshot: () => undefined,
      persist: async (_result, capture) => {
        persistCalls += 1;
        persisted.push(capture.id);
        if (capture.id === "first") await firstPersist;
      },
    });
    lifecycle.acceptUserTurn("first");
    await lifecycle.acceptInput("first");
    await lifecycle.beginTurn();
    await lifecycle.endTurn({ role: "assistant", stopReason: "stop" }, "assistant-first");
    const settling = lifecycle.settle();
    while (persistCalls === 0) await new Promise((resolve) => setTimeout(resolve, 0));

    lifecycle.acceptUserTurn("second", { deferBefore: true });
    await lifecycle.acceptInput("second");
    await lifecycle.beginTurn();
    await lifecycle.endTurn({ role: "assistant", stopReason: "stop" }, "assistant-second");
    releaseFirst();
    await settling;
    await lifecycle.close();

    expect(persisted).toEqual(["first", "second"]);
    expect(lifecycle.pendingCount).toBe(0);
  });

  it("resolves a deferred anchor after the terminal message has been persisted", async () => {
    let persistedEntry = false;
    let persistedAnchor: string | undefined;
    const lifecycle = new TurnCheckpointLifecycle<{ id: string }>({
      createBefore: async () => ({ id: "before" }),
      createAfter: async () => ({ id: "after" }),
      summarize: async () => ({ files: [], added: 0, removed: 0 }),
      discardSnapshot: () => undefined,
      persist: async (result) => { persistedAnchor = result.anchorMessageId; },
    });
    lifecycle.acceptUserTurn("turn");
    await lifecycle.acceptInput("turn");
    await lifecycle.beginTurn();
    await lifecycle.endTurn({ role: "assistant", stopReason: "stop" }, undefined, () => persistedEntry ? "assistant-entry" : undefined);
    persistedEntry = true;
    await lifecycle.settle();
    expect(persistedAnchor).toBe("assistant-entry");
    expect(lifecycle.pendingCount).toBe(0);
  });
});
