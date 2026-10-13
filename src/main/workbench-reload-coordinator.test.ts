import { describe, expect, it } from "vitest";
import { HostLifecycleCoordinator } from "./host-lifecycle-coordinator.js";
import { WorkbenchReloadCoordinator } from "./workbench-reload-coordinator.js";

describe("reload abort admission", () => {
  it("releases the lifecycle lane while draining and shares the drain with concurrent requests", async () => {
    let finish!: () => void;
    let running = true;
    const drain = new Promise<void>((resolve) => { finish = () => { running = false; resolve(); }; });
    const lifecycle = new HostLifecycleCoordinator();
    const reload = new WorkbenchReloadCoordinator({
      runs: () => running ? [{ abort: () => drain, waitForIdle: () => drain }] : [],
      serialize: (operation) => lifecycle.run("reload", operation),
    });
    let firstReady = false;
    const first = reload.prepare("abort").then(() => { firstReady = true; });
    await lifecycle.run("other-operation", async () => undefined);
    expect(firstReady).toBe(false);
    await expect(reload.prepare("inspect")).resolves.toEqual({ ready: false, runningThreads: 1 });
    let secondReady = false;
    const second = reload.prepare("abort").then(() => { secondReady = true; });
    await lifecycle.run("other-operation", async () => undefined);
    expect(secondReady).toBe(false);
    reload.release();
    expect(() => reload.assertAvailable()).not.toThrow();
    finish();
    await Promise.all([first, second]);
    expect(firstReady && secondReady).toBe(true);
  });
});
