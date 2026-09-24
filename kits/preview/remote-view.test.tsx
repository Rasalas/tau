// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { HostClientProvider, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { EMPTY_PREVIEW_STATE } from "./protocol.js";
import RemotePreview, { fit } from "./remote-view.js";
import { windowName } from "./screen-store.js";
import { connectPreviewHost, drawsFrames, previewStore } from "./store.js";

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
});

function setup(options: { readOnly?: boolean; focus?: "secret" | "field" | "none"; url?: string } = {}) {
  const invoke = vi.fn(async (command: string, _input?: unknown) => {
    if (command === "live-frame") return { id: "f1", data: "SlBFRw==", width: 400, height: 200, url: "http://localhost:18727/" };
    if (command === "input") return { focus: options.focus ?? "field" };
    return undefined;
  });
  disconnect = connectPreviewHost({ invoke, onEvent: () => () => undefined });
  previewStore.set({ ...EMPTY_PREVIEW_STATE, url: options.url ?? "http://localhost:18727/", title: "Sign in" });
  const actions = { activeThread: () => ({ sessionId: "s1", cwd: "/p" }) } as unknown as WorkbenchActions;
  const client = createFakeHostClient({ isReadOnly: () => options.readOnly === true });
  render(<HostClientProvider client={client}><RemotePreview active actions={actions} compact /></HostClientProvider>);
  return { invoke };
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
