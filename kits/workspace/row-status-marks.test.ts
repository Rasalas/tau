import { describe, expect, it } from "vitest";
import { attentionMarks, markedRowStatus } from "./row-status-marks.js";

const yourTurn = { label: "Your turn", icon: null };
const watching = { label: "Waiting", hint: "Watching #76", icon: null, tone: "background" as const };

describe("markedRowStatus", () => {
  it("draws a kit's mark as a question", () => {
    expect(markedRowStatus({ activity: "working", label: "Working" }, yourTurn)).toMatchObject({ activity: "waiting", label: "Your turn" });
  });

  it("puts background work in place of an idle or a ready row", () => {
    expect(markedRowStatus({ activity: "idle", label: "Idle" }, watching)).toMatchObject({ activity: "background", label: "Waiting", hint: "Watching #76" });
    expect(markedRowStatus({ activity: "ready", label: "Ready" }, watching)).toMatchObject({ activity: "background" });
  });

  it("lets a running, asking or failed thread say so over background work", () => {
    for (const activity of ["working", "waiting", "failed"] as const) {
      expect(markedRowStatus({ activity, label: "x" }, watching).activity).toBe(activity);
    }
  });
});

describe("attentionMarks", () => {
  it("counts only marks that ask for the user", () => {
    expect(attentionMarks({ a: yourTurn, b: watching })).toEqual(["a"]);
  });
});
