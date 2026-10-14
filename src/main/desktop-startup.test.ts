import { describe, expect, it, vi } from "vitest";
import { startDesktop } from "./desktop-startup.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("desktop startup", () => {
  it("loads the cached workbench before a blocked shell or host and does not wait for an unreachable machine", async () => {
    const host = gate();
    const machine = gate();
    const showWindow = vi.fn(async () => undefined);
    const prepareHost = vi.fn(() => host.promise);
    const connectWindow = vi.fn(async () => undefined);
    const restoreMachines = vi.fn(() => machine.promise);
    const ready = startDesktop({ showWindow, prepareHost, prepareMachines: () => undefined, connectWindow, restoreMachines, onRestoreError: vi.fn() });

    expect(showWindow).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(prepareHost).toHaveBeenCalledOnce());
    expect(connectWindow).not.toHaveBeenCalled();
    host.resolve();
    await ready;
    expect(connectWindow).toHaveBeenCalledOnce();
    expect(restoreMachines).toHaveBeenCalledOnce();
    machine.resolve();
  });

  it("connects only after the first page has finished loading", async () => {
    const page = gate();
    const connectWindow = vi.fn(async () => undefined);
    const prepareHost = vi.fn(async () => undefined);
    const ready = startDesktop({ showWindow: () => page.promise, prepareHost, prepareMachines: () => undefined, connectWindow, restoreMachines: async () => undefined, onRestoreError: vi.fn() });
    expect(prepareHost).not.toHaveBeenCalled();
    expect(connectWindow).not.toHaveBeenCalled();
    page.resolve();
    await ready;
    expect(connectWindow).toHaveBeenCalledOnce();
  });

  it("installs machine socket policy before the page connects while route restoration stays deferred", async () => {
    const order: string[] = [];
    const route = gate();
    let policyInstalled = false;
    await startDesktop({
      showWindow: async () => { order.push("first paint"); },
      prepareHost: async () => { order.push("host ready"); },
      prepareMachines: () => { policyInstalled = true; order.push("socket policy"); },
      connectWindow: async () => {
        expect(policyInstalled).toBe(true);
        order.push("host page");
      },
      restoreMachines: async () => { order.push("restore routes"); await route.promise; },
      onRestoreError: vi.fn(),
    });
    expect(order).toEqual(["first paint", "host ready", "socket policy", "host page", "restore routes"]);
    route.resolve();
  });

  it("reports a failed machine restore without rejecting host readiness", async () => {
    const error = new Error("machine offline");
    const onRestoreError = vi.fn();
    await expect(startDesktop({ showWindow: async () => undefined, prepareHost: async () => undefined, prepareMachines: () => undefined, connectWindow: async () => undefined, restoreMachines: async () => { throw error; }, onRestoreError })).resolves.toBeUndefined();
    await vi.waitFor(() => expect(onRestoreError).toHaveBeenCalledWith(error));
  });
});
