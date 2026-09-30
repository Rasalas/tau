import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostTurnObserver, RuntimeExtensionContribution } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { EMPTY_PREVIEW_STATE, PREVIEW_HOST_EXTENSION_ID, type PreviewAppearance, type PreviewState } from "./protocol.js";
import { agentAction, createPreviewHostExtension, type PreviewRect, type PreviewSurface } from "./host.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function surface() {
  let url = "";
  const placed: PreviewRect[] = [];
  const zooms: number[] = [];
  const appearances: PreviewAppearance[] = [];
  const evaluated: Array<{ expression: string; isolated: boolean }> = [];
  const records: Array<{ action: string; frameRate?: number }> = [];
  const captures: boolean[] = [];
  const navigations: string[] = [];
  const fake: PreviewSurface = {
    zoomFactor: () => 1,
    place: (rect) => { placed.push(rect); },
    load: async (next) => { url = next; },
    navigate: (action) => { navigations.push(action); },
    setZoom: (factor) => { zooms.push(factor); },
    setAppearance: async (appearance) => { appearances.push(appearance); },
    state: () => ({ ...EMPTY_PREVIEW_STATE, url, title: "Fixture" }),
    viewport: () => ({ width: 800, height: 600 }),
    evaluate: async (expression, isolated) => {
      evaluated.push({ expression, isolated: isolated === true });
      return { ok: true, detail: "done", point: { x: 400, y: 150 }, viewport: { width: 800, height: 600 } };
    },
    capture: async (_width, _rect, jpeg) => { captures.push(jpeg === true); return { base64: "SlBH", width: 640, height: 480 }; },
    record: async (action, options) => { records.push({ action, ...(options?.frameRate ? { frameRate: options.frameRate } : {}) }); return { chunks: [], mimeType: "video/webm" }; },
    pressKey: () => undefined,
    destroy: () => undefined,
  };
  return { fake, placed, zooms, appearances, evaluated, records, captures, navigations };
}

interface FakeConfig {
  settings: (cwd?: string) => { options: Record<string, boolean>; values: Record<string, string> };
  changed?: (change: { kind: string; paths: readonly string[] }) => void;
  workspace?: (cwd: string) => Promise<void>;
}

async function activate(made = surface(), config?: FakeConfig) {
  const stateDir = await mkdtemp(join(tmpdir(), "tau-preview-extras-"));
  directories.push(stateDir);
  const runtimeExtensions: RuntimeExtensionContribution[] = [];
  const observers: HostTurnObserver[] = [];
  const cleared: string[] = [];
  const registry = await activateHostKit(createPreviewHostExtension(async () => made.fake, undefined, async (partition) => { cleared.push(partition); }), {
    stateDir,
    findCommand: () => undefined,
    noteSubprocess: () => undefined,
    registerTurnObserver: (observer) => { observers.push(observer); return () => undefined; },
    registerRuntimeExtension: (name: string, factory: RuntimeExtensionContribution["factory"]) => {
      runtimeExtensions.push({ name, factory });
      return () => undefined;
    },
    ...(config ? {
      settings: (async (_id: string, cwd?: string) => config.settings(cwd)) as never,
      observeConfigChanges: (listener) => { config.changed = listener; return () => undefined; },
      registerThreadLifecycle: (lifecycle) => { config.workspace = lifecycle.beforeWorkspace; return () => undefined; },
    } : {}),
  });
  const toolsOf = (sessionId: string) => {
    const tools: ToolDefinition[] = [];
    runtimeExtensions[0]!.factory({ registerTool: (tool: ToolDefinition) => tools.push(tool) } as never, { sessionId, cwd: "/project" });
    return async (name: string, params: unknown = {}) => {
      const result = await tools.find((tool) => tool.name === name)!.execute("call", params as never, undefined, undefined, {} as never);
      return { text: result.content.map((part) => part.type === "text" ? part.text : "").join("\n"), isError: (result as { isError?: boolean }).isError === true };
    };
  };
  const invoke = (command: string, input?: unknown) => registry.invoke(PREVIEW_HOST_EXTENSION_ID, command, input);
  const state = async () => await invoke("state") as PreviewState;
  return { ...made, registry, observers, cleared, toolsOf, invoke, state };
}

describe("the page's zoom, viewport and appearance", () => {
  it("resizes to a device and sets the colour scheme through the agent's tools", async () => {
    const kit = await activate();
    const call = kit.toolsOf("t1");
    await call("preview_open", { url: "http://localhost:3000" });
    await kit.invoke("bounds", { x: 0, y: 0, width: 400, height: 1000, visible: true });
    const resized = await call("preview_resize", { mode: "preset", preset: "iphone-se" });
    expect(resized.text).toContain("Viewport: iPhone SE · 375×667");
    expect(kit.placed.at(-1)).toEqual({ x: 12, y: 0, width: 375, height: 667 });
    expect(kit.zooms.at(-1)).toBe(1);
    expect((await call("preview_resize", { mode: "fixed", width: 50, height: 50 })).isError).toBe(true);
    expect((await call("preview_set_appearance", { colorScheme: "dark" })).text).toBe("Appearance: dark.");
    expect(kit.appearances).toEqual(["dark"]);
    await expect(kit.state()).resolves.toMatchObject({ viewport: { mode: "fixed", width: 375 }, appearance: "dark" });
  });

  it("zooms by the page's chords and by command, and reloads by ⌘R", async () => {
    const kit = await activate();
    await kit.invoke("open", { url: "http://localhost:3000" });
    await kit.invoke("view-chord", { chord: "zoom-in" });
    await kit.invoke("view-chord", { chord: "zoom-in" });
    await expect(kit.state()).resolves.toMatchObject({ zoom: 1.25 });
    expect(kit.zooms.at(-1)).toBe(1.25);
    await kit.invoke("zoom", { step: "reset" });
    expect(kit.zooms.at(-1)).toBe(1);
    await kit.invoke("view-chord", { chord: "hard-reload" });
    expect(kit.navigations).toEqual(["hard-reload"]);
    await expect(kit.invoke("view-chord", { chord: "print" })).rejects.toThrow(/Unknown preview chord/u);
    await expect(kit.invoke("zoom", { factor: "big" })).rejects.toThrow(/step/u);
  });

  it("opens with the defaults from Settings, and keeps what was set for the page when they change", async () => {
    const kit = await activate();
    await kit.invoke("defaults", { viewport: "fill", zoom: "1.5", appearance: "light", recording: { frameRate: "60" } });
    await kit.invoke("open", { url: "http://localhost:3000" });
    expect(kit.appearances).toEqual(["light"]);
    await expect(kit.state()).resolves.toMatchObject({ zoom: 1.5, appearance: "light" });
    await kit.invoke("zoom", { step: "in" });
    await kit.invoke("defaults", { viewport: "fill", zoom: "2", appearance: "dark" });
    await expect(kit.state()).resolves.toMatchObject({ zoom: 1.75, appearance: "dark" });
    await kit.invoke("record-start");
    expect(kit.records[0]).toEqual({ action: "start", frameRate: 30 });
  });
});

describe("defaults from the host's config", () => {
  it("reads them itself at start, per workspace and after a change, so no client has to send its own", async () => {
    let zoom = "1.5";
    const config: FakeConfig = { settings: (cwd) => ({ values: { "default-zoom": cwd === "/other" ? "2" : zoom, "default-appearance": "dark" }, options: { "recording-keys": true } }) };
    const kit = await activate(surface(), config);
    await expect(kit.invoke("current-defaults")).resolves.toMatchObject({ zoom: 1.5, appearance: "dark", recording: { showKeys: true } });
    await expect(kit.state()).resolves.toMatchObject({ zoom: 1.5 });

    zoom = "1.25";
    config.changed?.({ kind: "config", paths: [] });
    await vi.waitFor(() => expect(kit.invoke("current-defaults")).resolves.toMatchObject({ zoom: 1.25 }));

    await config.workspace?.("/other");
    await expect(kit.invoke("current-defaults")).resolves.toMatchObject({ zoom: 2 });
  });
});

describe("the agent's cursor and the recording overlay", () => {
  it("draws the cursor in the page's isolated world where a click landed", async () => {
    const kit = await activate();
    const call = kit.toolsOf("t1");
    await call("preview_open", { url: "http://localhost:3000" });
    await call("preview_click", { text: "Save" });
    const cursor = kit.evaluated.at(-1)!;
    expect(cursor.isolated).toBe(true);
    expect(cursor.expression).toContain('"x":0.5,"y":0.25');
    expect(cursor.expression).toContain('"kind":"click"');
  });

  it("masks text typed into a password field", () => {
    expect(agentAction("a", "type", { ok: true, sensitive: true, point: { x: 1, y: 1 } }, { text: "hunter2" }).text).toBe("•••••••");
    expect(agentAction("b", "type", { ok: true }, { text: "hello" }).text).toBe("hello");
    expect(agentAction("c", "key", { ok: true }, { key: "Enter" })).toMatchObject({ kind: "key", keys: ["Enter"] });
    expect(agentAction("d", "click", { ok: false })).toMatchObject({ status: "failed" });
  });

  it("puts the input overlay on the page for a recording and takes it off again", async () => {
    const kit = await activate();
    const call = kit.toolsOf("t1");
    await call("preview_open", { url: "http://localhost:3000" });
    expect((await call("preview_recording_start")).text).toContain("Recording the preview of http://localhost:3000/");
    expect(kit.evaluated.some(({ expression, isolated }) => isolated && expression.includes("tauInputOverlay") && expression.includes('"keys":false'))).toBe(true);
    const stopped = await call("preview_recording_stop");
    expect(stopped.text).toMatch(/^Recording saved: .*\.webm/u);
    expect(kit.evaluated.at(-1)!.expression).toContain("previewInputOverlayEnd");
    expect((await call("preview_recording_stop")).isError).toBe(true);
  });
});

describe("the floating preview's driver", () => {
  it("follows the thread whose agent uses the page or a window, until its turn ends", async () => {
    const kit = await activate();
    await kit.toolsOf("t1")("preview_open", { url: "http://localhost:3000" });
    await expect(kit.state()).resolves.toMatchObject({ driver: { threadId: "t1", source: "browser" } });
    await kit.invoke("mini-dismiss");
    await expect(kit.state()).resolves.toMatchObject({ driver: { dismissed: true } });
    kit.observers[0]!.toolEnded!("t2", { id: "x", name: "computer_use_click", args: {}, status: "done", startedAt: 0 }, "/project");
    await expect(kit.state()).resolves.toMatchObject({ driver: { threadId: "t2", source: "screen" } });
    kit.observers[0]!.toolEnded!("t3", { id: "y", name: "bash", args: {}, status: "done", startedAt: 0 }, "/project");
    await kit.observers[0]!.ended!("t1", "turn", "completed");
    await expect(kit.state()).resolves.toMatchObject({ driver: { threadId: "t2" } });
    await kit.observers[0]!.ended!("t2", "turn", "completed");
    expect((await kit.state()).driver).toBeUndefined();
  });

  it("remembers the player's corner and hands out small JPEGs of the page", async () => {
    const kit = await activate();
    await expect(kit.invoke("mini-frame")).resolves.toBeNull();
    await kit.invoke("open", { url: "http://localhost:3000" });
    await expect(kit.invoke("mini-frame")).resolves.toEqual({ data: "SlBH", width: 640, height: 480 });
    expect(kit.captures).toEqual([true]);
    await expect(kit.invoke("mini-prefs", { corner: "top-left" })).resolves.toMatchObject({ mini: { corner: "top-left", width: 280 } });
  });
});

describe("profiles and recent pages", () => {
  it("renames a profile, and deleting it clears its partition and moves the page to the default", async () => {
    const kit = await activate();
    await kit.invoke("open", { url: "http://localhost:3000" });
    await kit.invoke("use-profile", { name: "Work" });
    await expect(kit.invoke("rename-profile", { id: "work", name: "Staging login" })).resolves.toMatchObject({ names: { work: "Staging login" } });
    await expect(kit.invoke("rename-profile", { id: "default", name: "staging login" })).rejects.toThrow(/already called/u);
    const deleted = await kit.invoke("delete-profile", { id: "work" });
    expect(deleted).toEqual({ profiles: ["default"], active: "default" });
    expect(kit.cleared).toEqual(["persist:tau-preview-work"]);
    await expect(kit.invoke("delete-profile", { id: "default" })).rejects.toThrow(/cannot be deleted/u);
  });

  it("lists the pages shown, newest first, and forgets one", async () => {
    const kit = await activate();
    await kit.invoke("open", { url: "http://localhost:3000/a" });
    await kit.invoke("open", { url: "http://localhost:3000/b" });
    const listed = await kit.invoke("history") as Array<{ url: string }>;
    expect(listed.map((entry) => entry.url)).toEqual(["http://localhost:3000/b", "http://localhost:3000/a"]);
    const left = await kit.invoke("forget", { url: "http://localhost:3000/b" }) as Array<{ url: string }>;
    expect(left.map((entry) => entry.url)).toEqual(["http://localhost:3000/a"]);
    vi.restoreAllMocks();
  });
});

describe("a page the user holds", () => {
  it("puts the password note on the page and on the next one, and takes it off at the end", async () => {
    const kit = await activate();
    await kit.invoke("open", { url: "http://localhost:3000/login" });
    const notes = () => kit.evaluated.filter((entry) => entry.expression.includes("secret-note"));
    await kit.invoke("hold", { on: true });
    expect(notes().map((entry) => [entry.isolated, entry.expression.endsWith("(true)")])).toEqual([[true, true]]);
    await kit.invoke("open", { url: "http://localhost:3000/next" });
    expect(notes()).toHaveLength(2);
    await kit.invoke("hold", { on: false });
    expect(notes().at(-1)?.expression.endsWith("(false)")).toBe(true);
    await kit.invoke("open", { url: "http://localhost:3000/after" });
    expect(notes()).toHaveLength(3);
  });
});
