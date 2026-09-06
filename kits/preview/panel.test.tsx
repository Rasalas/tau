// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reservedRegion, type WorkbenchActions } from "tau";
import type { PreviewBounds } from "./protocol.js";
import { PreviewPanel } from "./panel.js";
import { connectPreviewHost } from "./store.js";

/** jsdom has no layout, so the panel's rectangle is the one this test dictates. */
function domRect(box: { left: number; top: number; width: number; height: number }): DOMRect {
  return {
    ...box,
    right: box.left + box.width,
    bottom: box.top + box.height,
    x: box.left,
    y: box.top,
    toJSON: () => ({}),
  } as DOMRect;
}

const PANEL_RECT = domRect({ left: 900, top: 120, width: 360, height: 500 });
const EMPTY_RECT = domRect({ left: 0, top: 0, width: 0, height: 0 });

const reports: PreviewBounds[] = [];
let disconnect: () => void = () => undefined;

class StubResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

function mountScrim(className = "modal-scrim"): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  document.body.append(element);
  return element;
}

/** The mutation observer batches into a microtask; the watch answers next frame. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  });
}

function panel(active = true) {
  return <PreviewPanel active={active} extensionName="Preview Kit" actions={{} as WorkbenchActions} />;
}

const latest = () => reports.at(-1);

beforeEach(() => {
  reports.length = 0;
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  // Only the panel's own rectangle matters; jsdom has no layout to measure.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function boundingRect(this: Element) {
    return this.classList.contains("preview-surface") ? PANEL_RECT : EMPTY_RECT;
  });
  disconnect = connectPreviewHost({
    invoke: async (command: string, input?: unknown) => {
      if (command === "bounds") reports.push(input as PreviewBounds);
      return undefined;
    },
    onEvent: () => () => undefined,
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  disconnect();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PreviewPanel bounds", () => {
  it("reports the panel's rectangle as drawable when nothing covers it", async () => {
    render(panel());
    await settle();
    expect(latest()).toEqual({ x: 900, y: 120, width: 360, height: 500, visible: true });
    expect(reservedRegion()).toEqual({ left: 900, top: 120, right: 1260, bottom: 620 });
  });

  it("hides the view while a modal is up and brings it back when the modal closes", async () => {
    render(panel());
    await settle();

    const scrim = mountScrim();
    await settle();
    expect(latest()?.visible).toBe(false);
    // The rectangle still travels, so the host can place the view before showing it.
    expect(latest()).toMatchObject({ x: 900, width: 360 });
    expect(reservedRegion()).toBeUndefined();

    scrim.remove();
    await settle();
    expect(latest()?.visible).toBe(true);
    expect(reservedRegion()).toBeDefined();
  });

  it("stays hidden when the panel is resized under an open modal", async () => {
    render(panel());
    await settle();
    mountScrim("palette-backdrop");
    await settle();
    expect(latest()?.visible).toBe(false);

    reports.length = 0;
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    await act(async () => { window.dispatchEvent(new Event("scroll", { bubbles: true })); });

    expect(reports.length).toBeGreaterThan(0);
    expect(reports.every((report) => report.visible === false)).toBe(true);
  });

  it("comes back after the modal closes even if the panel remounted meanwhile", async () => {
    const view = render(panel());
    await settle();
    const scrim = mountScrim();
    await settle();

    view.unmount();
    reports.length = 0;
    render(panel());
    await settle();
    expect(latest()?.visible).toBe(false);

    scrim.remove();
    await settle();
    expect(latest()?.visible).toBe(true);
  });

  it("does not hide when the window loses focus", async () => {
    render(panel());
    await settle();
    reports.length = 0;

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();

    expect(reports.every((report) => report.visible === true)).toBe(true);
    expect(latest()?.visible ?? true).toBe(true);
  });

  it("hides on a panel switch and on unmount", async () => {
    const view = render(panel());
    await settle();

    view.rerender(panel(false));
    await settle();
    expect(latest()?.visible).toBe(false);

    view.rerender(panel(true));
    await settle();
    expect(latest()?.visible).toBe(true);

    view.unmount();
    expect(latest()).toEqual({ x: 900, y: 120, width: 360, height: 500, visible: false });
    expect(reservedRegion()).toBeUndefined();
  });
});
