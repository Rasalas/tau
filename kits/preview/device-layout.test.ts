import { describe, expect, it, vi } from "vitest";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { DeviceLayout, VIEWER_STALE_MS, readPreviewViewer, type DeviceLayoutTimers, type PreviewDeviceMetrics } from "./device-layout.js";
import { EMPTY_PREVIEW_STATE, PREVIEW_HOST_EXTENSION_ID, type PreviewState, type PreviewViewer } from "./protocol.js";
import { createPreviewHostExtension, type PreviewRect, type PreviewSurface } from "./host.js";

const phone: PreviewViewer = { id: "phone-1", width: 393, height: 640, dpr: 3, touch: true };
const tablet: PreviewViewer = { id: "tablet-1", width: 820, height: 1_100, dpr: 2, touch: true };

function manualTimers(): DeviceLayoutTimers & { fire(): void; pending(): number } {
  let next: (() => void) | undefined;
  return {
    set: (run) => { next = run; return run; },
    clear: (handle) => { if (handle === next) next = undefined; },
    fire: () => { const run = next; next = undefined; run?.(); },
    pending: () => (next ? 1 : 0),
  };
}

describe("a device's description", () => {
  it("keeps sizes within what a viewport can be and refuses anything without an id or a size", () => {
    expect(readPreviewViewer({ id: "a_b-1", width: 392.6, height: 10, dpr: 9, touch: true })).toEqual({ id: "a_b-1", width: 393, height: 200, dpr: 4, touch: true });
    expect(readPreviewViewer({ id: "x", width: 800, height: 600 })).toEqual({ id: "x", width: 800, height: 600, dpr: 1, touch: false });
    expect(readPreviewViewer({ id: "no spaces", width: 800, height: 600 })).toBeUndefined();
    expect(readPreviewViewer({ id: "x", width: 0, height: 600 })).toBeUndefined();
    expect(readPreviewViewer(undefined)).toBeUndefined();
  });
});

describe("whose screen the page is laid out for", () => {
  it("goes to a watching device only while the host window does not show the page", () => {
    const changed = vi.fn();
    const layout = new DeviceLayout(changed, manualTimers());
    layout.watch(phone, "Phone", true);
    expect(layout.owner()).toBeUndefined();
    layout.watch(phone, "Phone", false);
    expect(layout.owner()).toEqual({ id: "phone-1", name: "Phone", width: 393, height: 640, touch: true });
    expect(changed).toHaveBeenCalledTimes(1);
    // The same device asking again changes nothing; a new size does.
    layout.watch(phone, "Phone", false);
    expect(changed).toHaveBeenCalledTimes(1);
    layout.watch({ ...phone, width: 640, height: 393 }, "Phone", true);
    expect(layout.metrics()).toEqual({ width: 640, height: 393, dpr: 3, touch: true });
  });

  it("leaves it with the device that has it while another only watches, and hands it over when asked", () => {
    const layout = new DeviceLayout(() => undefined, manualTimers());
    layout.watch(phone, "Phone", false);
    layout.watch(tablet, "Tablet", false);
    expect(layout.owner()?.id).toBe("phone-1");
    layout.claim(tablet, "Tablet");
    expect(layout.owner()?.id).toBe("tablet-1");
    // A device that closed its view only gives back what it still has.
    layout.release("phone-1");
    expect(layout.owner()?.id).toBe("tablet-1");
    layout.release();
    expect(layout.owner()).toBeUndefined();
  });

  it("gives the page back to the host window once the device stops asking", () => {
    const timers = manualTimers();
    const changed = vi.fn();
    const layout = new DeviceLayout(changed, timers);
    const set = vi.spyOn(timers, "set");
    layout.watch(phone, "Phone", false);
    expect(set).toHaveBeenLastCalledWith(expect.any(Function), VIEWER_STALE_MS);
    timers.fire();
    expect(layout.owner()).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(timers.pending()).toBe(0);
  });
});

describe("the page laid out for a device", () => {
  async function activate() {
    let url = "";
    const places: Array<{ rect: PreviewRect; visible: boolean; device?: PreviewDeviceMetrics }> = [];
    const zooms: number[] = [];
    const surface: PreviewSurface = {
      zoomFactor: () => 1,
      place: (rect, visible, device) => { places.push({ rect, visible, ...(device ? { device } : {}) }); },
      load: async (next) => { url = next; },
      navigate: () => undefined,
      setZoom: (factor) => { zooms.push(factor); },
      setAppearance: async () => undefined,
      state: () => ({ ...EMPTY_PREVIEW_STATE, url, title: "Shop" }),
      viewport: () => ({ width: 393, height: 640 }),
      evaluate: async () => "none",
      capture: async (maxWidth) => ({ base64: "JPEG", width: maxWidth, height: maxWidth }),
      record: async () => ({ chunks: [], mimeType: "video/webm" }),
      pressKey: () => undefined,
      destroy: () => undefined,
    };
    const devices = [{ id: "c1", name: "Alex's phone", access: "full" as const }, { id: "c2", name: "Kitchen tablet", access: "read-only" as const }];
    const registry = await activateHostKit(createPreviewHostExtension(async () => surface), {
      stateDir: "",
      registerRuntimeExtension: () => () => undefined,
      registerTurnObserver: () => () => undefined,
      clients: { observe: () => () => undefined, count: () => 1, devices: () => devices },
    });
    const invoke = (command: string, input?: unknown, principal?: Parameters<typeof registry.invoke>[3]) => registry.invoke(PREVIEW_HOST_EXTENSION_ID, command, input, principal);
    await invoke("open", { url: "http://localhost:5173/" });
    const state = async () => await invoke("state") as PreviewState;
    return { invoke, places, zooms, state };
  }
  const paired = (id: string, readOnly = false): { kind: "workbench-client"; connection: string; pairedClient: string; readOnly?: true } =>
    ({ kind: "workbench-client", connection: id, pairedClient: id, ...(readOnly ? { readOnly: true as const } : {}) });
  const dock = { x: 900, y: 80, width: 393, height: 700 };

  it("lays the page out for a phone while the host window shows Settings, and gives it back when the window shows the page", async () => {
    const { invoke, places, zooms, state } = await activate();
    await invoke("bounds", { ...dock, visible: false });
    await invoke("live-frame", { maxWidth: 786, viewer: phone }, paired("c1"));
    expect(places.at(-1)).toEqual({ rect: dock, visible: false, device: { width: 393, height: 640, dpr: 3, touch: true } });
    expect(zooms.at(-1)).toBe(1);
    await expect(state()).resolves.toMatchObject({ layoutFor: { id: "phone-1", name: "Alex's phone", width: 393, height: 640 } });

    await invoke("bounds", { ...dock, visible: true });
    expect(places.at(-1)).toEqual({ rect: dock, visible: true });
    expect((await state()).layoutFor).toBeUndefined();
  });

  it("never changes the page's layout under the host window by itself, but does when the device's user asks", async () => {
    const { invoke, places, state } = await activate();
    await invoke("bounds", { ...dock, visible: true });
    await invoke("live-frame", { maxWidth: 786, viewer: phone }, paired("c1"));
    expect(places.every((place) => !place.device)).toBe(true);

    await invoke("layout", { viewer: phone }, paired("c1"));
    expect(places.at(-1)).toMatchObject({ visible: true, device: { width: 393 } });
    // Resizing the dock keeps the device's layout; the window takes it back from its note.
    await invoke("bounds", { ...dock, width: 420, visible: true });
    expect(places.at(-1)?.device).toBeDefined();
    await invoke("layout", {});
    expect(places.at(-1)?.device).toBeUndefined();
    expect((await state()).layoutFor).toBeUndefined();
  });

  it("lets a Read-only device watch at the page's layout, never set its own", async () => {
    const { invoke, places } = await activate();
    await invoke("bounds", { ...dock, visible: false });
    await expect(invoke("live-frame", { maxWidth: 786, viewer: tablet }, paired("c2", true))).resolves.toMatchObject({ width: 786 });
    await expect(invoke("layout", { viewer: tablet }, paired("c2", true))).rejects.toThrow();
    expect(places.every((place) => !place.device)).toBe(true);
  });

  it("keeps a fixed viewport somebody chose", async () => {
    const { invoke, places, state } = await activate();
    await invoke("bounds", { ...dock, visible: false });
    await invoke("viewport", { mode: "fixed", width: 1_280, height: 800 });
    await invoke("live-frame", { maxWidth: 786, viewer: phone }, paired("c1"));
    expect(places.every((place) => !place.device)).toBe(true);
    await expect(invoke("layout", { viewer: phone }, paired("c1"))).rejects.toThrow(/fixed viewport/u);
    expect((await state()).layoutFor).toBeUndefined();
  });

  it("gives the page back when the device closes its view", async () => {
    const { invoke, places } = await activate();
    await invoke("bounds", { ...dock, visible: false });
    await invoke("live-frame", { maxWidth: 786, viewer: phone }, paired("c1"));
    await invoke("layout", { release: "tablet-1" }, paired("c1"));
    expect(places.at(-1)?.device).toBeDefined();
    await invoke("layout", { release: "phone-1" }, paired("c1"));
    expect(places.at(-1)?.device).toBeUndefined();
  });
});
