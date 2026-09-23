import { describe, expect, it, vi } from "vitest";
import { HostJobRunner } from "./host-jobs.js";
import { createHostMethods, invokeHostMethod } from "./host-methods.js";
import { HostStart } from "./host-start.js";
import type { PiHost } from "./pi-host.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

/** A headless host process's method table over a host whose start the test releases. */
function startingHost() {
  const start = deferred();
  const order: string[] = [];
  const fake = {
    start: vi.fn(async () => { await start.promise; order.push("started"); }),
    bootstrap: vi.fn(async () => { order.push("bootstrap"); return { version: 2 }; }),
    resolveWorkspacePath: (value: string) => value.replace("ws:", "/repo/"),
    setThinkingLevel: vi.fn(async (level: string) => { order.push(`thinking ${level}`); return { updates: [] }; }),
  };
  const create = vi.fn(() => fake as unknown as PiHost);
  const started = new HostStart(create);
  const unsupported = () => { throw new Error("not in this test"); };
  const loadDesktopExtensions = vi.fn(async (cwd: string) => { order.push(`desktop-extensions ${cwd}`); return { bundles: [], errors: [], skipped: [] }; });
  const methods = createHostMethods({
    ...started.methodDeps(),
    jobs: new HostJobRunner(() => undefined),
    platform: {
      copyText: unsupported, copyImage: unsupported, readImagePreview: unsupported,
      inspectExtensions: unsupported, loadDesktopExtensions, rebuildWorkbench: unsupported,
      workbenchSource: unsupported, relaunchWorkbench: unsupported, installUpdate: unsupported,
      notify: unsupported, setBadge: unsupported,
    },
  });
  return { methods, start, create, fake, order };
}

describe("HostStart", () => {
  it("lets calls that arrive before the bootstrap wait for the host instead of failing", async () => {
    const { methods, start, create, order } = startingHost();
    // A warm window: its kit bundles and a setting arrive before its bootstrap does.
    const bundles = invokeHostMethod(methods, "desktop-extensions", ["ws:app", {}]);
    const thinking = invokeHostMethod(methods, "set-thinking", ["high"]);
    const bootstrap = invokeHostMethod(methods, "bootstrap", []);
    await Promise.resolve();
    expect(order).toEqual([]);
    start.resolve();
    await expect(Promise.all([bundles, thinking, bootstrap])).resolves.toHaveLength(3);
    expect(create).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe("started");
    expect(order.slice(1).sort()).toEqual(["bootstrap", "desktop-extensions /repo/app", "thinking high"]);
  });

  it("does not wait for a start that nothing asked for", async () => {
    const { methods, create } = startingHost();
    await expect(invokeHostMethod(methods, "abort", [])).resolves.toBeUndefined();
    await expect(invokeHostMethod(methods, "answer-extension-ui", ["question", { cancelled: true }])).resolves.toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects every waiting call with the error the start failed with", async () => {
    const { methods, start, create } = startingHost();
    const bundles = invokeHostMethod(methods, "desktop-extensions", ["ws:app", {}]);
    const bootstrap = invokeHostMethod(methods, "bootstrap", []);
    start.reject(new Error("the runtime would not start"));
    await expect(bundles).rejects.toThrow("the runtime would not start");
    await expect(bootstrap).rejects.toThrow("the runtime would not start");
    await expect(invokeHostMethod(methods, "set-thinking", ["low"])).rejects.toThrow("the runtime would not start");
    expect(create).toHaveBeenCalledTimes(1);
  });
});
