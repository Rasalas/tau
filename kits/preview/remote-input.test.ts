// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { EMPTY_PREVIEW_STATE, PREVIEW_HOST_EXTENSION_ID } from "./protocol.js";
import { createPreviewHostExtension, type PreviewSurface } from "./host.js";
import { cdpInputCommands, pageInput, previewFocusKind, readPreviewInput, type PreviewPageInput } from "./remote-input.js";

afterEach(() => { document.body.innerHTML = ""; });

describe("input from a device", () => {
  it("takes a tap, a scroll, text and the keys a login needs", () => {
    expect(readPreviewInput({ kind: "click", x: 0.25, y: 1 })).toEqual({ kind: "click", x: 0.25, y: 1 });
    expect(readPreviewInput({ kind: "scroll", dy: 120 })).toEqual({ kind: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 120 });
    expect(readPreviewInput({ kind: "text", text: "tester" })).toEqual({ kind: "text", text: "tester" });
    expect(readPreviewInput({ kind: "key", key: "Enter" })).toEqual({ kind: "key", key: "Enter" });
  });

  it("refuses a tap outside the frame, a chord and anything else", () => {
    expect(() => readPreviewInput({ kind: "click", x: 1.5, y: 0 })).toThrow(/between 0 and 1/u);
    expect(() => readPreviewInput({ kind: "key", key: "Meta+Q" })).toThrow(/may send/u);
    expect(() => readPreviewInput({ kind: "text", text: "" })).toThrow(/needs text/u);
    expect(() => readPreviewInput({ kind: "text", text: "x".repeat(4_001) })).toThrow(/at most/u);
    expect(() => readPreviewInput({ kind: "drag" })).toThrow(/click, a scroll/u);
  });

  it("puts a tap where it landed in the page's own pixels", () => {
    expect(pageInput({ kind: "click", x: 0.5, y: 0.25 }, { width: 1280, height: 800 })).toEqual({ kind: "click", x: 640, y: 200 });
    expect(pageInput({ kind: "text", text: "a" }, { width: 1, height: 1 })).toEqual({ kind: "text", text: "a" });
  });

  it("clicks with a press and a release, types as inserted text and submits with Enter", () => {
    expect(cdpInputCommands({ kind: "click", x: 10, y: 20 }).map(([, params]) => params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(cdpInputCommands({ kind: "text", text: "hunter2" })).toEqual([["Input.insertText", { text: "hunter2" }]]);
    const [down, up] = cdpInputCommands({ kind: "key", key: "Enter" });
    expect(down?.[1]).toMatchObject({ type: "keyDown", key: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
    expect(up?.[1]).toMatchObject({ type: "keyUp", key: "Enter" });
    expect(cdpInputCommands({ kind: "key", key: "Backspace" })[0]?.[1]).toMatchObject({ type: "rawKeyDown", windowsVirtualKeyCode: 8 });
  });

  it("tells a secret field from a plain one and from none", () => {
    document.body.innerHTML = `<input id="user"><input id="pass" type="password"><button id="go">Go</button><div id="note" contenteditable="true"></div>`;
    const focus = (id: string) => (document.getElementById(id) as HTMLElement).focus();
    expect(previewFocusKind()).toBe("none");
    focus("user");
    expect(previewFocusKind()).toBe("field");
    focus("pass");
    expect(previewFocusKind()).toBe("secret");
    focus("go");
    expect(previewFocusKind()).toBe("none");
  });
});

describe("the page on other devices", () => {
  async function activate(options: { input?: boolean; focus?: string } = {}) {
    let url = "";
    let shot = 0;
    const captures: number[] = [];
    const inputs: PreviewPageInput[] = [];
    const surface: PreviewSurface = {
      zoomFactor: () => 1,
      place: () => undefined,
      load: async (next) => { url = next; },
      navigate: () => undefined,
      setZoom: () => undefined,
      setAppearance: async () => undefined,
      state: () => ({ ...EMPTY_PREVIEW_STATE, url, title: "Login" }),
      viewport: () => ({ width: 1000, height: 500 }),
      evaluate: async () => options.focus ?? "field",
      capture: async (maxWidth) => { captures.push(maxWidth); return { base64: `JPEG${String(shot)}`, width: maxWidth, height: Math.round(maxWidth / 2) }; },
      record: async () => ({ chunks: [], mimeType: "video/webm" }),
      pressKey: () => undefined,
      ...(options.input === false ? {} : { input: async (event: PreviewPageInput) => { inputs.push(event); shot += 1; } }),
      destroy: () => undefined,
    };
    const registry = await activateHostKit(createPreviewHostExtension(async () => surface), { stateDir: "", registerRuntimeExtension: () => () => undefined, registerTurnObserver: () => () => undefined });
    const invoke = (command: string, input?: unknown, principal?: Parameters<typeof registry.invoke>[3]) => registry.invoke(PREVIEW_HOST_EXTENSION_ID, command, input, principal);
    return { registry, invoke, captures, inputs };
  }

  it("has no frame before a page is open", async () => {
    const { invoke } = await activate();
    await expect(invoke("live-frame", { maxWidth: 400 })).resolves.toBeNull();
  });

  it("sizes the frame for the client and answers an unchanged page without the picture", async () => {
    const { invoke, captures } = await activate();
    await invoke("open", { url: "http://localhost:18727/" });
    const first = await invoke("live-frame", { maxWidth: 390 }) as { id: string; width: number; url: string };
    expect(first).toMatchObject({ width: 390, height: 195, url: "http://localhost:18727/" });
    await expect(invoke("live-frame", { maxWidth: 390, since: first.id })).resolves.toEqual({ id: first.id, unchanged: true });
    // An input changes the page: the next frame is a new capture with a new id.
    await invoke("input", { kind: "key", key: "Tab" });
    const next = await invoke("live-frame", { maxWidth: 390, since: first.id }) as { id: string; data?: string };
    expect(next.id).not.toBe(first.id);
    expect(next.data).toBe("JPEG1");
    // Out-of-range widths are clamped rather than refused.
    await invoke("live-frame", { maxWidth: 99_999 });
    expect(captures.at(-1)).toBe(1_600);
  });

  it("lets two clients asking at once share one capture", async () => {
    const { invoke, captures } = await activate();
    await invoke("open", { url: "http://localhost:18727/" });
    const [a, b] = await Promise.all([invoke("live-frame", { maxWidth: 640 }), invoke("live-frame", { maxWidth: 640 })]);
    expect(a).toEqual(b);
    expect(captures).toEqual([640]);
  });

  it("turns a tap into a click in the page's pixels and says where the keyboard is", async () => {
    const { invoke, inputs } = await activate({ focus: "secret" });
    await invoke("open", { url: "http://localhost:18727/" });
    await expect(invoke("input", { kind: "click", x: 0.5, y: 0.5 })).resolves.toEqual({ focus: "secret" });
    await invoke("input", { kind: "text", text: "throwaway" });
    expect(inputs).toEqual([{ kind: "click", x: 500, y: 250 }, { kind: "text", text: "throwaway" }]);
  });

  it("refuses input from a Read-only device, but lets it watch", async () => {
    const { invoke, inputs } = await activate();
    await invoke("open", { url: "http://localhost:18727/" });
    const readOnly = { kind: "workbench-client", connection: "phone", pairedClient: "c1", readOnly: true } as const;
    await expect(invoke("live-frame", { maxWidth: 390 }, readOnly)).resolves.toMatchObject({ width: 390 });
    await expect(invoke("input", { kind: "click", x: 0.1, y: 0.1 }, readOnly)).rejects.toThrow();
    expect(inputs).toEqual([]);
  });

  it("answers bad input and a page without input as the device's problem, not the kit's", async () => {
    const { registry, invoke } = await activate({ input: false });
    await expect(invoke("input", { kind: "click", x: 0.1, y: 0.1 })).rejects.toThrow(/Open a page/u);
    await invoke("open", { url: "http://localhost:18727/" });
    for (let attempt = 0; attempt < 4; attempt += 1) await expect(invoke("input", { kind: "key", key: "F5" })).rejects.toThrow(/may send/u);
    await expect(invoke("input", { kind: "click", x: 0.1, y: 0.1 })).rejects.toThrow(/cannot take input/u);
    // Still active after more than three refusals in a row.
    await expect(registry.invoke(PREVIEW_HOST_EXTENSION_ID, "state")).resolves.toMatchObject({ url: "http://localhost:18727/" });
  });
});
