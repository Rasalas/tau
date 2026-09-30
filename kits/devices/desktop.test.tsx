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

it("shows a lazy 3D inspection shell and floats the selected live device over chat", async () => {
  const invoke = host(), floating = new FloatingDevice();
  const actions = { openPanel: vi.fn(), openSettings: vi.fn() } as unknown as WorkbenchActions;
  render(<><DevicePanel active extensionName="Devices" actions={actions} invoke={invoke} floating={floating} /><FloatingDeviceView store={floating} actions={actions} invoke={invoke} /></>);
  fireEvent.click(await screen.findByRole("button", { name: /Test iPhone · ios/ }));
  await screen.findByRole("img", { name: "Test iPhone screen" });
  fireEvent.click(screen.getByRole("button", { name: "3D view" }));
  expect(await screen.findByRole("slider", { name: "3D turn" })).toBeTruthy();
  fireEvent.change(screen.getByRole("slider", { name: "3D turn" }), { target: { value: "40" } });
  expect(screen.getByRole("img", { name: "Test iPhone 3D inspection" }).parentElement?.style.transform).toContain("rotateY(40deg)");
  fireEvent.click(screen.getByRole("button", { name: "Float over chat" }));
  expect(await screen.findByRole("img", { name: "Test iPhone floating screen" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open controls" }));
  expect(actions.openPanel).toHaveBeenCalledWith("devices");
  await waitFor(() => expect(screen.queryByRole("img", { name: "Test iPhone floating screen" })).toBeNull());
});
