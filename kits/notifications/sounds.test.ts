import { beforeEach, describe, expect, it, vi } from "vitest";

let now = 0;
let oscillators = 0;

function node() {
  const target: Record<string, unknown> = {
    connect: () => target,
    start: () => { oscillators += 1; },
    stop: () => undefined,
    gain: { value: 0, setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined },
    frequency: { value: 0 },
  };
  return target;
}

class FakeAudioContext {
  state = "running";
  destination = {};
  get currentTime() { return now; }
  resume() { return Promise.resolve(); }
  createBiquadFilter = node;
  createGain = node;
  createOscillator = node;
}

describe("playSound", () => {
  beforeEach(() => {
    now = 0;
    oscillators = 0;
    vi.resetModules();
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });

  it("plays a cue once while a burst of deliveries asks for it", async () => {
    const { playSound } = await import("./sounds.js");
    expect(playSound("chime", "done")).toBe(true);
    const first = oscillators;
    expect(first).toBeGreaterThan(0);
    now = 0.3;
    expect(playSound("chime", "done")).toBe(true);
    expect(oscillators).toBe(first);
  });

  it("plays again once the cue has rung out, and lets the other cue sound over it", async () => {
    const { playSound } = await import("./sounds.js");
    playSound("chime", "done");
    const first = oscillators;
    now = 0.3;
    playSound("chime", "attention");
    expect(oscillators).toBeGreaterThan(first);
    const second = oscillators;
    now = 5;
    playSound("chime", "done");
    expect(oscillators).toBeGreaterThan(second);
  });

  it("always plays a preview", async () => {
    const { playSound } = await import("./sounds.js");
    playSound("ping", "done");
    const first = oscillators;
    playSound("ping", "done", true);
    expect(oscillators).toBeGreaterThan(first);
  });
});
