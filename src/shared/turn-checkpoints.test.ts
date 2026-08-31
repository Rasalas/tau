import { describe, expect, it } from "vitest";
import type { UiTurnCheckpoint } from "./contracts.js";
import {
  completeTurnCapture,
  boundedTurnCheckpointSummary,
  changesSinceTurn,
  normalizeDiffLoadOptions,
  recordTurnAssistant,
  recordTurnOutcome,
  shouldPersistTurnCapture,
  startTurnCapture,
  TURN_CHECKPOINT_CUSTOM_TYPE,
  turnCheckpointsFromEntries,
  turnSnapshotRef,
  TurnCheckpointLifecycle,
  type TurnCaptureState,
} from "./turn-checkpoints.js";

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

  it("keeps the net change summary separate from the later live workspace", () => {
    const baseline = { files: [file("src/app.ts", 2, 1)], added: 2, removed: 1 };
    const current = { files: [file("src/app.ts", 5, 3), file("new.ts", 2, 0)], added: 7, removed: 3 };
    expect(changesSinceTurn(baseline, current)).toMatchObject({
      files: [file("src/app.ts", 3, 2), file("new.ts", 2, 0)],
      added: 5,
      removed: 2,
    });
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

  it("shares immutable before/after capture boundaries", async () => {
    const calls: string[] = [];
    const capture = startTurnCapture("turn-3", 1, async () => {
      calls.push("before");
      return { id: "before" };
    });
    capture.started = true;
    recordTurnOutcome(capture, { messages: [{ role: "assistant", stopReason: "stop" }] });
    const completed = await completeTurnCapture(capture, {
      createAfterSnapshot: async () => {
        calls.push("after");
        return { id: "after" };
      },
      summarize: async (before, after) => {
        calls.push(`${before.id}->${after.id}`);
        return { files: [], added: 0, removed: 0 };
      },
      anchorMessageId: "assistant-3",
    });
    expect(calls).toEqual(["before", "after", "before->after"]);
    expect(completed).toMatchObject({ anchorMessageId: "assistant-3", beforeSnapshot: { id: "before" }, afterSnapshot: { id: "after" } });
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
});
