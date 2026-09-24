// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsPageProps } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import push from "./desktop.js";
import { PUSH_EXTENSION_ID, PUSH_STATE_EVENT, type PushStatus } from "./protocol.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const STATUS: PushStatus = {
  apns: { keyId: "ABC123DEFG", teamId: "TEAM123456", savedAt: "2026-09-24T10:00:00.000Z" },
  devices: [{ id: "iphone", name: "Alex's iPhone", platform: "ios", registeredAt: "2026-09-24T10:05:00.000Z", lastPush: { at: "2026-09-24T10:06:00.000Z", ok: false, detail: "BadDeviceToken" } }],
  file: "/userData/kit-state/tau.push/keys.json",
};

function setup(answer: (command: string, input?: unknown) => unknown) {
  const invoke = vi.fn(async (_id: string, command: string, input?: unknown) => answer(command, input));
  const { registry, preferences } = createKitHarness(invoke);
  registry.activate(push);
  const page = registry.getSettingsPages().find((entry) => entry.id === "push.settings")!;
  const props: SettingsPageProps = { onNotify: vi.fn() };
  render(<TestProviders preferences={preferences}><page.Component {...props} /></TestProviders>);
  const event = () => act(() => registry.dispatchExtensionEvent({ type: "extension-event", extensionId: PUSH_EXTENSION_ID, name: PUSH_STATE_EVENT }));
  return { invoke, preferences, props, event };
}

describe("Settings → Push", () => {
  it("shows what is saved without the key, the file it lives in and the devices that asked", async () => {
    setup((command) => (command === "status" ? STATUS : undefined));
    await flush();
    expect(screen.getByText("ABC123DEFG")).toBeTruthy();
    expect(screen.getByText(STATUS.file)).toBeTruthy();
    expect(screen.getByText(/not encrypted/u)).toBeTruthy();
    expect(screen.getByText("Alex's iPhone")).toBeTruthy();
    expect(screen.getByText(/last push failed: BadDeviceToken/u)).toBeTruthy();
    // Firebase is not set up: its form is open.
    expect(screen.getByRole("textbox", { name: "Service account (JSON)" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Key (.p8)" })).toBeNull();
  });

  it("saves a key through the host and asks for the status again when the host says it changed", async () => {
    let saved = false;
    const { invoke, event } = setup((command) => {
      if (command === "set-apns") { saved = true; return STATUS; }
      if (command === "status") return saved ? STATUS : { devices: [], file: STATUS.file };
      return undefined;
    });
    await flush();
    fireEvent.change(screen.getByRole("textbox", { name: "Key ID" }), { target: { value: "ABC123DEFG" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Team ID" }), { target: { value: "TEAM123456" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Key (.p8)" }), { target: { value: "-----BEGIN PRIVATE KEY-----" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save key" })); });
    expect(invoke).toHaveBeenCalledWith(PUSH_EXTENSION_ID, "set-apns", { keyId: "ABC123DEFG", teamId: "TEAM123456", key: "-----BEGIN PRIVATE KEY-----" });
    event();
    await flush();
    expect(screen.getByText("ABC123DEFG")).toBeTruthy();
    expect(screen.getByText(/No phone has asked yet|Alex's iPhone/u)).toBeTruthy();
  });

  it("shows the host's refusal at the form", async () => {
    setup((command) => {
      if (command === "status") return { devices: [], file: STATUS.file };
      if (command === "set-fcm") throw new Error("That JSON is not a service account file (its type is not service_account).");
      return undefined;
    });
    await flush();
    fireEvent.change(screen.getByRole("textbox", { name: "Service account (JSON)" }), { target: { value: "{}" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save service account" })); });
    await flush();
    expect(screen.getByRole("alert").textContent).toMatch(/not a service account/u);
  });

  it("sends a test push and stops a device's pushes from its row", async () => {
    const { invoke, props } = setup((command) => (command === "status" || command === "remove-device" ? STATUS : command === "test" ? { ok: true } : undefined));
    await flush();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send a test push to Alex's iPhone" })); });
    expect(props.onNotify).toHaveBeenCalledWith("Sent a test push to Alex's iPhone.");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stop pushes to Alex's iPhone" })); });
    expect(invoke).toHaveBeenCalledWith(PUSH_EXTENSION_ID, "remove-device", { id: "iphone" });
  });

  it("says who may set it up when this client is not the machine's owner", async () => {
    setup((command) => { if (command === "status") throw new Error("Only this machine's owner can change push notifications."); });
    await flush();
    expect(screen.getByText("Only this machine can set this up")).toBeTruthy();
  });

  it("switches what a notification says", async () => {
    const { preferences } = setup((command) => (command === "status" ? STATUS : undefined));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Title only" }));
    expect(preferences.value(PUSH_EXTENSION_ID, "content")).toBe("title");
  });
});
