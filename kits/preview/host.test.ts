import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { GlobalHostEvent, RuntimeExtensionContribution } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { EMPTY_PREVIEW_STATE, PREVIEW_HOST_EXTENSION_ID, type PreviewRecording, type PreviewState } from "./protocol.js";
import {
  createPreviewHostExtension,
  normalizePreviewUrl,
  previewRect,
  previewVisible,
  readPreviewBounds,
  type PreviewRect,
  type PreviewSurface,
  type PreviewSurfaceOptions,
} from "./host.js";

function fakeSurface(overrides: Partial<PreviewSurface> = {}) {
  const placed: Array<{ rect: PreviewRect; visible: boolean }> = [];
  const loaded: string[] = [];
  const evaluated: string[] = [];
  const surface: PreviewSurface = {
    zoomFactor: () => 1,
    place: (rect, visible) => { placed.push({ rect, visible }); },
    load: async (url) => { loaded.push(url); },
    navigate: () => undefined,
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

/** Activates the kit and returns its Pi tools, as a thread's runtime would see them. */
async function activate(createSurface: (options: PreviewSurfaceOptions) => Promise<PreviewSurface | undefined>, cwd = "/project", stateDir = "/state") {
  const events: GlobalHostEvent[] = [];
  const runtimeExtensions: RuntimeExtensionContribution[] = [];
  const registry = await activateHostKit(createPreviewHostExtension(createSurface), {
    stateDir,
    findCommand: () => undefined,
    noteSubprocess: () => undefined,
    registerRuntimeExtension: (name: string, factory: RuntimeExtensionContribution["factory"]) => {
      runtimeExtensions.push({ name, factory });
      return () => undefined;
    },
  }, (event) => events.push(event));
  const context = { registry, events, runtimeExtensions };
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
    expect(normalizePreviewUrl("127.0.0.1:9877", "/project")).toBe("http://127.0.0.1:9877/");
    expect(normalizePreviewUrl(" https://example.com/a ", "/project")).toBe("https://example.com/a");
    expect(normalizePreviewUrl("/project/dist/index.html", "/project")).toBe("file:///project/dist/index.html");
    expect(normalizePreviewUrl("about:blank", "/project")).toBe("about:blank");
    expect(() => normalizePreviewUrl("javascript:alert(1)", "/project")).toThrow(/http, https and workspace files/u);
    expect(() => normalizePreviewUrl("file:///etc/passwd", "/project")).toThrow(/inside the workspace/u);
    expect(() => normalizePreviewUrl("/etc/passwd", "")).toThrow(/inside the workspace/u);
    expect(() => normalizePreviewUrl("", "/project")).toThrow(/needs a URL/u);
  });
});

describe("preview tools", () => {
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
    expect(evaluated.at(-1)).toContain('{"selector":"input[name=q]"}, "hello", true');
  });

  it("reports what the page said about an element it could not find", async () => {
    const { surface } = fakeSurface({ evaluate: async () => ({ ok: false, error: "No element matched." }) });
    const kit = await activate(async () => surface);
    expect((await kit.text("preview_click", { selector: "#gone" })).text).toBe("click failed: No element matched.");
  });

  it("says what is missing when the host has no window", async () => {
    const kit = await activate(async () => undefined);
    for (const tool of ["preview_open", "preview_status", "preview_snapshot", "preview_screenshot"]) {
      const answer = await kit.text(tool, { url: "https://example.com" });
      expect(answer.text).toBe("Preview needs the Tau desktop app on this host");
      expect(answer.isError).toBe(true);
    }
    await expect(kit.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "state", undefined))
      .resolves.toMatchObject({ available: false, url: "" });
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
});

describe("profiles", () => {
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
    expect(profiles).toEqual({ profiles: ["default", "logged-in"], active: "logged-in" });
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
