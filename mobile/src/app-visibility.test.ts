import { describe, expect, it, vi } from "vitest";
import { nativeAppVisibility } from "./app-visibility";

function appEvents(read = async () => ({ isActive: true })) {
  let listener!: (state: { isActive: boolean }) => void;
  const remove = vi.fn(async () => {});
  return {
    getState: read,
    addListener: async (_event: "appStateChange", next: typeof listener) => { listener = next; return { remove }; },
    active: (isActive: boolean) => listener({ isActive }),
    remove,
  };
}

describe("native app visibility", () => {
  it("starts with native background state and shares transitions with polling and widgets", async () => {
    const app = appEvents(async () => ({ isActive: false }));
    const visibility = await nativeAppVisibility(app);
    const polling = vi.fn();
    const widgets = vi.fn();
    const unsubscribe = visibility.subscribe(polling);
    visibility.subscribe(widgets);
    expect(visibility.visible()).toBe(false);

    app.active(true);
    app.active(true);
    expect(visibility.visible()).toBe(true);
    expect(polling).toHaveBeenCalledOnce();
    expect(widgets).toHaveBeenCalledOnce();
    unsubscribe();
    app.active(false);
    expect(visibility.visible()).toBe(false);
    expect(polling).toHaveBeenCalledOnce();
    expect(widgets).toHaveBeenCalledTimes(2);

    visibility.dispose();
    visibility.dispose();
    app.active(true);
    expect(widgets).toHaveBeenCalledTimes(2);
    expect(app.remove).toHaveBeenCalledOnce();
  });

  it("keeps a newer native transition when the initial state resolves late", async () => {
    let finish!: (state: { isActive: boolean }) => void;
    const initial = new Promise<{ isActive: boolean }>((resolve) => { finish = resolve; });
    const app = appEvents(() => initial);
    const pending = nativeAppVisibility(app);
    app.active(false);
    finish({ isActive: true });
    const visibility = await pending;
    expect(visibility.visible()).toBe(false);
    visibility.dispose();
  });

  it("still follows native transitions when reading the initial state fails", async () => {
    const app = appEvents(async () => { throw new Error("unavailable"); });
    const visibility = await nativeAppVisibility(app);
    app.active(false);
    expect(visibility.visible()).toBe(false);
    app.active(true);
    expect(visibility.visible()).toBe(true);
    visibility.dispose();
  });
});
