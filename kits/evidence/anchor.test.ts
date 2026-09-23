import { describe, expect, it } from "vitest";
import { settledTurn, turnAnchor } from "./anchor.js";

const messages = [
  { id: "u1", role: "user", timestamp: 1_000 },
  { id: "a1", role: "assistant", timestamp: 2_000 },
  { id: "a2", role: "assistant", timestamp: 9_000 },
  { id: "u2", role: "user", timestamp: 20_000 },
  { id: "a3", role: "assistant", timestamp: 23_000 },
];

describe("turnAnchor", () => {
  it("puts a settled turn's pictures under its last reply, not under the next prompt", () => {
    expect(turnAnchor({ startedAt: 1_200, endedAt: 10_000 }, messages)).toBe("a2");
    expect(turnAnchor({ startedAt: 20_100, endedAt: 24_000 }, messages)).toBe("a3");
  });

  it("falls back to the prompt of a turn without a reply, and waits for a turn whose page is not loaded", () => {
    expect(turnAnchor({ startedAt: 20_100, endedAt: 20_500 }, messages)).toBe("u2");
    expect(turnAnchor({ startedAt: 100_000, endedAt: 110_000 }, messages)).toBeUndefined();
  });

  it("leaves a running turn to the tail, and settles one the host lost at its last picture", () => {
    const turn = { turnId: "t", startedAt: 1_000, frames: [{ at: 5_000 }] } as never;
    expect(turnAnchor({ startedAt: 1_000 }, messages)).toBeUndefined();
    expect(settledTurn(turn, true)).toBe(turn);
    expect(settledTurn(turn, false).endedAt).toBe(5_000);
  });
});
