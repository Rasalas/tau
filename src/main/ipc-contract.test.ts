import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The preload bridge and the main process agree only by string. A channel added
 * to one and forgotten in the other fails at runtime with "No handler
 * registered", and only when the user happens to hit that button.
 */
const root = join(import.meta.dirname, "..");
const channels = (file: string) =>
  new Set(readFileSync(join(root, file), "utf8").match(/tau:[a-z-]+/gu) ?? []);

describe("IPC contract", () => {
  const preload = channels("preload/index.cts");
  const main = channels("main/index.ts");

  it("registers a main handler for every channel the preload invokes", () => {
    const missing = [...preload].filter((channel) => !main.has(channel)).sort();
    expect(missing).toEqual([]);
  });

  it("exposes every handled channel through the preload", () => {
    // "tau:host-event" is pushed main → renderer, not invoked, so it is exempt.
    const pushOnly = new Set(["tau:host-event"]);
    const unreachable = [...main].filter((channel) => !preload.has(channel) && !pushOnly.has(channel)).sort();
    expect(unreachable).toEqual([]);
  });
});
