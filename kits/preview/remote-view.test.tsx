// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { HostClientProvider, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { EMPTY_PREVIEW_STATE, type PreviewState } from "./protocol.js";
import RemotePreview, { fit, layoutOwner } from "./remote-view.js";
import { viewerId } from "./viewer.js";
import { windowName } from "./screen-store.js";
import { connectPreviewHost, drawsFrames, previewStore } from "./store.js";
import { hostMachineName } from "./machine.js";

/** jsdom has no PointerEvent; without one a fired pointer event carries no coordinates. */
class PointerEventShim extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? "mouse";
  }
}
if (typeof window !== "undefined" && !("PointerEvent" in window)) Object.assign(window, { PointerEvent: PointerEventShim });

let disconnect: () => void = () => undefined;
afterEach(() => {
  cleanup();
  disconnect();
  previewStore.set(EMPTY_PREVIEW_STATE);
  hostMachineName.set(undefined);
});

function setup(options: { readOnly?: boolean; focus?: "secret" | "field" | "none"; url?: string; state?: Partial<PreviewState> } = {}) {
  const invoke = vi.fn(async (command: string, _input?: unknown) => {
    if (command === "live-frame") return { id: "f1", data: "SlBFRw==", width: 400, height: 200, url: "http://localhost:18727/" };
    if (command === "input") return { focus: options.focus ?? "field" };
    return undefined;
  });
  disconnect = connectPreviewHost({ invoke, onEvent: () => () => undefined });
  previewStore.set({ ...EMPTY_PREVIEW_STATE, url: options.url ?? "http://localhost:18727/", title: "Sign in", ...options.state });
  const actions = { activeThread: () => ({ sessionId: "s1", cwd: "/p" }) } as unknown as WorkbenchActions;
  const client = createFakeHostClient({ isReadOnly: () => options.readOnly === true });
  const view = render(<HostClientProvider client={client}><RemotePreview active actions={actions} compact /></HostClientProvider>);
  return { invoke, view };
}

const inputs = (invoke: ReturnType<typeof setup>["invoke"]) => invoke.mock.calls.filter(([command]) => command === "input").map(([, input]) => input);

async function picture(): Promise<HTMLImageElement> {
  const image = await screen.findByAltText(/The page: Sign in/u) as HTMLImageElement;
  image.getBoundingClientRect = () => ({ left: 0, top: 100, width: 400, height: 200, right: 400, bottom: 300, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
  return image;
}

describe("which clients draw frames", () => {
  it("is every browser and phone, and a desktop window only away from the host's machine", () => {
    setHostClient(createFakeHostClient({ hasCapability: () => true }));
    document.body.dataset.client = "desktop";
    expect(drawsFrames()).toBe(false);
    document.body.dataset.client = "compact";
    expect(drawsFrames()).toBe(true);
    document.body.dataset.client = "web";
    expect(drawsFrames()).toBe(true);
    document.body.dataset.client = "desktop";
    setHostClient(createFakeHostClient({ hasCapability: () => false }));
    expect(drawsFrames()).toBe(true);
    setHostClient(undefined);
    delete document.body.dataset.client;
  });
});

describe("fitting the picture", () => {
  it("grows a small frame to the view and keeps its shape", () => {
    expect(fit({ width: 220, height: 484 }, { width: 377, height: 480 })).toEqual({ width: 218, height: 480 });
    expect(fit({ width: 800, height: 400 }, { width: 377, height: 480 })).toEqual({ width: 377, height: 188 });
    expect(fit({ width: 0, height: 0 }, { width: 377, height: 480 })).toBeUndefined();
  });

  it("names a driven window by its title before its app", () => {
    expect(windowName({ pid: 1, app: "Electron", title: "F13 test window" })).toBe("F13 test window");
    expect(windowName({ pid: 1, app: "TextEdit" })).toBe("TextEdit");
    expect(windowName(undefined)).toBeUndefined();
  });
});

describe("the Preview on another device", () => {
  it("shows the host's page and turns a tap into a click where it landed", async () => {
    const { invoke } = setup();
    const image = await picture();
    expect(invoke).toHaveBeenCalledWith("live-frame", expect.objectContaining({ maxWidth: expect.any(Number) }));
    fireEvent.pointerDown(image, { pointerId: 1, clientX: 100, clientY: 150, button: 0, pointerType: "touch" });
    fireEvent.pointerUp(image, { pointerId: 1, clientX: 101, clientY: 151, pointerType: "touch" });
    await waitFor(() => expect(inputs(invoke)).toEqual([{ kind: "click", x: 0.25, y: 0.25 }]));
  });

  it("scrolls on a drag instead of clicking", async () => {
    const { invoke } = setup();
    const image = await picture();
    fireEvent.pointerDown(image, { pointerId: 1, clientX: 200, clientY: 250, button: 0, pointerType: "touch" });
    fireEvent.pointerMove(image, { pointerId: 1, clientX: 200, clientY: 150, pointerType: "touch" });
    fireEvent.pointerUp(image, { pointerId: 1, clientX: 200, clientY: 150, pointerType: "touch" });
    await waitFor(() => expect(inputs(invoke)).toEqual([{ kind: "scroll", x: 0.5, y: 0.75, dx: 0, dy: 0.5 }]));
  });

  it("types into the focused field and turns this device's field into a password field for a secret", async () => {
    const { invoke } = setup({ focus: "secret" });
    const image = await picture();
    fireEvent.pointerDown(image, { pointerId: 1, clientX: 10, clientY: 110, button: 0, pointerType: "touch" });
    fireEvent.pointerUp(image, { pointerId: 1, clientX: 10, clientY: 110, pointerType: "touch" });
    const field = await screen.findByLabelText("Password for the page") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "throwaway-e27" } });
    fireEvent.click(screen.getByRole("button", { name: "Send the text" }));
    await waitFor(() => expect(inputs(invoke)).toContainEqual({ kind: "text", text: "throwaway-e27" }));
    // What went to the page is not kept on this device.
    expect(field.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));
    await waitFor(() => expect(inputs(invoke)).toContainEqual({ kind: "key", key: "Enter" }));
  });

  it("lets a Read-only device watch, and says why it cannot drive", async () => {
    const { invoke } = setup({ readOnly: true });
    const image = await picture();
    fireEvent.pointerDown(image, { pointerId: 1, clientX: 100, clientY: 150, button: 0, pointerType: "touch" });
    fireEvent.pointerUp(image, { pointerId: 1, clientX: 100, clientY: 150, pointerType: "touch" });
    expect(screen.getByText(/paired Read only/u)).toBeTruthy();
    expect(screen.queryByLabelText("Text for the page")).toBeNull();
    expect(inputs(invoke)).toEqual([]);
  });

  it("asks for no frame while nothing is open, and says what to do", async () => {
    const { invoke } = setup({ url: "" });
    expect(await screen.findByText("Nothing open")).toBeTruthy();
    expect(invoke.mock.calls.some(([command]) => command === "live-frame")).toBe(false);
  });
});

describe("the page laid out for this device", () => {
  /** jsdom lays nothing out: the stage gets a size and a ResizeObserver that measures once. */
  function withStage(width: number, height: number): () => void {
    const client = { width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"), height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight") };
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => height });
    const observer = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} disconnect() {} };
    return () => {
      if (client.width) Object.defineProperty(HTMLElement.prototype, "clientWidth", client.width);
      if (client.height) Object.defineProperty(HTMLElement.prototype, "clientHeight", client.height);
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = observer;
    };
  }
  const id = viewerId(undefined);

  it("reads whose screen the page is laid out for", () => {
    const state = { ...EMPTY_PREVIEW_STATE, url: "http://x/" };
    expect(layoutOwner(state, id)).toBe("host");
    expect(layoutOwner({ ...state, layoutFor: { id, name: "Phone", width: 390, height: 600, touch: true } }, id)).toBe("this");
    expect(layoutOwner({ ...state, layoutFor: { id: "other", name: "Tablet", width: 800, height: 1_000, touch: true } }, id)).toBe("other");
    expect(layoutOwner({ ...state, viewport: { mode: "fixed", width: 1_280, height: 800 } }, id)).toBe("fixed");
  });

  it("asks for frames as this screen and lays the page out for it on request", async () => {
    const restore = withStage(393, 616);
    try {
      const { invoke, view } = setup();
      await picture();
      expect(invoke).toHaveBeenCalledWith("live-frame", expect.objectContaining({ viewer: { id, width: 393, height: 616, dpr: 1, touch: false } }));
      fireEvent.click(screen.getByRole("button", { name: /Laid out for the host's window/u }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("layout", { viewer: expect.objectContaining({ id, width: 393 }) }));
      // Closing the view gives the page back at once.
      view.unmount();
      expect(invoke).toHaveBeenCalledWith("layout", { release: id });
    } finally {
      restore();
    }
  });

  it("says when the page already fits this screen", async () => {
    setup({ state: { layoutFor: { id, name: "Phone", width: 377, height: 600, touch: true } } });
    expect(await screen.findByText("This screen")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Lay it out for this screen/u })).toBeNull();
  });
});

describe("a machine without a window for the page", () => {
  it("says the machine shown has no display and how Linux gets one, and asks for no frames", async () => {
    hostMachineName.set("rex");
    const { invoke } = setup({ state: { noWindow: { displayService: true } } });
    expect(screen.getByText("rex has no display")).toBeTruthy();
    expect(screen.getByText("tau service install --display")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invoke.mock.calls.some(([command]) => command === "live-frame")).toBe(false);
    expect((screen.getByLabelText("Text for the page") as HTMLInputElement).disabled).toBe(true);
  });

  it("asks for the Tau app on a Mac or PC, and names the host when the machine is unknown", () => {
    setup({ state: { noWindow: { displayService: false } } });
    expect(screen.getByText("The host has no display")).toBeTruthy();
    expect(screen.getByText(/Open the Tau app there/u)).toBeTruthy();
  });

  it("looks again until a window came there", async () => {
    vi.useFakeTimers();
    try {
      const { invoke } = setup({ state: { noWindow: { displayService: false } } });
      const shown: PreviewState = { ...EMPTY_PREVIEW_STATE, url: "http://localhost:18727/", title: "Sign in" };
      invoke.mockImplementation((async (command: string) => command === "state" ? shown : undefined) as never);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(invoke.mock.calls.some(([command]) => command === "state")).toBe(true);
      expect(screen.queryByText(/has no display/u)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
