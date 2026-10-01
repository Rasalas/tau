// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { FloatingDevice, FloatingDeviceView } from "./floating.js";
import { DevicePanel, DeviceSettingsPage, type Invoke } from "./desktop.js";
import { DEFAULT_SETTINGS, type Device, type HubState } from "./protocol.js";
import { installPointerEvents } from "../../src/renderer/test-support/pointer-events.js";
installPointerEvents();
afterEach(cleanup);
const phone: Device = { hostId: "local", id: "test-phone", name: "Test iPhone", platform: "ios", version: "18", booted: true };
const state: HubState = { settings: structuredClone(DEFAULT_SETTINGS), tools: [], devices: [phone] };
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
function touchSurface(image: HTMLImageElement) {
  Object.defineProperties(image, { naturalWidth: { value: 400, configurable: true }, naturalHeight: { value: 800, configurable: true } });
  image.getBoundingClientRect = () => new DOMRect(0, 0, 200, 400);
  image.setPointerCapture = vi.fn();
}
function host() {
  const invoke = vi.fn(async <T,>(command: string, input?: unknown): Promise<T> => {
    if (command === "state") return structuredClone(state) as T;
    if (command === "configure") return { ...structuredClone(state), settings: input } as T;
    if (command === "discover") return [phone] as T;
    if (command === "frame") return { dataUrl: "data:image/png;base64,test" } as T;
    return {} as T;
  });
  return invoke as typeof invoke & Invoke;
}
it("waits for consent data and requires Save before granting agent device control", async () => {
  const invoke = host();
  render(<DeviceSettingsPage invoke={invoke} />);
  const consent = await screen.findByRole("checkbox");
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("state"));
  expect(consent.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(consent);
  expect(invoke).not.toHaveBeenCalledWith("configure", expect.anything());
  fireEvent.click(screen.getByRole("button", { name: "Save device settings" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("configure", expect.objectContaining({ agentControl: true })));
  await screen.findByText("Settings saved.");
});
it("opens an explicit device tab and captures its screen through the host", async () => {
  const invoke = host();
  render(<DevicePanel active extensionName="Devices" actions={{ openSettings: vi.fn() } as unknown as WorkbenchActions} invoke={invoke} />);
  fireEvent.click(await screen.findByRole("button", { name: /Test iPhone · ios/ }));
  await screen.findByRole("img", { name: "Test iPhone screen" });
  expect(invoke).toHaveBeenCalledWith("frame", { hostId: "local", deviceId: "test-phone" });
  expect(screen.getByRole("tab", { name: "Test iPhone" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Home" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("action", { hostId: "local", deviceId: "test-phone", action: "home" }));
});
it("shows installation and SSH failures without claiming devices are ready", async () => {
  const invoke = host();
  invoke.mockImplementation(async <T,>(command: string): Promise<T> => {
    if (command === "state") return { ...state, devices: [] } as T;
    throw new Error("SSH key login failed");
  });
  render(<DevicePanel active extensionName="Devices" actions={{ openSettings: vi.fn() } as unknown as WorkbenchActions} invoke={invoke} />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("state"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh devices" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "SSH key login failed");
  expect(screen.queryByRole("img")).toBeNull();
});

it("shows a lazy articulated 3D inspection and floats the selected live device over chat", async () => {
  const invoke = host(), floating = new FloatingDevice();
  const actions = { openPanel: vi.fn(), openSettings: vi.fn() } as unknown as WorkbenchActions;
  render(<><DevicePanel active extensionName="Devices" actions={actions} invoke={invoke} floating={floating} /><FloatingDeviceView store={floating} actions={actions} invoke={invoke} /></>);
  fireEvent.click(await screen.findByRole("button", { name: /Test iPhone · ios/ }));
  await screen.findByRole("img", { name: "Test iPhone screen" });
  fireEvent.click(screen.getByRole("radio", { name: "3D view" }));
  await screen.findByRole("img", { name: "Test iPhone 3D inspection" });
  fireEvent.click(screen.getByText("View controls"));
  expect(await screen.findByRole("slider", { name: "3D turn" })).toBeTruthy();
  fireEvent.change(screen.getByRole("slider", { name: "3D turn" }), { target: { value: "40" } });
  const scene = screen.getByRole("img", { name: "Test iPhone 3D inspection" });
  const probe = scene.parentElement!.querySelector<HTMLImageElement>(".devices-pose-probe")!;
  Object.defineProperties(probe, { naturalWidth: { value: 1000 }, naturalHeight: { value: 2000 } });
  fireEvent.load(probe);
  expect(scene.querySelector<HTMLElement>(".devices-pose-body")?.style.transform).toContain("rotateY(40deg)");
  fireEvent.click(screen.getByRole("button", { name: "Control screen" }));
  await screen.findByRole("img", { name: "Test iPhone screen" });
  expect(screen.getByRole("radio", { name: "Flat screen" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Float over chat" }));
  expect(await screen.findByRole("img", { name: "Test iPhone floating screen" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open controls" }));
  expect(actions.openPanel).toHaveBeenCalledWith("devices");
  await waitFor(() => expect(screen.queryByRole("img", { name: "Test iPhone floating screen" })).toBeNull());
});

it("uses native fold support and refreshes the capture after a confirmed posture change even when paused", async () => {
  const foldable: Device = { ...phone, id: "fold", name: "Pixel Fold", platform: "android" };
  let posture: "opened" | "closed" = "opened";
  const invoke = vi.fn(async <T,>(command: string, input?: unknown): Promise<T> => {
    if (command === "state") return { ...state, devices: [foldable] } as T;
    if (command === "fold-state") return { supported: true, posture, hingeAngle: posture === "opened" ? 180 : 0 } as T;
    if (command === "frame") return { dataUrl: `data:image/png;base64,${posture}` } as T;
    if (command === "action") { posture = "closed"; return { supported: true, posture, hingeAngle: 0 } as T; }
    return input as T;
  }) as Invoke & ReturnType<typeof vi.fn>;
  render(<DevicePanel active extensionName="Devices" actions={{ openSettings: vi.fn() } as unknown as WorkbenchActions} invoke={invoke} />);
  fireEvent.click(await screen.findByRole("button", { name: /Pixel Fold · android/ }));
  await screen.findByText("Device posture: Opened · 180°");
  fireEvent.click(screen.getByRole("checkbox", { name: "Live screen" }));
  await waitFor(() => expect(screen.getByRole("img", { name: "Pixel Fold screen" }).getAttribute("src")).toContain("opened"));
  fireEvent.click(screen.getByRole("button", { name: "Fold device" }));
  await screen.findByText("Device posture: Closed · 0°");
  await waitFor(() => expect(screen.getByRole("img", { name: "Pixel Fold screen" }).getAttribute("src")).toContain("closed"));
  expect(invoke).toHaveBeenCalledWith("action", { hostId: "local", deviceId: "fold", action: "fold", enabled: true });
});

it("hides native fold controls for an emulator whose hinge sensor reports unsupported", async () => {
  const android: Device = { ...phone, platform: "android", name: "Foldable custom" };
  const invoke = host();
  invoke.mockImplementation(async <T,>(command: string): Promise<T> => {
    if (command === "state") return { ...state, devices: [android] } as T;
    if (command === "fold-state") return { supported: false, posture: null, hingeAngle: null } as T;
    if (command === "frame") return { dataUrl: "data:image/png;base64,unsupported" } as T;
    return {} as T;
  });
  render(<DevicePanel active extensionName="Devices" actions={{ openSettings: vi.fn() } as unknown as WorkbenchActions} invoke={invoke} />);
  fireEvent.click(await screen.findByRole("button", { name: /Foldable custom · android/ }));
  await screen.findByRole("img", { name: "Foldable custom screen" });
  expect(screen.queryByRole("button", { name: "Fold device" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Unfold device" })).toBeNull();
});

it.each(["home", "rotate", "tap", "text"])("refreshes the result of %s once while Live screen stays paused", async (action) => {
  let result = "before";
  const invoke = host();
  invoke.mockImplementation(async <T,>(command: string): Promise<T> => {
    if (command === "state") return structuredClone(state) as T;
    if (command === "frame") return { dataUrl: `${png}#${result}` } as T;
    if (command === "action") result = action;
    return {} as T;
  });
  render(<DevicePanel active extensionName="Devices" actions={{ openSettings: vi.fn() } as unknown as WorkbenchActions} invoke={invoke} />);
  fireEvent.click(await screen.findByRole("button", { name: /Test iPhone · ios/ }));
  await waitFor(() => expect(screen.getByRole("img", { name: "Test iPhone screen" }).getAttribute("src")).toBe(`${png}#before`));
  fireEvent.click(screen.getByRole("checkbox", { name: "Live screen" }));
  await act(async () => {});
  const framesBefore = invoke.mock.calls.filter(([command]) => command === "frame").length;
  if (action === "home") fireEvent.click(screen.getByRole("button", { name: "Home" }));
  if (action === "rotate") fireEvent.change(screen.getByRole("combobox", { name: "Orientation" }), { target: { value: "landscape-left" } });
  if (action === "text") {
    fireEvent.change(screen.getByRole("textbox", { name: "Device text" }), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send text" }));
  }
  if (action === "tap") {
    const image = screen.getByRole("img", { name: "Test iPhone screen" }) as HTMLImageElement;
    touchSurface(image);
    fireEvent.pointerDown(image, { clientX: 50, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(image, { clientX: 50, clientY: 100, pointerId: 1 });
  }
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("action", expect.objectContaining({ action })));
  await waitFor(() => expect(screen.getByRole("img", { name: "Test iPhone screen" }).getAttribute("src")).toBe(`${png}#${action}`), { timeout: 1_000 });
  expect(invoke.mock.calls.filter(([command]) => command === "frame")).toHaveLength(framesBefore + 1);
  expect(screen.getByRole("checkbox", { name: "Live screen" }).getAttribute("aria-checked")).toBe("false");
  if (action === "home") {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 750)); });
    expect(invoke.mock.calls.filter(([command]) => command === "frame")).toHaveLength(framesBefore + 1);
  }
});

it("does not send a gesture started on another device", async () => {
  const other: Device = { ...phone, id: "other-phone", name: "Other iPhone" };
  const invoke = host();
  invoke.mockImplementation(async <T,>(command: string, input?: unknown): Promise<T> => {
    if (command === "state") return { ...state, devices: [phone, other] } as T;
    if (command === "frame") return { dataUrl: `${png}#${(input as { deviceId: string }).deviceId}` } as T;
    return {} as T;
  });
  render(<DevicePanel active extensionName="Devices" actions={{ openSettings: vi.fn() } as unknown as WorkbenchActions} invoke={invoke} />);
  fireEvent.click(await screen.findByRole("button", { name: /Test iPhone · ios/ }));
  const first = await screen.findByRole("img", { name: "Test iPhone screen" }) as HTMLImageElement;
  touchSurface(first);
  fireEvent.pointerDown(first, { clientX: 50, clientY: 100, pointerId: 1 });
  fireEvent.change(screen.getByRole("combobox", { name: "Open a device" }), { target: { value: "other-phone" } });
  await waitFor(() => expect(screen.getByRole("img", { name: "Other iPhone screen" }).getAttribute("src")).toBe(`${png}#other-phone`));
  const second = screen.getByRole("img", { name: "Other iPhone screen" }) as HTMLImageElement;
  touchSurface(second);
  fireEvent.pointerUp(second, { clientX: 100, clientY: 100, pointerId: 1 });
  expect(invoke.mock.calls.filter(([command]) => command === "action")).toHaveLength(0);
});

it("does not send gesture coordinates after the capture dimensions change", async () => {
  const invoke = host();
  render(<DevicePanel active extensionName="Devices" actions={{ openSettings: vi.fn() } as unknown as WorkbenchActions} invoke={invoke} />);
  fireEvent.click(await screen.findByRole("button", { name: /Test iPhone · ios/ }));
  const image = await screen.findByRole("img", { name: "Test iPhone screen" }) as HTMLImageElement;
  touchSurface(image);
  fireEvent.pointerDown(image, { clientX: 50, clientY: 100, pointerId: 1 });
  Object.defineProperties(image, { naturalWidth: { value: 800, configurable: true }, naturalHeight: { value: 400, configurable: true } });
  fireEvent.pointerUp(image, { clientX: 50, clientY: 100, pointerId: 1 });
  expect(invoke.mock.calls.filter(([command]) => command === "action")).toHaveLength(0);
});

it("rejects a capture from before rotation and waits for its fresh result before accepting input", async () => {
  let settleOld!: (value: { dataUrl: string }) => void;
  let settleNew!: (value: { dataUrl: string }) => void;
  let settleRotation!: () => void;
  let frameCount = 0;
  const invoke = host();
  invoke.mockImplementation(async <T,>(command: string): Promise<T> => {
    if (command === "state") return structuredClone(state) as T;
    if (command === "frame") {
      frameCount++;
      if (frameCount === 1) return { dataUrl: `${png}#before` } as T;
      return await new Promise<{ dataUrl: string }>((resolve) => { if (frameCount === 2) settleOld = resolve; else settleNew = resolve; }) as T;
    }
    if (command === "action") return await new Promise<void>((resolve) => { settleRotation = resolve; }) as T;
    return {} as T;
  });
  render(<DevicePanel active extensionName="Devices" actions={{ openSettings: vi.fn() } as unknown as WorkbenchActions} invoke={invoke} />);
  fireEvent.click(await screen.findByRole("button", { name: /Test iPhone · ios/ }));
  await waitFor(() => expect(screen.getByRole("img", { name: "Test iPhone screen" }).getAttribute("src")).toBe(`${png}#before`));
  fireEvent.click(screen.getByRole("checkbox", { name: "Live screen" }));
  await waitFor(() => expect(frameCount).toBe(2));
  const image = screen.getByRole("img", { name: "Test iPhone screen" }) as HTMLImageElement;
  touchSurface(image);
  fireEvent.pointerDown(image, { clientX: 50, clientY: 100, pointerId: 1 });
  fireEvent.change(screen.getByRole("combobox", { name: "Orientation" }), { target: { value: "landscape-left" } });
  await act(async () => { settleOld({ dataUrl: `${png}#stale` }); });
  expect(image.getAttribute("src")).toBe(`${png}#before`);
  await act(async () => { settleRotation(); });
  await waitFor(() => expect(frameCount).toBe(3));
  // The gesture begun before rotation must be discarded, even after the action finishes.
  fireEvent.pointerUp(image, { clientX: 50, clientY: 100, pointerId: 1 });
  fireEvent.pointerDown(image, { clientX: 50, clientY: 100, pointerId: 2 });
  fireEvent.pointerUp(image, { clientX: 50, clientY: 100, pointerId: 2 });
  expect(invoke.mock.calls.filter(([command]) => command === "action")).toHaveLength(1);
  await act(async () => { settleNew({ dataUrl: `${png}#rotated` }); });
  await waitFor(() => expect(image.getAttribute("src")).toBe(`${png}#rotated`));
  fireEvent.pointerDown(image, { clientX: 50, clientY: 100, pointerId: 3 });
  fireEvent.pointerUp(image, { clientX: 50, clientY: 100, pointerId: 3 });
  expect(invoke).toHaveBeenCalledWith("action", { hostId: "local", deviceId: "test-phone", action: "tap", x: 100, y: 200 });
  await act(async () => { settleRotation(); });
  await waitFor(() => expect(frameCount).toBe(4));
  await act(async () => { settleNew({ dataUrl: `${png}#tapped` }); });
});
