import { describe, expect, it } from "vitest";
import type { UiFileDiff, UiTurnCheckpoint } from "./contracts.js";
import {
  changesSinceTurn,
  TURN_CHECKPOINT_CUSTOM_TYPE,
  turnCheckpointsFromEntries,
} from "./turn-checkpoints.js";

const file = (path: string, added: number, removed: number) => ({
  path,
  name: path.split("/").at(-1)!,
  directory: path.split("/").slice(0, -1).join("/"),
  status: "modified" as const,
  added,
  removed,
});

const diff: UiFileDiff = {
  path: "src/app.ts",
  added: 1,
  removed: 0,
  hunks: [{ header: "@@ -1 +1 @@", lines: [{ kind: "added", newLine: 1, text: "new" }] }],
};

describe("turn checkpoints", () => {
  it("reads immutable summaries from append-only session entries", () => {
    const checkpoint: UiTurnCheckpoint = {
      id: "turn-1",
      turnId: "turn-1",
      sessionId: "session",
      anchorMessageId: "assistant-entry",
      startedAt: 10,
      endedAt: 20,
      files: [file("src/app.ts", 1, 0)],
      added: 1,
      removed: 0,
      branch: "main",
    };
    const entries = [
      { type: "custom", id: "custom-1", customType: TURN_CHECKPOINT_CUSTOM_TYPE, data: { ...checkpoint, diffs: { "src/app.ts": diff } } },
      { type: "custom", id: "custom-2", customType: "other", data: checkpoint },
    ];

    const result = turnCheckpointsFromEntries(entries, "session");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject(checkpoint);
    expect(result[0]?.diffs["src/app.ts"]).toEqual(diff);

    checkpoint.files[0]!.added = 99;
    expect(result[0]?.files[0]?.added).toBe(1);
  });

  it("rejects malformed or cross-thread entries", () => {
    expect(turnCheckpointsFromEntries([
      { type: "custom", customType: TURN_CHECKPOINT_CUSTOM_TYPE, data: { id: "bad" } },
      { type: "custom", customType: TURN_CHECKPOINT_CUSTOM_TYPE, data: { id: "other", turnId: "other", sessionId: "other", anchorMessageId: "a", startedAt: 1, endedAt: 2, files: [], added: 0, removed: 0, diffs: {} } },
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
});

