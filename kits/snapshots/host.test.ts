import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createSnapShotsHostExtension, decodeCapture } from "./host.js";
import { CAPTURED_COMMAND, SHORTCUT_EVENT, SNAPSHOTS_EXTENSION_ID, SNAPSHOT_EVENT, SNAPSHOT_FAILED_EVENT, type SnapShotCapture, type SnapShotMeta } from "./protocol.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
const capture: SnapShotCapture = {
  app: "Electron", title: "E18 test window", pid: 42, capturedAt: Date.now(),
  image: { data: PNG, mimeType: "image/png", width: 2, height: 1 },
  accessibility: { imageSize: { width: 2, height: 1 }, truncated: false, nodes: 1, root: { role: "window", children: [] } },
};

async function activate(window: (command: string, input?: unknown) => unknown = () => undefined) {
  const stateDir = await mkdtemp(join(tmpdir(), "tau-snapshots-host-"));
  directories.push(stateDir);
  const events: PublishedKitEvent[] = [];
  const calls: Array<{ command: string; input: unknown }> = [];
  const callClient = vi.fn(async (_extensionId: string, command: string, input?: unknown) => {
    calls.push({ command, input });
    return window(command, input);
  });
  const registry = await activateHostKit(createSnapShotsHostExtension(), { stateDir, callClient: callClient as never }, (event) => events.push(event));
  const invoke = (command: string, input?: unknown) => registry.invoke(SNAPSHOTS_EXTENSION_ID, command, input);
  return { registry, invoke, events, calls, stateDir };
}

describe("SnapShots host half", () => {
  it("captures through the window half, keeps the capture and tells the clients", async () => {
    const { invoke, events, calls } = await activate((command) => command === "capture" ? capture : undefined);
    const meta = await invoke("capture", { target: { windowId: 35210, pid: 59103 } }) as SnapShotMeta;

    expect(calls).toEqual([{ command: "capture", input: { target: { windowId: 35210, pid: 59103 }, accessibility: true } }]);
    expect(meta).toMatchObject({ app: "Electron", title: "E18 test window", claimed: false });
    expect(events.filter((event) => event.name === SNAPSHOT_EVENT).map((event) => (event.payload as SnapShotMeta).id)).toEqual([meta.id]);
    expect(await invoke("pending")).toEqual([meta]);

    expect(await invoke("claim", { id: meta.id })).toMatchObject({ claimed: true });
    expect(await invoke("claim", { id: meta.id })).toBeNull();
    expect(await invoke("pending")).toEqual([]);
    expect(await invoke("read", { id: meta.id })).toMatchObject({ data: PNG, accessibility: { root: { role: "window" } } });
    await invoke("release", { ids: [meta.id] });
    expect(await invoke("read", { id: meta.id })).toBeNull();
    expect(await invoke("meta", { ids: [meta.id] })).toEqual([null]);
  });

  it("stores what the shortcut captured and reports what it could not", async () => {
    const { invoke, events } = await activate();
    await invoke(CAPTURED_COMMAND, { capture });
    await invoke(CAPTURED_COMMAND, { error: "Tau may not record windows yet." });
    await invoke(CAPTURED_COMMAND, { capture: { ...capture, image: { ...capture.image, mimeType: "image/gif" } } });

    expect(events.map((event) => event.name)).toEqual([SNAPSHOT_EVENT, SNAPSHOT_FAILED_EVENT, SNAPSHOT_FAILED_EVENT]);
    expect(events[1]!.payload).toEqual({ message: "Tau may not record windows yet." });
  });

  it("arms the shortcut in the window, reports its state, and drops it when the kit goes", async () => {
    const { registry, invoke, events, calls } = await activate((command, input) => command === "shortcut"
      ? ((input as { accelerator: string | null }).accelerator ? { registered: (input as { accelerator: string }).accelerator } : {})
      : undefined);

    expect(await invoke("arm", { accelerator: "CommandOrControl+Shift+2", accessibility: false })).toEqual({ registered: "CommandOrControl+Shift+2" });
    expect(calls.at(-1)).toEqual({ command: "shortcut", input: { accelerator: "CommandOrControl+Shift+2", accessibility: false } });
    expect(events.at(-1)).toMatchObject({ name: SHORTCUT_EVENT, payload: { registered: "CommandOrControl+Shift+2" } });
    expect(await invoke("shortcut-state")).toEqual({ registered: "CommandOrControl+Shift+2" });
    expect(await invoke("armed")).toEqual({ accelerator: "CommandOrControl+Shift+2", accessibility: false });

    await registry.deactivate(SNAPSHOTS_EXTENSION_ID);
    expect(calls.at(-1)).toEqual({ command: "shortcut", input: { accelerator: null, accessibility: false } });
  });

  it("says SnapShots are unavailable where no window half answers", async () => {
    const { invoke } = await activate(() => { throw new Error("no window"); });
    expect(await invoke("access")).toEqual({ supported: false, screen: "unavailable", accessibility: "unavailable" });
    expect(await invoke("arm", { accelerator: "CommandOrControl+Shift+2", accessibility: true })).toEqual({ error: "no window" });
    expect(await invoke("armed")).toBeNull();
    await expect(invoke("request-access", { kind: "microphone" })).rejects.toThrow(/screen or accessibility/u);
  });

  it("refuses a capture without a proper picture", () => {
    expect(() => decodeCapture({ ...capture, image: { ...capture.image, data: "" } })).toThrow(/no picture/u);
    expect(() => decodeCapture({ ...capture, image: { ...capture.image, width: 0 } })).toThrow(/no size/u);
    expect(decodeCapture({ ...capture, accessibility: "nope", app: "" })).toMatchObject({ app: "Window" });
    expect(decodeCapture({ ...capture, accessibility: "nope" }).accessibility).toBeUndefined();
  });
});
