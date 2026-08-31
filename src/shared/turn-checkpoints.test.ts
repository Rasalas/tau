import { describe, expect, it } from "vitest";
import type { UiTurnCheckpoint } from "./contracts.js";
import {
  completeTurnCapture,
  changesSinceTurn,
  normalizeDiffLoadOptions,
  recordTurnAssistant,
  recordTurnOutcome,
  shouldPersistTurnCapture,
  startTurnCapture,
  TURN_CHECKPOINT_CUSTOM_TYPE,
  turnCheckpointsFromEntries,
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
});
