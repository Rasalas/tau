// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerInlineContext } from "tau";
import { createKitHarness, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { missingSettingsRows, renderKitSettingsPage } from "../../src/renderer/test-support/kit-settings-page.js";
import snapshots, { prepareSend, SnapShotDetail, type HostApi } from "./desktop.js";
import { SETTING_ENABLED, SNAPSHOTS_EXTENSION_ID as ID, SNAPSHOT_EVENT, type SnapShotContent, type SnapShotMeta } from "./protocol.js";
import { ShotStore } from "./shots.js";

afterEach(() => { cleanup(); setHostClient(undefined); });

const SCOPE = "session:t1";
const inline = (overrides: Partial<ComposerInlineContext> = {}): ComposerInlineContext => ({ scope: SCOPE, fileAttachments: false, imageInput: true, ...overrides });
const meta = (id: string, overrides: Partial<SnapShotMeta> = {}): SnapShotMeta => ({
  id, app: "Electron", title: "E18 test window", capturedAt: 1_000, width: 2, height: 1, mimeType: "image/png", size: 8,
  accessibility: { nodes: 2, truncated: false }, claimed: false, ...overrides,
});
const content = (id: string): SnapShotContent => ({
  meta: meta(id), data: "iVBORw0KGgo=",
  accessibility: { imageSize: { width: 2, height: 1 }, truncated: false, nodes: 2, root: { role: "window", name: "E18 test window", children: [{ role: "button", name: "Press me", children: [] }] } },
});

function activate(pending: SnapShotMeta[] = [], held: unknown = null) {
  const claimed = new Set<string>();
  const released: string[] = [];
  const armed: unknown[] = [];
  const invoke = vi.fn(async (_id: string, command: string, input?: unknown): Promise<unknown> => {
    const fields = (input ?? {}) as Record<string, unknown>;
    switch (command) {
      case "arm": armed.push(input); return {};
      case "armed": return held;
      case "pending": return pending.filter((entry) => !claimed.has(entry.id));
      case "claim": {
        const id = String(fields.id);
        if (claimed.has(id)) return null;
        claimed.add(id);
        return { ...meta(id), claimed: true };
      }
      case "meta": return (fields.ids as string[]).map((id) => id === "snap-gone" ? null : meta(id));
      case "read": return fields.id === "snap-gone" ? null : content(String(fields.id));
      case "release": released.push(...(fields.ids as string[])); return undefined;
      default: throw new Error(`unexpected ${command}`);
    }
  });
  const { registry, preferences } = createKitHarness(invoke);
  registry.activate(snapshots);
  const contribution = registry.getComposerInlines().find((entry) => entry.id === "snapshots")!;
  const saved: { value?: unknown } = {};
  const draftState = { read: () => saved.value, write: (value: unknown) => { saved.value = value; } };
  const Strip = contribution.Component!;
  const mount = () => render(<Strip {...inline()} draftState={draftState} />);
  const labels = () => contribution.chips!.list(SCOPE).map((chip) => chip.label);
  const emit = (payload: unknown) => registry.dispatchExtensionEvent({ type: "extension-event", extensionId: ID, name: SNAPSHOT_EVENT, payload });
  return { registry, preferences, contribution, invoke, released, armed, saved, draftState, Strip, mount, labels, emit };
}

describe("SnapShots desktop", () => {
  it("puts a new capture into the composer on screen as a chip in the text", async () => {
    const kit = activate();
    kit.mount();
    await act(async () => { kit.emit(meta("snap-a")); });
    await waitFor(() => expect(kit.labels()).toEqual(["Electron — E18 test window"]));
    expect(kit.saved.value).toEqual({ version: 1, ids: ["snap-a"] });
    // Another client was first: nothing lands twice.
    await act(async () => { kit.emit(meta("snap-a")); });
    expect(kit.labels()).toHaveLength(1);
  });

  it("delivers what waited while no composer was open, once one shows", async () => {
    const kit = activate([meta("snap-early")]);
    await act(async () => { kit.emit(meta("snap-early")); });
    expect(kit.labels()).toEqual([]);
    kit.mount();
    await waitFor(() => expect(kit.labels()).toEqual(["Electron — E18 test window"]));
  });

  it("asks the host for waiting captures once, not every time the composer renders anew", async () => {
    const kit = activate();
    const pendingCalls = () => kit.invoke.mock.calls.filter(([, command]) => command === "pending").length;
    const view = kit.mount();
    await waitFor(() => expect(pendingCalls()).toBe(1));
    // Core hands the strip a fresh draft handle whenever its registry changes.
    for (let turn = 0; turn < 5; turn += 1) {
      const draftState = { read: kit.draftState.read, write: kit.draftState.write };
      view.rerender(<kit.Strip {...inline()} draftState={draftState} />);
    }
    view.rerender(<kit.Strip {...inline({ scope: "session:t2" })} draftState={kit.draftState} />);
    await act(async () => { await Promise.resolve(); });
    expect(pendingCalls()).toBe(1);
  });

  it("asks again after a reconnect, since events may have been lost meanwhile", async () => {
    const pending: SnapShotMeta[] = [];
    const kit = activate(pending);
    kit.mount();
    await waitFor(() => expect(kit.invoke.mock.calls.filter(([, command]) => command === "pending")).toHaveLength(1));
    pending.push(meta("snap-while-away"));
    act(() => kit.registry.dispatchWorkbenchEvent({ type: "host-connection", state: "reconnecting" }));
    act(() => kit.registry.dispatchWorkbenchEvent({ type: "host-connection", state: "connected" }));
    await waitFor(() => expect(kit.labels()).toEqual(["Electron — E18 test window"]));
  });

  it("sends the picture as an image and the tree as data, then lets the host delete them", async () => {
    const kit = activate();
    kit.mount();
    await act(async () => { kit.emit(meta("snap-a")); });
    await waitFor(() => expect(kit.labels()).toHaveLength(1));

    const sent = await kit.contribution.prepareSend!({ ...inline(), text: "What is wrong here?" });
    expect(sent?.attachments).toEqual([{ kind: "image", name: "snapshot-electron.png", mimeType: "image/png", data: "iVBORw0KGgo=", size: 8 }]);
    expect(sent?.context).toContain("SnapShot of a window of Electron “E18 test window”");
    expect(sent?.context).toContain("\"name\":\"Press me\"");
    act(() => kit.contribution.settleSend!(SCOPE, true));
    expect(kit.released).toEqual(["snap-a"]);
    expect(kit.labels()).toEqual([]);
  });

  it("keeps the chips when the prompt was refused, and only text for a model without images", async () => {
    const store = new ShotStore();
    store.add(SCOPE, meta("snap-a"));
    const host = (async (command: string, input: { id: string }) => command === "read" ? content(input.id) : undefined) as unknown as HostApi;
    const sent = await prepareSend(store, host, inline({ imageInput: false }));
    expect(sent?.attachments).toEqual([]);
    expect(sent?.context).toContain("This model takes no images");
    expect(store.settle(SCOPE, false)).toEqual([]);
    expect(store.list(SCOPE).map((shot) => shot.id)).toEqual(["snap-a"]);
  });

  it("brings a draft's SnapShots back after a reload and marks one the host lost", async () => {
    const kit = activate();
    kit.saved.value = { version: 1, ids: ["snap-kept", "snap-gone"] };
    kit.mount();
    await waitFor(() => expect(kit.contribution.chips!.list(SCOPE).map((chip) => chip.state ?? "ok")).toEqual(["ok", "failed"]));
    await expect(kit.contribution.prepareSend!({ ...inline(), text: "" })).rejects.toThrow(/gone/u);
    act(() => kit.contribution.settleSend!(SCOPE, false));
    act(() => kit.contribution.chips!.remove(SCOPE, "snap-gone"));
    expect(kit.released).toEqual(["snap-gone"]);
  });

  it("shows the picture, the window and what it reported in the chip's popover, and says where it stays", async () => {
    const store = new ShotStore();
    store.add(SCOPE, meta("snap-a"));
    const host = (async () => content("snap-a")) as unknown as HostApi;
    render(<SnapShotDetail store={store} host={host} scope={SCOPE} chipId="snap-a" close={() => undefined} />);
    expect(await screen.findByRole("img", { name: /SnapShot of Electron/u })).toBeTruthy();
    expect(screen.getByText("2 elements the window reported")).toBeTruthy();
    expect(screen.getByText(/button “Press me”/u)).toBeTruthy();
    expect(screen.getByText(/Kept on this machine until you send it/u)).toBeTruthy();
  });

  it("asks the host to arm a window that holds no shortcut, and sends none of this client's settings", async () => {
    setHostClient(createFakeHostClient());
    const kit = activate();
    await waitFor(() => expect(kit.armed).toEqual([undefined]));
    // A setting that changes here reaches the host through its config, which re-arms itself.
    act(() => kit.preferences.setOption(ID, SETTING_ENABLED, true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kit.armed).toEqual([undefined]);
  });

  it("does not arm again what the window holds already", async () => {
    setHostClient(createFakeHostClient());
    const kit = activate([], { accelerator: null, accessibility: true });
    await waitFor(() => expect(kit.invoke).toHaveBeenCalledWith(ID, "armed", undefined));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kit.armed).toEqual([]);
  });

  it("leaves the shortcut alone from a client on another machine", async () => {
    setHostClient(createFakeHostClient({ hasCapability: () => false }));
    const kit = activate();
    act(() => kit.preferences.setOption(ID, SETTING_ENABLED, true));
    await Promise.resolve();
    expect(kit.armed).toEqual([]);
  });
});

describe("Settings → SnapShots", () => {
  function settingsPage(access: unknown) {
    const invoke = vi.fn(async (_id: string, command: string): Promise<unknown> => {
      if (command === "access") return access;
      if (command === "shortcut-state") return {};
      return undefined;
    });
    const { registry } = createKitHarness(invoke);
    registry.activate(snapshots);
    return { page: registry.getSettingsPages().find((entry) => entry.id === "snapshots.settings")!, invoke };
  }

  it("turns the shortcut on, states each permission and asks macOS for a missing one", async () => {
    const { page, invoke } = settingsPage({ supported: true, screen: "granted", accessibility: "not-determined" });
    const { updates } = renderKitSettingsPage(page.Component);
    fireEvent.click(await screen.findByRole("switch", { name: "Capture with a global shortcut" }));
    await waitFor(() => expect(updates).toContainEqual({ options: { [`${ID}.${SETTING_ENABLED}`]: true } }));
    expect(await screen.findByText("Allowed")).toBeTruthy();
    expect(screen.getByText("Not asked yet")).toBeTruthy();
    // Only the permission still missing offers its buttons.
    expect(screen.getAllByRole("button", { name: "Open System Settings" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Ask the system" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(ID, "request-access", { kind: "accessibility" }));
    expect(missingSettingsRows(page)).toEqual([]);
  });

  it("says what it needs where macOS is not there", async () => {
    const { page } = settingsPage({ supported: false, screen: "unavailable", accessibility: "unavailable" });
    renderKitSettingsPage(page.Component);
    expect(await screen.findByText("SnapShots are unavailable")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });
  it("offers explicit Wayland source selection without a macOS permission prompt", async () => {
    const { page, invoke } = settingsPage({ supported: true, captureMode: "picker", screen: "not-determined", accessibility: "unavailable" });
    renderKitSettingsPage(page.Component);
    const choose = await screen.findByRole("button", { name: "Choose a window or display" });
    expect(invoke).not.toHaveBeenCalledWith(ID, "capture", expect.anything());
    expect(screen.queryByRole("button", { name: "Ask the system" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open System Settings" })).toBeNull();
    fireEvent.click(choose);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(ID, "capture", { accessibility: false }));
    expect(await screen.findByText("Capture saved for your draft.")).toBeTruthy();
  });

});
