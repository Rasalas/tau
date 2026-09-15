import { describe, expect, it } from "vitest";
import { HostLifecycleCoordinator } from "./host-lifecycle-coordinator.js";

describe("HostLifecycleCoordinator", () => {
  it("owns one monotonic epoch for visible activation", () => {
    const lifecycle = new HostLifecycleCoordinator();
    const first = lifecycle.beginActivation();
    const second = lifecycle.beginActivation();

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(lifecycle.currentActivationEpoch).toBe(2);
    expect(lifecycle.isCurrentActivation(first)).toBe(false);
    expect(lifecycle.isCurrentActivation(second)).toBe(true);
  });

  it("keeps exclusive and background work on the same reentrant queue", async () => {
    const lifecycle = new HostLifecycleCoordinator({ backgroundLimit: 1 });
    const order: string[] = [];

    await lifecycle.run("open", async () => {
      order.push("open");
      await lifecycle.run("extension.exclusive", async () => { order.push("extension"); });
      expect(lifecycle.reentrant).toBe(true);
    });
    await lifecycle.runBackground("prewarm", async () => { order.push("prewarm"); });

    expect(order).toEqual(["open", "extension", "prewarm"]);
    expect(lifecycle.reentrant).toBe(false);
  });

  it("mints an activation lease before queue admission", async () => {
    const lifecycle = new HostLifecycleCoordinator();
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = lifecycle.runActivation("first", async (activation) => {
      started();
      await gate;
      return activation.isCurrent();
    });
    await startedPromise;
    expect(lifecycle.currentActivationEpoch).toBe(1);

    const second = lifecycle.runActivation("second", async (activation) => activation.epoch);
    expect(lifecycle.currentActivationEpoch).toBe(2);
    release();

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(2);
  });
});
