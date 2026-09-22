import { describe, expect, it, vi } from "vitest";
import {
  RESTART_CONTINUATION_PROMPT,
  reconcileInFlightTurns,
  restartContinuationNotice,
  restartInterruptionNotice,
  type ReconcilableThread,
  type TurnReconciliationPort,
} from "./turn-reconciliation.js";
import type { InFlightTurn } from "./turns-in-flight.js";

const marker = (overrides: Partial<InFlightTurn> = {}): InFlightTurn => ({
  sessionId: "thread-1",
  cwd: "/repo",
  turnId: "turn-1",
  backend: "pi",
  startedAt: 1_700_000_000_000,
  prompt: { text: "do the thing" },
  ...overrides,
});

function harness(options: {
  markers?: InFlightTurn[];
  continueAfterRestart?: boolean;
  thread?: Partial<ReconcilableThread> | null;
} = {}) {
  const held = [...(options.markers ?? [marker()])];
  const thread: ReconcilableThread = {
    threadId: "thread-1",
    repair: vi.fn(async () => 2),
    resume: { hiddenPrompt: true, notice: vi.fn(async () => undefined) },
    prompt: vi.fn(async () => undefined),
    ...(options.thread ?? {}),
  };
  const port: TurnReconciliationPort = {
    markers: () => held,
    forget: vi.fn((sessionId: string) => {
      const at = held.findIndex((entry) => entry.sessionId === sessionId);
      if (at >= 0) held.splice(at, 1);
    }),
    continueAfterRestart: () => options.continueAfterRestart ?? false,
    open: vi.fn(async () => options.thread === null ? undefined : thread),
    markInterrupted: vi.fn(),
    log: vi.fn(),
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
  };
  return { port, thread, held };
}

describe("reconcileInFlightTurns", () => {
  it("does nothing without markers", async () => {
    const { port } = harness({ markers: [] });
    expect(await reconcileInFlightTurns(port)).toEqual({ continued: [], interrupted: [] });
    expect(port.open).not.toHaveBeenCalled();
  });

  it("repairs, notices and marks interrupted while the setting is off", async () => {
    const { port, thread } = harness();
    const result = await reconcileInFlightTurns(port);

    expect(thread.repair).toHaveBeenCalled();
    expect(thread.resume?.notice).toHaveBeenCalledWith(restartInterruptionNotice(marker().startedAt));
    expect(thread.prompt).not.toHaveBeenCalled();
    expect(port.markInterrupted).toHaveBeenCalledWith("thread-1");
    expect(result).toEqual({ continued: [], interrupted: ["thread-1"] });
  });

  it("continues with a hidden message when the setting is on", async () => {
    const { port, thread } = harness({ continueAfterRestart: true });
    const result = await reconcileInFlightTurns(port);

    expect(thread.repair).toHaveBeenCalled();
    expect(thread.prompt).toHaveBeenCalledWith(RESTART_CONTINUATION_PROMPT, true);
    expect(thread.resume?.notice).toHaveBeenCalledWith(restartContinuationNotice(marker().startedAt));
    expect(port.markInterrupted).not.toHaveBeenCalled();
    expect(result.continued).toEqual(["thread-1"]);
  });

  it("puts a notice before a continuation a runtime cannot hide", async () => {
    const notice = vi.fn(async () => undefined);
    const { port, thread } = harness({
      continueAfterRestart: true,
      thread: { resume: { hiddenPrompt: false, notice } },
    });
    await reconcileInFlightTurns(port);

    expect(notice).toHaveBeenCalledWith(restartContinuationNotice(marker().startedAt));
    expect(thread.prompt).toHaveBeenCalledWith(RESTART_CONTINUATION_PROMPT, false);
  });

  it("only marks a runtime that cannot resume at all", async () => {
    const { port, thread } = harness({ continueAfterRestart: true, thread: { resume: undefined } });
    const result = await reconcileInFlightTurns(port);

    expect(thread.prompt).not.toHaveBeenCalled();
    expect(result).toEqual({ continued: [], interrupted: ["thread-1"] });
  });

  it("drops the marker before continuing, so a second pass continues nothing twice", async () => {
    const { port, thread, held } = harness({ continueAfterRestart: true });
    await reconcileInFlightTurns(port);
    expect(held).toEqual([]);

    const second = await reconcileInFlightTurns(port);
    expect(second).toEqual({ continued: [], interrupted: [] });
    expect(thread.prompt).toHaveBeenCalledTimes(1);
  });

  it("skips a marker whose session is gone and survives a failing one", async () => {
    const { port } = harness({ thread: null });
    expect(await reconcileInFlightTurns(port)).toEqual({ continued: [], interrupted: [] });

    const failing = harness({
      markers: [marker(), marker({ sessionId: "thread-2" })],
      thread: { repair: async () => { throw new Error("session busy"); } },
    });
    const result = await reconcileInFlightTurns(failing.port);
    expect(result).toEqual({ continued: [], interrupted: [] });
    expect(failing.held).toEqual([]);
  });
});
