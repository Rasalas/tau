// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
  vi.unstubAllGlobals();
});

function mount(state?: ScreenState, overrides: Partial<ComputerUseScreenService> = {}) {
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
    <Region actions={{} as WorkbenchActions} />
  </TestThreadStore></TestProviders>);
  return { ...view, viewFrame, load, publish: (next: ScreenState) => act(() => { state = next; listeners.forEach((listener) => listener(next)); }) };
}

describe("floating screen preview", () => {
  it.each(["desktop", "touch"])("shows host live frames without an agent screenshot on %s", async (client) => {
    document.body.dataset.client = client;
    const { container } = mount({ threadId: "t1", window: { pid: 42, windowId: 7 }, actions: [], canBringToFront: false, updatedAt: 1 });
    await waitFor(() => expect(container.querySelector(".preview-mini-body img")?.getAttribute("src")).toBe("data:image/jpeg;base64,TElWRQ=="));
    expect(screen.queryByText("Waiting for a picture…")).toBeNull();
  });

  it("stays hidden when a tool supplied no window, then follows a window when it arrives", async () => {
    const { load, publish, container } = mount();
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(screen.queryByLabelText("Floating preview")).toBeNull();
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
