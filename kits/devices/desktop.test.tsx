// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { FloatingDevice, FloatingDeviceView } from "./floating.js";
import { DevicePanel, DeviceSettingsPage, type Invoke } from "./desktop.js";
import { DEFAULT_SETTINGS, type Device, type HubState } from "./protocol.js";
afterEach(cleanup);
const phone: Device = { hostId: "local", id: "test-phone", name: "Test iPhone", platform: "ios", version: "18", booted: true };
const state: HubState = { settings: structuredClone(DEFAULT_SETTINGS), tools: [], devices: [phone] };
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
  expect((consent as HTMLInputElement).checked).toBe(false);
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
  fireEvent.click(screen.getByRole("button", { name: "3D view" }));
  expect(await screen.findByRole("slider", { name: "3D turn" })).toBeTruthy();
  fireEvent.change(screen.getByRole("slider", { name: "3D turn" }), { target: { value: "40" } });
  const scene = screen.getByRole("img", { name: "Test iPhone 3D inspection" });
  const probe = scene.parentElement!.querySelector<HTMLImageElement>(".devices-pose-probe")!;
  Object.defineProperties(probe, { naturalWidth: { value: 1000 }, naturalHeight: { value: 2000 } });
  fireEvent.load(probe);
  expect(scene.querySelector<HTMLElement>(".devices-pose-body")?.style.transform).toContain("rotateY(40deg)");
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
  await screen.findByText("Device posture: opened · 180°");
  fireEvent.click(screen.getByRole("checkbox", { name: "Live screen" }));
  await waitFor(() => expect(screen.getByRole("img", { name: "Pixel Fold screen" }).getAttribute("src")).toContain("opened"));
  fireEvent.click(screen.getByRole("button", { name: "Closed" }));
  await screen.findByText("Device posture: closed · 0°");
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
  expect(screen.queryByRole("button", { name: "Closed" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Opened" })).toBeNull();
});
