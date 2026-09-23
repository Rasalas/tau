import { describe, expect, it, vi } from "vitest";
import { TurnSettlement } from "./turn-settlement.js";

function bench() {
  const port = {
    setTurnError: vi.fn(),
    setInterrupted: vi.fn(),
    queue: { hold: vi.fn(), started: vi.fn(), settled: vi.fn() },
    limits: { limited: vi.fn(), clear: vi.fn() },
    now: () => Date.parse("2026-09-23T12:00:00Z"),
  };
  return { port, settlement: new TurnSettlement(port) };
}

describe("TurnSettlement", () => {
  it("turns a limit failure into a limit mark and holds the queue", () => {
    const { port, settlement } = bench();
    settlement.settled("t", "You have hit your ChatGPT usage limit. Try again in ~10 min.");
    expect(port.limits.limited).toHaveBeenCalledWith("t", expect.stringContaining("usage limit"), Date.parse("2026-09-23T12:10:00Z"));
    expect(port.setTurnError).toHaveBeenCalledWith("t", undefined);
    expect(port.queue.hold).toHaveBeenCalledWith("t");
    expect(port.queue.settled).toHaveBeenCalledWith("t");
  });

  it("takes a limit the runtime named over the text", () => {
    const { port, settlement } = bench();
    settlement.settled("t", "Your workspace is out of credits.", { resetsAt: 123 });
    expect(port.limits.limited).toHaveBeenCalledWith("t", "Your workspace is out of credits.", 123);
  });

  it("keeps any other failure a turn error, and lets the queue go on", () => {
    const { port, settlement } = bench();
    settlement.settled("t", "Connection refused");
    settlement.settled("u", undefined);
    expect(port.limits.limited).not.toHaveBeenCalled();
    expect(port.setTurnError).toHaveBeenCalledWith("t", "Connection refused");
    expect(port.queue.hold).not.toHaveBeenCalled();
    expect(port.queue.settled).toHaveBeenCalledTimes(2);
  });

  it("clears every stop mark when the thread runs again", () => {
    const { port, settlement } = bench();
    settlement.started("t");
    expect(port.setInterrupted).toHaveBeenCalledWith("t", false);
    expect(port.setTurnError).toHaveBeenCalledWith("t", undefined);
    expect(port.limits.clear).toHaveBeenCalledWith("t");
    expect(port.queue.started).toHaveBeenCalledWith("t");
  });
});
