// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreferencesStore, WorkbenchActions } from "tau";
import { TestProviders, TestThreadStore } from "../../src/renderer/test-support/test-providers.js";
import { createMiniPlayerRegion } from "./mini-player.js";
import { EMPTY_PREVIEW_STATE } from "./protocol.js";
import type { ComputerUseScreenService, ScreenState } from "./screen-protocol.js";
import { screenService } from "./screen-store.js";
import { panelShown, previewStore } from "./store.js";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  panelShown.set(false);
  previewStore.set({ ...EMPTY_PREVIEW_STATE, driver: { source: "screen", threadId: "t1", since: 1 } });
});

afterEach(() => {
  cleanup();
  screenService.set(undefined);
  previewStore.set(EMPTY_PREVIEW_STATE);
  delete document.body.dataset.client;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(state?: ScreenState, overrides: Partial<ComputerUseScreenService> = {}, actions = {} as WorkbenchActions) {
  const listeners = new Set<(next: ScreenState) => void>();
  const viewFrame = vi.fn(async () => ({ id: "live-1", data: "TElWRQ==", mimeType: "image/jpeg", width: 640, height: 400 }));
  const load = vi.fn(async () => state);
  screenService.set({
    state: () => state,
    load,
    subscribe: (listener: (next: ScreenState) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    frame: async () => null,
    viewFrame,
    ...overrides,
  } as unknown as ComputerUseScreenService);
  const Region = createMiniPlayerRegion({ subscribe: () => () => undefined, optionValue: () => true } as unknown as PreferencesStore);
  const view = render(<TestProviders><TestThreadStore threads={[]}>
    <Region actions={actions} />
  </TestThreadStore></TestProviders>);
  return { ...view, viewFrame, load, publish: (next: ScreenState) => act(() => { state = next; listeners.forEach((listener) => listener(next)); }) };
}

describe("docked screen preview", () => {
  it.each(["desktop", "touch"])("shows host live frames without an agent screenshot on %s", async (client) => {
    document.body.dataset.client = client;
    const { container } = mount({ threadId: "t1", window: { pid: 42, windowId: 7 }, actions: [], canBringToFront: false, updatedAt: 1 });
    await waitFor(() => expect(container.querySelector(".preview-mini-body img")?.getAttribute("src")).toBe("data:image/jpeg;base64,TElWRQ=="));
    expect(screen.queryByText("Waiting for a picture…")).toBeNull();
    expect(container.querySelector(".preview-docked")).toBeTruthy();
  });

  it("keeps the first touch on a hybrid device from opening Preview before React renders", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    const openPanel = vi.fn();
    const view = mount({ threadId: "t1", window: { pid: 42, windowId: 7 }, actions: [], canBringToFront: false, updatedAt: 1 }, {}, { openPanel } as unknown as WorkbenchActions);
    await waitFor(() => expect(view.container.querySelector(".preview-mini-body img")).toBeTruthy());
    const body = view.container.querySelector<HTMLButtonElement>(".preview-mini-body")!;
    act(() => {
      const pointer = new Event("pointerdown", { bubbles: true });
      Object.defineProperty(pointer, "pointerType", { value: "touch" });
      body.dispatchEvent(pointer);
      body.click();
    });
    expect(openPanel).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Agent preview" }).getAttribute("data-touch-controls")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Open in Preview" }));
    expect(openPanel).toHaveBeenCalledWith("preview");
  });

  it("reveals touch controls for four seconds without opening the preview, and resets the timer", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    const openPanel = vi.fn();
    const view = mount({ threadId: "t1", window: { pid: 42, windowId: 7 }, actions: [], canBringToFront: false, updatedAt: 1 }, {}, { openPanel } as unknown as WorkbenchActions);
    await waitFor(() => expect(view.container.querySelector(".preview-mini-body img")).toBeTruthy());
    const player = screen.getByRole("region", { name: "Agent preview" });
    expect(player.hasAttribute("data-touch-controls")).toBe(false);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: /^Show preview controls:/u }));
    expect(player.getAttribute("data-touch-controls")).toBe("true");
    expect(openPanel).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(3_000));
    fireEvent.click(screen.getByRole("button", { name: /^Show preview controls:/u }));
    act(() => vi.advanceTimersByTime(3_999));
    expect(player.getAttribute("data-touch-controls")).toBe("true");
    act(() => vi.advanceTimersByTime(1));
    expect(player.hasAttribute("data-touch-controls")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /^Show preview controls:/u }));
    fireEvent.click(screen.getByRole("button", { name: "Open in Preview" }));
    expect(openPanel).toHaveBeenCalledWith("preview");
    const open = screen.getByRole("button", { name: "Open in Preview" });
    const touchStart = new Event("pointerdown", { bubbles: true });
    Object.defineProperty(touchStart, "pointerType", { value: "touch" });
    fireEvent(screen.getByRole("button", { name: /^Show preview controls:/u }), touchStart);
    act(() => vi.advanceTimersByTime(4_000));
    expect(player.hasAttribute("data-touch-controls")).toBe(false);
    act(() => open.focus());
    act(() => vi.advanceTimersByTime(4_000));
    expect(player.getAttribute("data-touch-controls")).toBe("true");
    fireEvent.blur(open, { relatedTarget: document.body });
    expect(player.hasAttribute("data-touch-controls")).toBe(false);
  });

  it("stays hidden when a tool supplied no window, then follows a window when it arrives", async () => {
    const { load, publish, container } = mount();
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(screen.queryByLabelText("Agent preview")).toBeNull();
    publish({ threadId: "t1", window: { pid: 42, windowId: 7 }, actions: [], canBringToFront: false, updatedAt: 2 });
    await waitFor(() => expect(container.querySelector(".preview-mini-body img")).toBeTruthy());
  });

  it("retries when the host's first live frame is not ready", async () => {
    const viewFrame = vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: "live-2", data: "TkVYVA==", mimeType: "image/jpeg", width: 640, height: 400 });
    const { container } = mount({ threadId: "t1", window: { pid: 42, windowId: 7 }, actions: [], canBringToFront: false, updatedAt: 1 }, { viewFrame });
    await waitFor(() => expect(container.querySelector(".preview-mini-body img")?.getAttribute("src")).toBe("data:image/jpeg;base64,TkVYVA=="));
  });

  it("reads the latest screenshot on an older host even without a frame event", async () => {
    const frame = vi.fn(async () => ({ seq: 3, at: 1, window: { pid: 42, windowId: 7 }, data: "U0hPVA==", width: 640, height: 400, mimeType: "image/png" }));
    const { container } = mount({ threadId: "t1", window: { pid: 42, windowId: 7 }, actions: [], canBringToFront: false, updatedAt: 1 }, { viewFrame: undefined, frame });
    await waitFor(() => expect(container.querySelector(".preview-mini-body img")?.getAttribute("src")).toBe("data:image/png;base64,U0hPVA=="));
    expect(frame).toHaveBeenCalledWith("t1");
  });
});
