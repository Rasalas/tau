import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { GlobalHostEvent, HostMcpToolProvider, RuntimeExtensionContribution } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { EMPTY_PREVIEW_STATE, PREVIEW_HOST_EXTENSION_ID, type PreviewRecording, type PreviewState } from "./protocol.js";
import {
  createPreviewHostExtension,
  missingWindow,
  normalizePreviewUrl,
  previewRect,
  previewVisible,
  readPreviewBounds,
  type PreviewRect,
  type PreviewSurface,
  type PreviewSurfaceOptions,
} from "./host.js";

// A Mac with Chrome installed would otherwise count as having a headless fallback.
vi.mock("./headless-surface.js", async (importOriginal) => ({ ...await importOriginal<typeof import("./headless-surface.js")>(), previewBrowserCommand: () => undefined }));

function fakeSurface(overrides: Partial<PreviewSurface> = {}) {
  const placed: Array<{ rect: PreviewRect; visible: boolean }> = [];
  const loaded: string[] = [];
  const evaluated: string[] = [];
  const surface: PreviewSurface = {
    zoomFactor: () => 1,
    place: (rect, visible) => { placed.push({ rect, visible }); },
    load: async (url) => { loaded.push(url); },
    navigate: () => undefined,
    setZoom: () => undefined,
    setAppearance: async () => undefined,
    state: () => ({ ...EMPTY_PREVIEW_STATE, url: loaded.at(-1) ?? "", title: "Fixture" }),
    viewport: () => ({ width: 800, height: 600 }),
    evaluate: async (expression) => { evaluated.push(expression); return { ok: true, detail: "done" }; },
    capture: async () => ({ base64: "UE5H", width: 800, height: 600 }),
    record: async () => ({ chunks: [], mimeType: "video/webm" }),
    pressKey: () => undefined,
    destroy: () => undefined,
    ...overrides,
  };
  return { surface, placed, loaded, evaluated };
}

function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

/** Activates the kit and returns its Pi tools, as a thread's runtime would see them. */
async function activate(createSurface: (options: PreviewSurfaceOptions) => Promise<PreviewSurface | undefined>, cwd = "/project", stateDir = "/state") {
  const events: GlobalHostEvent[] = [];
  const runtimeExtensions: RuntimeExtensionContribution[] = [];
  const mcpProviders: HostMcpToolProvider[] = [];
  const registry = await activateHostKit(createPreviewHostExtension(createSurface), {
    stateDir,
    findCommand: () => undefined,
    noteSubprocess: () => undefined,
    registerTurnObserver: () => () => undefined,
    registerRuntimeExtension: (name: string, factory: RuntimeExtensionContribution["factory"]) => {
      runtimeExtensions.push({ name, factory });
      return () => undefined;
    },
    mcp: { registerTools: (provider: HostMcpToolProvider) => { mcpProviders.push(provider); return () => undefined; }, gate: () => () => undefined, registerInstructions: () => () => undefined, connect: async () => undefined },
  }, (event) => events.push(event));
  const context = { registry, events, runtimeExtensions, mcpProviders };
  const tools: ToolDefinition[] = [];
  runtimeExtensions[0]!.factory({ registerTool: (tool: ToolDefinition) => tools.push(tool) } as never, { sessionId: "s1", cwd });
  const call = async (name: string, params: unknown) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.execute("call-1", params as never, undefined, undefined, {} as never);
  };
  const text = async (name: string, params: unknown = {}) => {
    const result = await call(name, params);
    return {
      text: result.content.map((part) => part.type === "text" ? part.text : `[${part.type}]`).join("\n"),
      isError: (result as { isError?: boolean }).isError === true,
      result,
    };
  };
  return { ...context, tools, call, text };
}

describe("smoke diagnostics routing", () => {
  it("registers only in the smoke environment and forwards no page fields or surface creation", async () => {
    const createSurface = vi.fn(async () => fakeSurface().surface);
    const callClient = vi.fn(async () => ({ available: false }));
    let window: string | undefined = "w1";
    const services = {
      stateDir: "/state",
      registerRuntimeExtension: () => () => undefined,
      registerTurnObserver: () => () => undefined,
      clientWindow: () => window,
      callClient,
    };
    vi.stubEnv("TAU_DISPLAY_SMOKE_DIAGNOSTICS", "0");
    const normal = await activateHostKit(createPreviewHostExtension(createSurface), services);
    try {
      await expect(normal.invoke(PREVIEW_HOST_EXTENSION_ID, "smoke-diagnostics", {})).rejects.toThrow();
      vi.stubEnv("TAU_DISPLAY_SMOKE_DIAGNOSTICS", "1");
      const smoke = await activateHostKit(createPreviewHostExtension(createSurface), services);
      try {
        await expect(smoke.invoke(PREVIEW_HOST_EXTENSION_ID, "smoke-diagnostics", { capturePage: true, url: "secret" })).resolves.toEqual({ available: false });
        expect(callClient).toHaveBeenCalledWith(PREVIEW_HOST_EXTENSION_ID, "smoke-diagnostics", { capturePage: true }, { window: "w1" });
        expect(createSurface).not.toHaveBeenCalled();
        window = undefined;
        callClient.mockClear();
        await expect(smoke.invoke(PREVIEW_HOST_EXTENSION_ID, "smoke-diagnostics", { capturePage: true })).resolves.toEqual({ available: false, windowAttached: false });
        expect(callClient).not.toHaveBeenCalled();
      } finally {
        smoke.deactivate(PREVIEW_HOST_EXTENSION_ID);
      }
    } finally {
      normal.deactivate(PREVIEW_HOST_EXTENSION_ID);
      vi.unstubAllEnvs();
    }
  });
});

describe("preview bounds", () => {
  it("turns the panel's CSS rectangle into window pixels", () => {
    expect(previewRect({ x: 10.4, y: 20.6, width: 300, height: 200, visible: true }, 1)).toEqual({ x: 10, y: 21, width: 300, height: 200 });
    expect(previewRect({ x: 10, y: 20, width: 300, height: 200, visible: true }, 1.25)).toEqual({ x: 13, y: 25, width: 375, height: 250 });
    // A zoom factor the window could not report leaves the rectangle as measured.
    expect(previewRect({ x: 10, y: 20, width: 300, height: 200, visible: true }, 0)).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    expect(previewRect({ x: 0, y: 0, width: -5, height: -5, visible: true }, 2)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("draws nothing for a hidden, collapsed or unmeasured panel", () => {
    expect(previewVisible({ x: 0, y: 0, width: 400, height: 300, visible: true })).toBe(true);
    expect(previewVisible({ x: 0, y: 0, width: 400, height: 300, visible: false })).toBe(false);
    expect(previewVisible({ x: 0, y: 0, width: 0, height: 0, visible: true })).toBe(false);
  });

  it("reads untrusted bounds without trusting a field", () => {
    expect(readPreviewBounds({ x: "10", y: 20, width: Number.NaN, height: 200, visible: "yes" }))
      .toEqual({ x: 0, y: 20, width: 0, height: 200, visible: false });
    expect(readPreviewBounds(undefined)).toEqual({ x: 0, y: 0, width: 0, height: 0, visible: false });
  });
});

describe("preview URLs", () => {
  it("accepts web pages and workspace files, and nothing else", () => {
    expect(normalizePreviewUrl("127.0.0.1:9877", "/project", "darwin")).toBe("http://127.0.0.1:9877/");
    expect(normalizePreviewUrl("localhost:8765/page.html", "/project", "darwin")).toBe("http://localhost:8765/page.html");
    expect(normalizePreviewUrl("localhost:3000", "/project", "darwin")).toBe("http://localhost:3000/");
    expect(normalizePreviewUrl(" https://example.com/a ", "/project", "darwin")).toBe("https://example.com/a");
    expect(normalizePreviewUrl("/project/dist/index.html", "/project", "darwin")).toBe("file:///project/dist/index.html");
    expect(normalizePreviewUrl("about:blank", "/project", "darwin")).toBe("about:blank");
    expect(() => normalizePreviewUrl("javascript:alert(1)", "/project", "darwin")).toThrow(/http, https and workspace files/u);
    expect(() => normalizePreviewUrl("file:///etc/passwd", "/project", "darwin")).toThrow(/inside the workspace/u);
    expect(() => normalizePreviewUrl("/etc/passwd", "", "darwin")).toThrow(/inside the workspace/u);
    expect(() => normalizePreviewUrl("", "/project", "darwin")).toThrow(/needs a URL/u);
  });

  it("opens workspace files by their Windows path, and still only those", () => {
    expect(normalizePreviewUrl("C:\\work\\site\\dist\\index.html", "C:\\work\\site", "win32")).toBe("file:///C:/work/site/dist/index.html");
    expect(normalizePreviewUrl("file:///c:/Work/Site/index.html", "C:\\work\\site", "win32")).toBe("file:///c:/Work/Site/index.html");
    expect(normalizePreviewUrl("localhost:3000", "C:\\work\\site", "win32")).toBe("http://localhost:3000/");
    expect(() => normalizePreviewUrl("C:\\work\\site-other\\index.html", "C:\\work\\site", "win32")).toThrow(/inside the workspace/u);
    expect(() => normalizePreviewUrl("file:///C:/work/site/../secret.html", "C:\\work\\site", "win32")).toThrow(/inside the workspace/u);
    expect(() => normalizePreviewUrl("/work/site/index.html", "C:\\work\\site", "win32")).toThrow(/inside the workspace/u);
  });
});

describe("preview tools", () => {
  it("shares a browser that is still starting between simultaneous tools", async () => {
    let entered!: () => void;
    let release!: () => void;
    const starting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const made = fakeSurface();
    const create = vi.fn(async () => { entered(); await gate; return made.surface; });
    const bench = await activate(create);
    try {
      const first = bench.text("preview_open", { url: "http://localhost:3000" });
      await starting;
      const second = bench.text("preview_open", { url: "http://localhost:3000" });
      release();
      expect((await Promise.all([first, second])).every((result) => !result.isError)).toBe(true);
      expect(create).toHaveBeenCalledTimes(1);
    } finally { release(); await bench.registry.dispose(); }
  });

  it("lets the next tool retry a failed browser start", async () => {
    const made = fakeSurface();
    const create = vi.fn().mockRejectedValueOnce(new Error("Browser could not start")).mockResolvedValue(made.surface);
    const bench = await activate(create);
    try {
      expect((await bench.text("preview_open", { url: "http://localhost:3000" })).isError).toBe(true);
      expect((await bench.text("preview_open", { url: "http://localhost:3000" })).isError).toBe(false);
      expect(create).toHaveBeenCalledTimes(2);
    } finally { await bench.registry.dispose(); }
  });
  it("leaves the tools to tool_search in Pi and lists all of them over MCP", async () => {
    const kit = await activate(async () => fakeSurface().surface);
    expect(kit.tools.length).toBeGreaterThan(10);
    for (const tool of kit.tools) expect(tool).toMatchObject({ exposure: "deferred", namespace: { name: "preview" } });
    const offered = await kit.mcpProviders[0]!({ sessionId: "s1", cwd: "/project" } as never);
    expect(offered.map((tool) => tool.name)).toEqual(kit.tools.map((tool) => tool.name));
    for (const tool of offered) expect(tool.exposure).toBeUndefined();
  });

  it("opens a page, places the view and answers with the page's state", async () => {
    const { surface, placed, loaded } = fakeSurface({ zoomFactor: () => 2 });
    const kit = await activate(async () => surface);
    await kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "bounds", { x: 100, y: 50, width: 400, height: 300, visible: true });
    const opened = await kit.text("preview_open", { url: "127.0.0.1:9877" });
    expect(loaded).toEqual(["http://127.0.0.1:9877/"]);
    expect(opened.text).toContain("url: http://127.0.0.1:9877/");
    expect(opened.text).toContain("viewport: 800×600");
    expect(placed.at(-1)).toEqual({ rect: { x: 200, y: 100, width: 800, height: 600 }, visible: true });
    // The panel learns about the page through one pushed event.
    expect(kit.events.some((event) => event.type === "extension-event" && event.name === "state")).toBe(true);
  });

  it("returns a screenshot as image content beside one line of text", async () => {
    const { surface } = fakeSurface();
    const kit = await activate(async () => surface);
    await kit.call("preview_open", { url: "https://example.com" });
    const shot = await kit.call("preview_screenshot", {});
    expect(shot.content.map((part) => part.type)).toEqual(["text", "image"]);
    expect(shot.content[1]).toEqual({ type: "image", data: "UE5H", mimeType: "image/png" });
  });

  it("refuses arguments that name no element and refs no snapshot minted", async () => {
    const { surface } = fakeSurface();
    const kit = await activate(async () => surface);
    expect((await kit.text("preview_click", {})).text).toContain("Name the element by ref, selector or text.");
    expect((await kit.text("preview_click", { ref: "button#submit" })).text).toContain("not a ref");
    expect((await kit.text("preview_type", { text: "hello" })).text).toContain("Name the element by ref or selector.");
    expect((await kit.text("preview_wait_for", {})).text).toContain("needs text, a selector or urlIncludes");
    expect((await kit.text("preview_evaluate", { expression: "  " })).text).toContain("needs an expression");
    expect((await kit.text("preview_press", { key: " " })).text).toContain("needs a key");
  });

  it("addresses elements by ref and types with the page's own setter", async () => {
    const { surface, evaluated } = fakeSurface();
    const kit = await activate(async () => surface);
    await kit.call("preview_click", { ref: "e3" });
    expect(evaluated.at(-1)).toContain('{"ref":"e3"}');
    await kit.call("preview_type", { selector: "input[name=q]", text: "hello", submit: true });
    // The agent's cursor follows each action into the page.
    expect(evaluated.at(-2)).toContain('{"selector":"input[name=q]"}, "hello", true');
    expect(evaluated.at(-1)).toContain('"label":"hello"');
  });

  it("reports what the page said about an element it could not find", async () => {
    const { surface } = fakeSurface({ evaluate: async () => ({ ok: false, error: "No element matched." }) });
    const kit = await activate(async () => surface);
    expect((await kit.text("preview_click", { selector: "#gone" })).text).toBe("click failed: No element matched.");
  });

  it("reports an asynchronous key delivery failure instead of claiming it was pressed", async () => {
    const { surface } = fakeSurface({ pressKey: async () => { throw new Error("key delivery refused"); } });
    const kit = await activate(async () => surface);
    const result = await kit.text("preview_press", { key: "Enter" });
    expect(result).toMatchObject({ text: "key delivery refused", isError: true });
  });

  it("offers explicit downloads and returns their failures to the agent", async () => {
    const { surface } = fakeSurface({ download: async () => { throw new Error("destination exists"); } });
    const kit = await activate(async () => surface);
    expect(await kit.text("preview_download", { url: "https://example.test/file", destination: "file.txt" }))
      .toMatchObject({ text: "destination exists", isError: true });
  });

  it("says what is missing when the host has no window", async () => {
    const kit = await activate(async () => undefined);
    for (const tool of ["preview_open", "preview_status", "preview_snapshot", "preview_screenshot"]) {
      const answer = await kit.text(tool, { url: "https://example.com" });
      expect(answer.text).toMatch(/Open the Tau desktop app on the thread's home machine/u);
      expect(answer.isError).toBe(true);
    }
    await expect(kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "state", undefined))
      .resolves.toMatchObject({ available: false, url: "" });
  });

  it("says which machine has no window for the page, and forgets it once one says hello", async () => {
    let window: string | undefined;
    const registry = await activateHostKit(createPreviewHostExtension(async (options) => {
      await options.callClient!("open-view");
      return fakeSurface().surface;
    }), {
      stateDir: "/state",
      findCommand: () => undefined,
      noteSubprocess: () => undefined,
      registerTurnObserver: () => () => undefined,
      registerRuntimeExtension: () => () => undefined,
      clientWindow: () => window,
      callClient: async () => {
        if (!window) throw new Error("No Tau window on this host has the window half of tau.preview.");
        return undefined;
      },
    }, () => undefined);
    await expect(registry.invoke(PREVIEW_HOST_EXTENSION_ID, "open", { url: "http://127.0.0.1:1/" })).rejects.toThrow(/Open the Tau desktop app on the thread's home machine/u);
    const missing = await registry.invoke(PREVIEW_HOST_EXTENSION_ID, "state", undefined) as PreviewState;
    // The kind depends on the machine this runs on; that there is none does not.
    expect(missing.noWindow).toBeDefined();
    window = "w1";
    expect(await registry.invoke(PREVIEW_HOST_EXTENSION_ID, "state", undefined)).not.toHaveProperty("noWindow");
    await expect(registry.invoke(PREVIEW_HOST_EXTENSION_ID, "open", { url: "http://127.0.0.1:1/" })).resolves.toMatchObject({ url: "http://127.0.0.1:1/" });
  });

  it("marks a connected window process without a window unavailable until it can draw again", async () => {
    let drawable = false;
    const sent: string[] = [];
    const registry = await activateHostKit(createPreviewHostExtension(async (options) => {
      await options.callClient!("open-view");
      return fakeSurface().surface;
    }), {
      stateDir: "/state",
      registerRuntimeExtension: () => () => undefined,
      registerTurnObserver: () => () => undefined,
      clientWindow: () => "closed-mac-window",
      callClient: async () => {
        sent.push("open-view");
        if (!drawable) throw new Error("This window cannot draw a preview.");
        return undefined;
      },
    }, () => undefined);
    await expect(registry.invoke(PREVIEW_HOST_EXTENSION_ID, "open", { url: "http://127.0.0.1:1/" }))
      .rejects.toThrow(/Open the Tau desktop app on the thread's home machine/u);
    expect(await registry.invoke(PREVIEW_HOST_EXTENSION_ID, "state", undefined)).toHaveProperty("noWindow");
    expect(sent).toEqual(["open-view"]);
    drawable = true;
    await expect(registry.invoke(PREVIEW_HOST_EXTENSION_ID, "open", { url: "http://127.0.0.1:1/" }))
      .resolves.toMatchObject({ url: "http://127.0.0.1:1/" });
    expect(await registry.invoke(PREVIEW_HOST_EXTENSION_ID, "state", undefined)).not.toHaveProperty("noWindow");
  });

  it("stops a tool the runtime cancelled", async () => {
    const { surface } = fakeSurface({ evaluate: () => new Promise(() => undefined) });
    const kit = await activate(async () => surface);
    const controller = new AbortController();
    const tool = kit.tools.find((candidate) => candidate.name === "preview_snapshot")!;
    const pending = tool.execute("call-1", {} as never, controller.signal, undefined, {} as never);
    controller.abort(new Error("The user stopped the run."));
    const result = await pending;
    expect(result.content[0]).toMatchObject({ text: "The user stopped the run." });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

describe("preview tools over MCP", () => {
  it("offers the Pi tools to other runtimes, with the calling thread's workspace for files", async () => {
    const providers: HostMcpToolProvider[] = [];
    const { surface, loaded } = fakeSurface();
    const registry = await activateHostKit(createPreviewHostExtension(async () => surface), {
      stateDir: "/state",
      findCommand: () => undefined,
      noteSubprocess: () => undefined,
      registerTurnObserver: () => () => undefined,
      registerRuntimeExtension: () => () => undefined,
      mcp: {
        registerTools: (provider) => { providers.push(provider); return () => { providers.splice(providers.indexOf(provider), 1); }; },
        gate: () => () => undefined,
        connect: async () => undefined,
      },
    });
    const tools = await providers[0]!({ sessionId: "codex-thread", cwd: "/site" });
    expect(tools.map((tool) => tool.name)).toContain("preview_navigate");
    const open = tools.find((tool) => tool.name === "preview_open")!;
    const result = await open.execute("call-1", { url: "/site/index.html" } as never, undefined, undefined, undefined as never) as { isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(loaded).toEqual(["file:///site/index.html"]);

    await registry.deactivate(PREVIEW_HOST_EXTENSION_ID);
    expect(providers).toEqual([]);
  });
});

describe("preview panel commands", () => {
  it("hides the view instead of destroying it, and destroys it on close", async () => {
    const destroy = vi.fn();
    const { surface, placed } = fakeSurface({ destroy });
    const kit = await activate(async () => surface);
    await kit.call("preview_open", { url: "https://example.com" });
    await kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "bounds", { x: 0, y: 0, width: 400, height: 300, visible: false });
    expect(placed.at(-1)?.visible).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
    await kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "close", undefined);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function stateDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "tau-preview-test-"));
  scratch.push(path);
  return path;
}

const PICKED = {
  url: "http://localhost:8000/",
  title: "Fixture",
  selector: "#save",
  tag: "button",
  text: "Save",
  rect: { x: 40, y: 20, width: 80, height: 30 },
  html: "<button id=\"save\">Save</button>",
  viewport: { width: 800, height: 600 },
};

describe("pick mode", () => {
  it("arms the page, waits for the click and cuts the element out of a capture", async () => {
    const captured: Array<PreviewRect | undefined> = [];
    const isolated: boolean[] = [];
    let polls = 0;
    const { surface } = fakeSurface({
      evaluate: async (expression, inWorld) => {
        isolated.push(inWorld === true);
        if (expression.includes("previewPickPoll")) return ++polls < 2 ? { state: "armed" } : { state: "done", element: PICKED };
        return true;
      },
      capture: async (_maxWidth, rect) => { captured.push(rect); return { base64: "Q1JPUA==", width: 96, height: 46 }; },
    });
    const kit = await activate(async () => surface);
    await kit.call("preview_open", { url: "http://localhost:8000" });
    const picked = await kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "pick", undefined);
    expect(picked).toEqual({ element: PICKED, image: { data: "Q1JPUA==", width: 96, height: 46 } });
    expect(captured).toEqual([{ x: 32, y: 12, width: 96, height: 46 }]);
    // Pick mode runs apart from the page's own scripts.
    expect(isolated.every(Boolean)).toBe(true);
    await expect(kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "state", undefined)).resolves.not.toHaveProperty("mode");
  });

  it("answers null when the user gave up or the page went away", async () => {
    const { surface } = fakeSurface({ evaluate: async (expression) => expression.includes("previewPickPoll") ? { state: "missing" } : true });
    const kit = await activate(async () => surface);
    await kit.call("preview_open", { url: "http://localhost:8000" });
    await expect(kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "pick", undefined)).resolves.toBeNull();
  });

  it("refuses what is not an element and needs a page first", async () => {
    const { surface } = fakeSurface({ evaluate: async (expression) => expression.includes("previewPickPoll") ? { state: "done", element: { tag: 1 } } : true });
    const kit = await activate(async () => surface);
    await expect(kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "pick", undefined)).rejects.toThrow(/Open a page before picking/u);
    await kit.call("preview_open", { url: "http://localhost:8000" });
    await expect(kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "pick", undefined)).rejects.toThrow(/not an element/u);
  });
});

describe("annotate mode", () => {
  it("collects the marks, captures the page with them and takes the layer down", async () => {
    const evaluated: string[] = [];
    const annotations = { url: "http://localhost:8000/", title: "Fixture", viewport: { width: 800, height: 600 }, items: [{ n: 1, kind: "rect", x: 10, y: 10, width: 100, height: 50, note: "too wide" }] };
    const { surface } = fakeSurface({
      evaluate: async (expression) => {
        evaluated.push(expression);
        return expression.includes("previewAnnotateCollect") ? annotations : true;
      },
    });
    const kit = await activate(async () => surface);
    await kit.call("preview_open", { url: "http://localhost:8000" });
    await kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "annotate", { tool: "arrow" });
    expect(evaluated.at(-1)).toMatch(/previewAnnotateStart[\s\S]*\("arrow"\)$/u);
    await expect(kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "state", undefined)).resolves.toMatchObject({ mode: "annotate" });
    const sent = await kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "annotate-send", undefined);
    expect(sent).toEqual({ annotations, image: { data: "UE5H", width: 800, height: 600 } });
    expect(evaluated.at(-1)).toContain("previewAnnotateEnd");
    await expect(kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "annotate", { tool: "circle" })).rejects.toThrow(/rect, arrow or note/u);
  });
});

describe("recording", () => {
  it("removes the recording file when the browser cannot start recording", async () => {
    const stateDir = await stateDirectory();
    const { surface } = fakeSurface({ record: async () => { throw new Error("Recording unsupported"); } });
    const kit = await activate(async () => surface, "/project", stateDir);
    try {
      await kit.call("preview_open", { url: "http://localhost:8000" });
      await expect(kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "record-start")).rejects.toThrow("unsupported");
      expect(await readdir(join(stateDir, PREVIEW_HOST_EXTENSION_ID, "recordings"))).toEqual([]);
    } finally { await kit.registry.dispose(); }
  });
  it("writes the chunks the view hands over into a webm under the kit's state", async () => {
    const stateDir = await stateDirectory();
    const record = vi.fn(async (action: "start" | "take" | "stop") => ({
      chunks: action === "start" ? [] : [Buffer.from(action === "take" ? "one," : "two").toString("base64")],
      mimeType: "video/webm;codecs=vp9",
    }));
    const { surface } = fakeSurface({ record });
    const kit = await activate(async () => surface, "/project", stateDir);
    await kit.call("preview_open", { url: "http://localhost:8000" });
    const started = await kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "record-start", undefined) as PreviewState;
    expect(started.recordingSince).toEqual(expect.any(Number));
    const saved = await kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "record-stop", undefined) as PreviewRecording;
    expect(record.mock.calls.map(([action]) => action)).toEqual(["start", "stop"]);
    expect(saved.path.startsWith(join(stateDir, PREVIEW_HOST_EXTENSION_ID, "recordings", "preview-"))).toBe(true);
    expect(saved).toMatchObject({ mimeType: "video/webm", size: 3 });
    await expect(readFile(saved.path, "utf8")).resolves.toBe("two");
    await expect(kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "record-stop", undefined)).resolves.toBeNull();
  });
  it("names an MP4 recording according to its container", async () => {
    const stateDir = await stateDirectory();
    const { surface } = fakeSurface({ record: async (action) => ({ chunks: action === "stop" ? [Buffer.from("mp4 fixture").toString("base64")] : [], mimeType: "video/mp4" }) });
    const kit = await activate(async () => surface, "/project", stateDir);
    try {
      await kit.call("preview_open", { url: "http://localhost:8000" });
      await kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "record-start");
      const saved = await kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "record-stop") as PreviewRecording;
      expect(saved.name).toMatch(/\.mp4$/u);
      expect(saved).toMatchObject({ mimeType: "video/mp4", size: 11 });
    } finally { await kit.registry.dispose(); }
  });

  it("reports finalization failure and removes the unusable recording", async () => {
    const stateDir = await stateDirectory();
    const { surface } = fakeSurface({ record: async (action) => {
      if (action === "stop") throw new Error("Encoder failed");
      return { chunks: [], mimeType: "video/mp4" };
    } });
    const kit = await activate(async () => surface, "/project", stateDir);
    try {
      await kit.call("preview_open", { url: "http://localhost:8000" });
      await kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "record-start");
      await expect(kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "record-stop")).rejects.toThrow("Encoder failed");
      expect(await readdir(join(stateDir, PREVIEW_HOST_EXTENSION_ID, "recordings"))).toEqual([]);
    } finally { await kit.registry.dispose(); }
  });

  it("finishes a pending start before closing its surface", async () => {
    const stateDir = await stateDirectory();
    const starting = latch(), release = latch();
    const calls: string[] = [];
    const { surface } = fakeSurface({
      record: async (action) => {
        calls.push(action);
        if (action === "start") { starting.release(); await release.wait; }
        return { chunks: [], mimeType: "video/mp4" };
      },
      destroy: () => { calls.push("destroy"); },
    });
    const kit = await activate(async () => surface, "/project", stateDir);
    try {
      await kit.call("preview_open", { url: "http://localhost:8000" });
      const started = kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "record-start");
      await starting.wait;
      const closed = kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "close");
      expect(calls).toEqual(["start"]);
      release.release();
      await Promise.all([started, closed]);
      expect(calls).toEqual(["start", "stop", "destroy"]);
    } finally { release.release(); await kit.registry.dispose(); }
  });

  it.each(["duration", "read error"])("finishes outside its drain queue on %s", async (reason) => {
    const stateDir = await stateDirectory();
    const stopped = latch();
    const record = vi.fn(async (action: "start" | "take" | "stop") => {
      if (action === "take" && reason === "read error") throw new Error("Read failed");
      if (action === "stop") stopped.release();
      return { chunks: action === "stop" ? [Buffer.from("video").toString("base64")] : [], mimeType: "video/webm" };
    });
    const { surface } = fakeSurface({ record });
    const kit = await activate(async () => surface, "/project", stateDir);
    try {
      await kit.call("preview_open", { url: "http://localhost:8000" });
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      await kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "record-start");
      if (reason === "duration") vi.setSystemTime(Date.now() + 10 * 60_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await stopped.wait;
      await kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "close");
      const state = await kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "state") as PreviewState;
      expect(state.recordingSince).toBeUndefined();
      if (reason === "read error") {
        expect(await readdir(join(stateDir, PREVIEW_HOST_EXTENSION_ID, "recordings"))).toEqual([]);
        expect(state.recordingNotice).toContain("Read failed");
      }
    } finally { vi.useRealTimers(); await kit.registry.dispose(); }
  }, 2_000);

});

describe("profiles", () => {
  it("finishes a profile change requested before the first browser opens", async () => {
    const partitions: string[] = [];
    const kit = await activate(async (options) => { partitions.push(options.partition); return fakeSurface().surface; }, "/project", await stateDirectory());
    try {
      const switching = kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "use-profile", { name: "other" });
      const opening = kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "open", { url: "http://localhost:8000" });
      await Promise.all([switching, opening]);
      expect(partitions).toEqual(["persist:tau-preview-other"]);
    } finally { await kit.registry.dispose(); }
  });

  it("retains the page when the profile changes during its first slow navigation", async () => {
    const loading = latch(), finish = latch();
    const browsers: ReturnType<typeof fakeSurface>[] = [];
    const kit = await activate(async () => {
      const browser = fakeSurface();
      browsers.push(browser);
      if (browsers.length === 1) {
        const load = browser.surface.load;
        browser.surface.load = async (url, timeout) => { loading.release(); await finish.wait; await load(url, timeout); };
      }
      return browser.surface;
    }, "/project", await stateDirectory());
    try {
      const opening = kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "open", { url: "http://localhost:8000" });
      await loading.wait;
      const switching = kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "use-profile", { name: "other" });
      finish.release();
      await Promise.all([opening, switching]);
      expect(browsers).toHaveLength(2);
      expect(browsers[1]!.loaded).toEqual(["http://localhost:8000/"]);
    } finally { finish.release(); await kit.registry.dispose(); }
  });

  it("lets a corrected URL replace a navigation that never finishes", async () => {
    const stalled = latch(), started = latch();
    const browser = fakeSurface();
    const load = browser.surface.load;
    browser.surface.load = (url, timeout) => {
      if (!url.includes("typo")) return load(url, timeout);
      started.release();
      return stalled.wait.then(() => load(url, timeout));
    };
    const kit = await activate(async () => browser.surface);
    try {
      const first = kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "open", { url: "http://localhost:8000/typo" });
      await started.wait;
      await kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "open", { url: "http://localhost:8001/" });
      expect(browser.loaded).toEqual(["http://localhost:8001/"]);
      stalled.release();
      await first;
    } finally { stalled.release(); await kit.registry.dispose(); }
  });

  it("waits for concurrent closes before opening the next browser", async () => {
    const stopping = latch(), finish = latch();
    const create = vi.fn(async () => fakeSurface({ destroy: async () => { stopping.release(); await finish.wait; } }).surface);
    const kit = await activate(create);
    try {
      await kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "open", { url: "http://localhost:8000" });
      const first = kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "close");
      await stopping.wait;
      let secondDone = false;
      const second = kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "close").then(() => { secondDone = true; });
      const opening = kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "open", { url: "http://localhost:8000" });
      expect(secondDone).toBe(false);
      expect(create).toHaveBeenCalledTimes(1);
      finish.release();
      await Promise.all([first, second, opening]);
      expect(create).toHaveBeenCalledTimes(2);
    } finally { finish.release(); await kit.registry.dispose(); }
  });
  it("switches the actual browser when the profile changes during startup", async () => {
    let entered!: () => void;
    let release!: () => void;
    const starting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const partitions: string[] = [];
    const destroyed = vi.fn();
    const kit = await activate(async (options) => {
      partitions.push(options.partition);
      if (partitions.length === 1) { entered(); await gate; }
      return fakeSurface({ destroy: destroyed }).surface;
    }, "/project", await stateDirectory());
    try {
      const first = kit.call("preview_open", { url: "http://localhost:8000" });
      await starting;
      const switching = kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "use-profile", { name: "other" });
      release();
      await Promise.all([first, switching]);
      expect(partitions).toEqual(["persist:tau-preview", "persist:tau-preview-other"]);
      expect(destroyed).toHaveBeenCalledTimes(1);
    } finally { release(); await kit.registry.dispose(); }
  });

  it("waits for browser shutdown when the extension is disposed", async () => {
    let entered!: () => void;
    let release!: () => void;
    const stopping = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const kit = await activate(async () => fakeSurface({ destroy: async () => { entered(); await gate; } }).surface);
    await kit.call("preview_open", { url: "http://localhost:8000" });
    let stopped = false;
    const disposing = kit.registry.dispose().then(() => { stopped = true; });
    await stopping;
    expect(stopped).toBe(false);
    release();
    await disposing;
    expect(stopped).toBe(true);
  });
  it("builds the view again in the new profile's partition and reloads the page there", async () => {
    const stateDir = await stateDirectory();
    const partitions: string[] = [];
    const surfaces: Array<ReturnType<typeof fakeSurface>> = [];
    const kit = await activate(async (options) => {
      partitions.push(options.partition);
      const made = fakeSurface();
      surfaces.push(made);
      return made.surface;
    }, "/project", stateDir);
    await kit.call("preview_open", { url: "http://localhost:8000" });
    const profiles = await kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "use-profile", { name: "Logged In" });
    expect(profiles).toEqual({ profiles: ["default", "logged-in"], active: "logged-in", names: { "logged-in": "Logged In" } });
    expect(partitions).toEqual(["persist:tau-preview", "persist:tau-preview-logged-in"]);
    expect(surfaces[1]!.loaded).toEqual(["http://localhost:8000/"]);
    await expect(kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "state", undefined)).resolves.toMatchObject({ profile: "logged-in" });
    await expect(readFile(join(stateDir, PREVIEW_HOST_EXTENSION_ID, "profiles.json"), "utf8")).resolves.toContain("logged-in");
    await expect(kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "use-profile", { name: " ! " })).rejects.toThrow(/needs a name/u);
  });
});

describe("port discovery", () => {
  it("answers no servers on a machine without lsof or netstat", async () => {
    const kit = await activate(async () => undefined);
    await expect(kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "ports", { cwd: "/project" })).resolves.toEqual([]);
  });
});

describe("a machine without a window for the page", () => {
  const facts = { inWindowProcess: false, windowAttached: false, platform: "darwin" as NodeJS.Platform, display: false, callFoundNone: false };

  it("asks for the Tau app on a Mac or PC, and for the display service on Linux without one", () => {
    expect(missingWindow(facts)).toEqual({ displayService: false });
    expect(missingWindow({ ...facts, platform: "win32" })).toEqual({ displayService: false });
    expect(missingWindow({ ...facts, platform: "linux" })).toEqual({ displayService: true });
  });

  it("trusts a Linux display to start its window until a call found none", () => {
    expect(missingWindow({ ...facts, platform: "linux", display: true })).toBeUndefined();
    expect(missingWindow({ ...facts, platform: "linux", display: true, callFoundNone: true })).toEqual({ displayService: false });
  });

  it("says nothing with a window there, inside the window's process, or on a core that cannot tell", () => {
    expect(missingWindow({ ...facts, windowAttached: true })).toBeUndefined();
    expect(missingWindow({ ...facts, inWindowProcess: true })).toBeUndefined();
    expect(missingWindow({ ...facts, windowAttached: undefined })).toBeUndefined();
  });
});
