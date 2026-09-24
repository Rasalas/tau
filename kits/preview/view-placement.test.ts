import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeView, fakeWindow, type FakeWindow } from "./fake-electron-window.js";

const stages = vi.hoisted(() => [] as Array<{ options: Record<string, unknown>; window: unknown }>);
vi.mock("electron", async () => {
  const { fakeWindow: stageWindow } = await import("./fake-electron-window.js");
  return {
    BaseWindow: class {
      constructor(options: Record<string, unknown>) {
        const window = stageWindow();
        window.visible = false;
        stages.push({ options, window });
        return window;
      }
    },
  };
});

const { placePreviewView } = await import("./view-placement.js");

const setup = (prepare?: (window: FakeWindow) => void) => {
  const window = fakeWindow();
  prepare?.(window);
  const view = fakeView();
  view.setVisible(false);
  window.contentView.addChildView(view);
  const placement = placePreviewView(window as never, view as never);
  return { window, view, placement };
};

const RECT = { x: 12, y: 80, width: 393, height: 700 };

beforeEach(() => { stages.length = 0; });

describe("placePreviewView", () => {
  it("gives a view the window never showed its size, so the page has something to paint", () => {
    const { view, window, placement } = setup();
    placement.place(RECT, false);

    expect(view.nativeSize).toBe("393x700");
    expect(view.visible).toBe(false);
    expect(view.parent).toBe(window.contentView);
    expect(placement.onScreen()).toBe(false);
  });

  it("resizes a hidden view, and shows it for that only when the size changes", () => {
    const { view, placement } = setup();
    placement.place(RECT, false);
    const show = vi.spyOn(view, "setVisible");

    placement.place({ ...RECT, x: 40 }, false);
    expect(show).not.toHaveBeenCalledWith(true);
    placement.place({ ...RECT, width: 500 }, false);

    expect(view.nativeSize).toBe("500x700");
    expect(view.visible).toBe(false);
  });

  it("counts as on screen only while shown in a window that paints", () => {
    const { window, placement } = setup();
    placement.place(RECT, true);
    expect(placement.onScreen()).toBe(true);
    window.visible = false;
    expect(placement.onScreen()).toBe(false);
  });

  it("waits in a window that is never shown while the user's window is minimized, and comes back", () => {
    const { view, window, placement } = setup();
    placement.place(RECT, true);

    window.minimized = true;
    window.emit("minimize");
    const stage = stages[0]!.window as FakeWindow;
    expect(stages[0]!.options).toMatchObject({ show: false, focusable: false, x: 40, y: 30 });
    expect(view.parent).toBe(stage.contentView);
    expect(view.visible).toBe(true);
    expect(placement.onScreen()).toBe(false);

    placement.place({ ...RECT, width: 640 }, false);
    expect(stage.contentSizes.at(-1)).toBe("640x700");
    expect(view.nativeSize).toBe("640x700");

    window.minimized = false;
    window.emit("restore");
    expect(stage.destroyed).toBe(true);
    expect(view.parent).toBe(window.contentView);
    expect(view.visible).toBe(false);
    expect(view.bounds).toEqual({ ...RECT, width: 640 });
    expect(view.nativeSize).toBe("640x700");
  });

  it("starts in the stage when the window is already minimized, and leaves no window behind", () => {
    const { view, window, placement } = setup((target) => { target.minimized = true; });
    placement.place(RECT, false);
    const stage = stages[0]!.window as FakeWindow;
    expect(view.parent).toBe(stage.contentView);
    expect(view.nativeSize).toBe("393x700");

    placement.destroy();
    expect(stage.destroyed).toBe(true);
    expect(view.parent).toBeUndefined();
    expect([...window.handlers.values()].every((handlers) => handlers.size === 0)).toBe(true);
  });
});
