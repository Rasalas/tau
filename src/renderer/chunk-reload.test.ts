// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createChunkRecovery, isChunkLoadError, watchChunkLoadErrors } from "./chunk-reload";

function ports(build = "index-1.js") {
  const storage = new Map<string, string>();
  const reload = vi.fn();
  return {
    storage,
    reload,
    ports: {
      storage: () => ({ getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } }),
      reload,
      build: () => build,
    },
  };
}

describe("chunk load errors", () => {
  it("tells a missing chunk from code that failed", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: http://h/assets/a.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module: http://h/assets/a.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Unable to preload CSS for /assets/a.css"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
  });

  it("reloads once per build, and again for the next build", () => {
    const one = ports("index-1.js");
    expect(createChunkRecovery(one.ports).reloadOnce()).toBe(true);
    // The page after the reload, still on build 1.
    expect(createChunkRecovery(one.ports).reloadOnce()).toBe(false);
    expect(one.reload).toHaveBeenCalledTimes(1);

    const next = { ...one.ports, build: () => "index-2.js" };
    expect(createChunkRecovery(next).reloadOnce()).toBe(true);
    expect(one.reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload without storage to remember it in", () => {
    const reload = vi.fn();
    const recovery = createChunkRecovery({ storage: () => { throw new Error("denied"); }, reload, build: () => "b" });
    expect(recovery.reloadOnce()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("swallows Vite's preload error only when the page reloads", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const target = new EventTarget() as Window;
    const { ports: first, reload } = ports();
    const recovery = createChunkRecovery(first);
    const stop = watchChunkLoadErrors(target, recovery);
    const fire = (payload: unknown) => {
      const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), { payload });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(fire(new Error("module threw"))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(fire(new TypeError("Failed to fetch dynamically imported module: x"))).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
  });
});
