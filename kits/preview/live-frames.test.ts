import { describe, expect, it } from "vitest";
import { FRAME_TIERS, INTERVAL_MS, frameWidth, pace } from "./live-frames.js";

describe("frames paced to the client", () => {
  it("asks for what the view draws in device pixels, at most twice its CSS width", () => {
    expect(frameWidth(390, 3, 0)).toBe(780);
    expect(frameWidth(390, 1, 0)).toBe(390);
    expect(frameWidth(390, 2, 2)).toBe(390);
    expect(frameWidth(2_000, 2, 0)).toBe(1_600);
    expect(frameWidth(40, 1, FRAME_TIERS.length + 3)).toBe(120);
  });

  it("steps down after a slow picture and waits at least as long again", () => {
    const slow = pace({ tier: 0, fastFrames: 0 }, { elapsedMs: 2_000, picture: true, interacting: true });
    expect(slow.state.tier).toBe(1);
    expect(slow.delayMs).toBe(2_000);
    const floor = pace({ tier: FRAME_TIERS.length - 1, fastFrames: 0 }, { elapsedMs: 5_000, picture: true, interacting: false });
    expect(floor.state.tier).toBe(FRAME_TIERS.length - 1);
  });

  it("steps back up after three quick pictures", () => {
    let state = { tier: 2, fastFrames: 0 };
    for (let frame = 0; frame < 3; frame += 1) state = pace(state, { elapsedMs: 100, picture: true, interacting: false }).state;
    expect(state.tier).toBe(1);
  });

  it("comes quicker while the user acts on the page, and an unchanged answer costs no wait", () => {
    expect(pace({ tier: 0, fastFrames: 0 }, { elapsedMs: 50, picture: true, interacting: true }).delayMs).toBe(INTERVAL_MS.interacting);
    expect(pace({ tier: 0, fastFrames: 0 }, { elapsedMs: 50, picture: true, interacting: false }).delayMs).toBe(INTERVAL_MS.watching);
    expect(pace({ tier: 1, fastFrames: 2 }, { elapsedMs: 1_500, picture: false, interacting: true })).toEqual({ state: { tier: 1, fastFrames: 2 }, delayMs: INTERVAL_MS.interacting });
  });
});
