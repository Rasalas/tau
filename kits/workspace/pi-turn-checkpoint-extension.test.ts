import { describe, expect, it } from "vitest";
import { assistantAnchorForBranch } from "./pi-turn-checkpoint-extension.js";

describe("Pi turn checkpoint anchors", () => {
  it("prefers the exact persisted assistant object over a timestamp collision", () => {
    const first = { role: "assistant", timestamp: 10, stopReason: "stop" };
    const second = { role: "assistant", timestamp: 10, stopReason: "stop" };
    const branch = [
      { type: "message", id: "first-entry", message: first },
      { type: "message", id: "second-entry", message: second },
    ];

    expect(assistantAnchorForBranch(branch, second)).toBe("second-entry");
  });

  it("falls back to the latest matching assistant for adapted event payloads", () => {
    const branch = [{
      type: "message",
      id: "assistant-entry",
      message: { role: "assistant", timestamp: 10, stopReason: "stop" },
    }];

    expect(assistantAnchorForBranch(branch, { role: "assistant", timestamp: 10, stopReason: "stop" }))
      .toBe("assistant-entry");
  });
});
