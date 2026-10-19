import { describe, expect, it } from "vitest";
import { assistantAnchorForBranch } from "./session-entries.js";

const assistant = (id: string, timestamp: number) => ({ type: "message", id, message: { role: "assistant", timestamp, stopReason: "stop" } });

describe("assistantAnchorForBranch", () => {
  it("finds the entry holding the message, else the newest assistant entry like it, without copying the branch", () => {
    const first = assistant("a1", 1);
    const second = assistant("a2", 2);
    const repeat = assistant("a3", 2);
    const branch = Object.freeze([{ type: "session", id: "s" }, first, { type: "message", id: "u", message: { role: "user" } }, second, repeat]);
    expect(assistantAnchorForBranch(branch, second.message)).toBe("a2");
    expect(assistantAnchorForBranch(branch, { role: "assistant", timestamp: 2, stopReason: "stop" })).toBe("a3");
    expect(assistantAnchorForBranch(branch, { role: "assistant", timestamp: 9 })).toBeUndefined();
    expect(assistantAnchorForBranch(branch, undefined)).toBeUndefined();
  });
});
