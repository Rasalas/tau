import { describe, expect, it, vi } from "vitest";
import { AppUpdateStore } from "./app-update";

describe("AppUpdateStore", () => {
  it("tells its readers about a new version once, and keeps it until another replaces it", () => {
    const store = new AppUpdateStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const install = vi.fn();
    store.set({ version: "0.8.0", install });
    const again = vi.fn();
    store.set({ version: "0.8.0", install: again });
    expect(listener).toHaveBeenCalledTimes(1);
    store.getSnapshot()?.install();
    expect(again).toHaveBeenCalledTimes(1);
    store.set({ version: "0.8.1", install });
    expect(store.getSnapshot()?.version).toBe("0.8.1");
    expect(listener).toHaveBeenCalledTimes(2);
    store.set({ version: "0.8.1", phase: "downloading", progress: 40, install });
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
