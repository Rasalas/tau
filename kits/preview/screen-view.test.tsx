// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerUseScreenService, ScreenAccess, ScreenLiveFrame, ScreenState } from "./screen-protocol.js";
import ScreenView from "./screen-view.js";

const driven: ScreenState = {
  threadId: "thread",
  window: { pid: 42, windowId: 7, app: "Electron", title: "E24 test window" },
  frame: { seq: 3, at: 1, width: 1280, height: 1408, mimeType: "image/png", window: { pid: 42, windowId: 7 } },
  actions: [{ id: "a", kind: "click", at: 1, point: { x: 147, y: 326 }, space: { width: 1280, height: 1408 }, status: "done" }],
  canBringToFront: true,
  updatedAt: 1,
};

/** A service over fixtures: one driven window, its screenshot, and a live feed the test pushes. */
function fakeService(options: { state?: ScreenState; access?: ScreenAccess } = {}) {
  const listeners = new Set<(state: ScreenState) => void>();
  let pushLive: ((frame: ScreenLiveFrame) => void) | undefined;
  const stopLive = vi.fn();
  const service: ComputerUseScreenService = {
    state: () => options.state,
    load: vi.fn(async () => options.state),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    frame: vi.fn(async (_thread: string, seq?: number) => ({ ...driven.frame!, seq: seq ?? 3, data: "iVBORw0KGgo=" })),
    bringToFront: vi.fn(async () => undefined),
    icon: vi.fn(async () => "data:image/png;base64,ICON"),
    access: vi.fn(async () => options.access ?? "not-determined"),
    openAccessSettings: vi.fn(async () => undefined),
    live: vi.fn((_thread: string, onFrame: (frame: ScreenLiveFrame) => void) => { pushLive = onFrame; return stopLive; }),
  };
  return {
    service,
    stopLive,
    push: (state: ScreenState) => act(() => { listeners.forEach((listener) => listener(state)); }),
    live: (frame: ScreenLiveFrame) => act(() => { pushLive?.(frame); }),
  };
}

afterEach(cleanup);

describe("ScreenView", () => {
  it("says what it is for while no window is driven", () => {
    const { service } = fakeService();
    render(<ScreenView service={service} threadId="thread" />);
    expect(screen.getByText("No window yet")).toBeTruthy();
    render(<ScreenView service={service} threadId={undefined} />);
    expect(screen.getAllByText("No window yet")).toHaveLength(2);
  });

  it("shows the window's latest screenshot under the agent's cursor, the app as an icon and the window's title", async () => {
    const { service } = fakeService({ state: driven });
    const { container } = render(<ScreenView service={service} threadId="thread" />);

    const picture = await screen.findByAltText("Electron: E24 test window") as HTMLImageElement;
    expect(picture.src).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(service.frame).toHaveBeenCalledWith("thread", 3);
    expect(container.querySelector(".agent-cursor")).not.toBeNull();
    expect(screen.getByLabelText("Electron").getAttribute("data-tooltip")).toBe("Electron");
    await waitFor(() => expect(container.querySelector(".screen-app img")?.getAttribute("src")).toBe("data:image/png;base64,ICON"));
    expect(screen.getByText("E24 test window")).toBeTruthy();
    expect(screen.getByText("Clicked")).toBeTruthy();
  });

  it("degrades to screenshots without Screen Recording, and offers the privacy settings", async () => {
    const { service } = fakeService({ state: driven, access: "denied" });
    render(<ScreenView service={service} threadId="thread" />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Privacy settings" }));
    expect(service.openAccessSettings).toHaveBeenCalled();
    expect(service.live).not.toHaveBeenCalled();
    expect(screen.getByText("screenshot")).toBeTruthy();
  });

  it("goes live on the driven window when allowed, and stops when paused", async () => {
    const fake = fakeService({ state: driven, access: "granted" });
    render(<ScreenView service={fake.service} threadId="thread" />);
    await waitFor(() => expect(fake.service.live).toHaveBeenCalledWith("thread", expect.any(Function), expect.any(Function)));
    fake.live({ seq: 1, url: "data:image/jpeg;base64,LIVE", width: 640, height: 704 });

    expect((screen.getByAltText("Electron: E24 test window") as HTMLImageElement).src).toBe("data:image/jpeg;base64,LIVE");
    expect(screen.getByText("live")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(fake.stopLive).toHaveBeenCalled();
    expect(screen.getByText("paused")).toBeTruthy();
    // A paused view does not fetch what the agent sees next.
    fake.push({ ...driven, frame: { ...driven.frame!, seq: 4 }, updatedAt: 2 });
    expect(fake.service.frame).not.toHaveBeenCalledWith("thread", 4);
    fireEvent.click(screen.getByRole("button", { name: "Follow the window" }));
    await waitFor(() => expect(fake.service.frame).toHaveBeenCalledWith("thread", 4));
  });

  it("raises the window through the driver, and only when the driver can", async () => {
    const { service } = fakeService({ state: driven });
    render(<ScreenView service={service} threadId="thread" />);
    fireEvent.click(await screen.findByRole("button", { name: "Bring to front" }));
    expect(service.bringToFront).toHaveBeenCalledWith("thread");

    cleanup();
    render(<ScreenView service={fakeService({ state: { ...driven, canBringToFront: false } }).service} threadId="thread" />);
    expect((screen.getByRole("button", { name: "Bring to front" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
