// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  devices: [{ id: "iphone", name: "Test iPhone", platform: "ios", registeredAt: "2026-09-24T10:05:00.000Z", route: "direct", lastPush: { at: "2026-09-24T10:06:00.000Z", ok: false, detail: "BadDeviceToken" } }],
  file: "/userData/kit-state/tau.push/keys.json",
  routes: { ios: "direct", android: "relay" },
};

function setup(answer: (command: string, input?: unknown) => unknown) {
  const invoke = vi.fn(async (_id: string, command: string, input?: unknown) => answer(command, input));
  const { registry, preferences } = createKitHarness(invoke);
  registry.activate(push);
  const page = registry.getSettingsPages().find((entry) => entry.id === "push.settings")!;
  const props: SettingsPageProps = { onNotify: vi.fn() };
  render(<TestProviders preferences={preferences}><page.Component {...props} /></TestProviders>);
  const event = () => act(() => registry.dispatchExtensionEvent({ type: "extension-event", extensionId: PUSH_EXTENSION_ID, name: PUSH_STATE_EVENT }));
  return { invoke, preferences, props, event, page };
}

describe("Settings → Push", () => {
  it("shows what is saved without the key, the file it lives in and the devices that asked", async () => {
    setup((command) => (command === "status" ? STATUS : undefined));
    await flush();
    expect(screen.getByText("ABC123DEFG")).toBeTruthy();
    expect(screen.getByLabelText("Key file").textContent).toContain(STATUS.file);
    expect(screen.getByText(/not encrypted/u)).toBeTruthy();
    expect(screen.getByText("Test iPhone")).toBeTruthy();
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
    const type = (name: string, value: string) => {
      const field = screen.getByRole("textbox", { name });
      fireEvent.change(field, { target: { value } });
      fireEvent.blur(field);
    };
    type("Key ID", "ABC123DEFG");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save key" })); });
    expect(screen.getByRole("alert").textContent).toBe("Enter the Key ID, the Team ID and the key (.p8).");
    expect(invoke).not.toHaveBeenCalledWith(PUSH_EXTENSION_ID, "set-apns", expect.anything());
    type("Team ID", "TEAM123456");
    type("Key (.p8)", "-----BEGIN PRIVATE KEY-----");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save key" })); });
    expect(invoke).toHaveBeenCalledWith(PUSH_EXTENSION_ID, "set-apns", { keyId: "ABC123DEFG", teamId: "TEAM123456", key: "-----BEGIN PRIVATE KEY-----" });
    event();
    await flush();
    expect(screen.getByText("ABC123DEFG")).toBeTruthy();
    expect(screen.getByText(/No phone has asked yet|Test iPhone/u)).toBeTruthy();
  });

  it("shows the host's refusal at the form", async () => {
    setup((command) => {
      if (command === "status") return { devices: [], file: STATUS.file };
      if (command === "set-fcm") throw new Error("That JSON is not a service account file (its type is not service_account).");
      return undefined;
    });
    await flush();
    const json = screen.getByRole("textbox", { name: "Service account (JSON)" });
    fireEvent.change(json, { target: { value: "{}" } });
    fireEvent.blur(json);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save service account" })); });
    await flush();
    expect(screen.getByRole("alert").textContent).toMatch(/not a service account/u);
  });

  it("sends a test push and stops a device's pushes from its row", async () => {
    const { invoke, props } = setup((command) => (command === "status" || command === "remove-device" ? STATUS : command === "test" ? { ok: true } : undefined));
    await flush();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send a test push to Test iPhone" })); });
    expect(props.onNotify).toHaveBeenCalledWith("Sent a test push to Test iPhone.");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stop pushes to Test iPhone" })); });
    expect(invoke).toHaveBeenCalledWith(PUSH_EXTENSION_ID, "remove-device", { id: "iphone" });
  });

  it("says who may set it up when this client is not the machine's owner", async () => {
    setup((command) => { if (command === "status") throw new Error("Only this machine's owner can change push notifications."); });
    await flush();
    expect(screen.getByText("Only this machine can set this up")).toBeTruthy();
  });

  it("removes a saved key only after asking, naming it", async () => {
    const { invoke } = setup((command) => (command === "status" || command === "forget" ? STATUS : undefined));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Remove key…" }));
    expect(invoke).not.toHaveBeenCalledWith(PUSH_EXTENSION_ID, "forget", expect.anything());
    const dialog = screen.getByRole("dialog", { name: "Remove the APNs key?" });
    expect(dialog.textContent).toContain("ABC123DEFG");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Remove key" })); });
    expect(invoke).toHaveBeenCalledWith(PUSH_EXTENSION_ID, "forget", { service: "apns" });
  });

  it("gives every row the search names an element on the page", async () => {
    const full: PushStatus = { ...STATUS, fcm: { projectId: "test-project", clientEmail: "push@test-project.iam.example", savedAt: "2026-09-24T10:00:00.000Z" } };
    const { page } = setup((command) => (command === "status" ? full : undefined));
    await flush();
    const rows = page.rows ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(document.getElementById(row.id), row.label).toBeTruthy();
  });

  it("says which way each platform's pushes go, and which phone's app is too old for the relay", async () => {
    const relayed: PushStatus = {
      devices: [
        { id: "pixel", name: "Pixel", platform: "android", registeredAt: "2026-09-24T10:05:00.000Z", route: "relay" },
        { id: "old", name: "Old iPhone", platform: "ios", registeredAt: "2026-09-24T10:05:00.000Z", route: "unreachable" },
      ],
      file: STATUS.file,
      routes: { ios: "relay", android: "relay" },
    };
    setup((command) => (command === "status" ? relayed : undefined));
    await flush();
    expect(document.getElementById("setting-push-route")!.textContent).toContain("iPhone: Tau's relay · Android: Tau's relay");
    expect(screen.getByText("Android · relay")).toBeTruthy();
    expect(screen.getByText(/Update the Tau app on this phone/u)).toBeTruthy();
  });

  it("asks a phone on the direct route without a token to open this machine once", async () => {
    setup((command) => (command === "status" ? { ...STATUS, devices: [{ ...STATUS.devices[0]!, route: "unreachable", lastPush: undefined }] } : undefined));
    await flush();
    expect(screen.getByText("iPhone · APNs")).toBeTruthy();
    expect(screen.getByText(/hands over its token for your own key/u)).toBeTruthy();
  });

  it("shows a saved key that does not read as an error on its platform", async () => {
    setup((command) => (command === "status" ? { ...STATUS, apns: { ...STATUS.apns!, error: "That is not a .p8 key." } } : undefined));
    await flush();
    expect(screen.getByText("Does not read")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/no pushes, not even through Tau's relay: That is not a \.p8 key\./u);
    expect(document.getElementById("setting-push-route")!.textContent).toContain("iPhone: your APNs key (does not read)");
  });

  it("switches what a notification says", async () => {
    const { preferences } = setup((command) => (command === "status" ? STATUS : undefined));
    await flush();
    fireEvent.click(screen.getByRole("radio", { name: "Title only" }));
    expect(preferences.value(PUSH_EXTENSION_ID, "content")).toBe("title");
  });
});
