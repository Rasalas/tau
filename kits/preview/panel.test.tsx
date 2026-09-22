// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reservedRegion, type WorkbenchActions } from "tau";
import { holdChipService } from "./attach.js";
import { EMPTY_PREVIEW_STATE, type PreviewBounds, type PreviewChipInput } from "./protocol.js";
import { PreviewPanel } from "./panel.js";
import { connectPreviewHost, previewStore } from "./store.js";

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

describe("PreviewPanel tools", () => {
  const PICKED = {
    url: "http://localhost:8000/",
    title: "Home",
    selector: "#save",
    tag: "button",
    text: "Save",
    rect: { x: 1, y: 2, width: 3, height: 4 },
    html: "<button id=\"save\">Save</button>",
    viewport: { width: 800, height: 600 },
  };

  function connect(answers: Record<string, unknown>) {
    const calls: Array<[string, unknown]> = [];
    disconnect();
    disconnect = connectPreviewHost({
      invoke: async (command: string, input?: unknown) => {
        calls.push([command, input]);
        return answers[command];
      },
      onEvent: () => () => undefined,
    });
    return calls;
  }

  afterEach(() => previewStore.set(EMPTY_PREVIEW_STATE));

  it("offers the local servers the host found while nothing is loaded, and opens one", async () => {
    const calls = connect({ ports: [{ url: "http://localhost:8000/", port: 8000, command: "python3", inWorkspace: true, html: true }] });
    render(panel());
    await settle();
    const suggestion = await screen.findByRole("button", { name: /localhost:8000/u });
    expect(suggestion.textContent).toContain("python3 · this project");
    expect(calls).toContainEqual(["ports", {}]);
    fireEvent.click(suggestion);
    expect(calls).toContainEqual(["open", { url: "http://localhost:8000/" }]);
  });

  it("puts a picked element into the composer as a chip and an image", async () => {
    connect({ pick: { element: PICKED, image: { data: "iVBORw0KGgo=", width: 3, height: 4 } } });
    previewStore.set({ ...EMPTY_PREVIEW_STATE, url: "http://localhost:8000/", title: "Home" });
    const chips: PreviewChipInput[] = [];
    const release = holdChipService({ addChip: (chip) => { chips.push(chip); return "chip-1"; }, removeChip: () => undefined });
    const images: unknown[] = [];
    const actions = { composerImages: () => [], setComposerImages: (next: unknown[]) => { images.push(...next); }, focusComposer: vi.fn() } as unknown as WorkbenchActions;
    render(<PreviewPanel active extensionName="Preview Kit" actions={actions} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Pick an element" })); });
    await settle();
    expect(chips).toEqual([expect.objectContaining({ kind: "text-excerpt", label: "<button> · localhost:8000" })]);
    expect(images).toEqual([expect.objectContaining({ kind: "image", name: "preview-button.png", mimeType: "image/png" })]);
    expect(actions.focusComposer).toHaveBeenCalled();
    expect(document.querySelector(".preview-status.error")).toBeNull();
    release();
  });

  it("shows each mode's own controls", async () => {
    const calls = connect({});
    previewStore.set({ ...EMPTY_PREVIEW_STATE, url: "http://localhost:8000/", mode: "annotate" });
    render(panel());
    fireEvent.click(screen.getByRole("button", { name: "Arrow" }));
    expect(calls).toContainEqual(["annotate", { tool: "arrow" }]);
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(calls).toContainEqual(["annotate-cancel", undefined]);
    act(() => previewStore.set({ ...EMPTY_PREVIEW_STATE, url: "http://localhost:8000/", recordingSince: Date.now() }));
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeDefined();
  });
});
