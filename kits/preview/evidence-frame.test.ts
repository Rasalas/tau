// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_PREVIEW_STATE, PREVIEW_HOST_EXTENSION_ID } from "./protocol.js";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createPreviewHostExtension, type PreviewSurface } from "./host.js";
import { EVIDENCE_CALLER, previewSecretFocus } from "./evidence-frame.js";

afterEach(() => { document.body.innerHTML = ""; });

describe("previewSecretFocus", () => {
  it("is true while a password or one-time code has the keyboard", () => {
    document.body.innerHTML = `<input id="user"><input id="pass" type="password"><input id="otp" autocomplete="one-time-code">`;
    document.getElementById("user")!.focus();
    expect(previewSecretFocus()).toBe(false);
    document.getElementById("pass")!.focus();
    expect(previewSecretFocus()).toBe(true);
    document.getElementById("otp")!.focus();
    expect(previewSecretFocus()).toBe(true);
  });

  it("is false with nothing focused", () => {
    document.body.innerHTML = `<p>text</p>`;
    expect(previewSecretFocus()).toBe(false);
  });
});

describe("evidence-frame", () => {
  async function activate(secret: unknown, url = "http://localhost:5173/") {
    const captures: number[] = [];
    const surface: PreviewSurface = {
      zoomFactor: () => 1,
      place: () => undefined,
      load: async () => undefined,
      navigate: () => undefined,
      setZoom: () => undefined,
      setAppearance: async () => undefined,
      state: () => ({ ...EMPTY_PREVIEW_STATE, url, title: "Fixture" }),
      viewport: () => ({ width: 800, height: 600 }),
      evaluate: async () => secret,
      capture: async (maxWidth) => { captures.push(maxWidth); return { base64: "UE5H", width: maxWidth, height: 600 }; },
      record: async () => ({ chunks: [], mimeType: "video/webm" }),
      pressKey: () => undefined,
      destroy: () => undefined,
    };
    const registry = await activateHostKit(createPreviewHostExtension(async () => surface), { stateDir: "/state", registerRuntimeExtension: () => () => undefined, registerTurnObserver: () => () => undefined });
    return { registry, captures };
  }

  it("answers nothing before a page is open", async () => {
    const { registry } = await activate(false);
    expect(await registry.invoke(PREVIEW_HOST_EXTENSION_ID, "evidence-frame", {})).toEqual({ skipped: "closed" });
  });

  it("captures the page at the asked width once one is open, and skips while a secret has focus", async () => {
    const open = await activate(false);
    await open.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "open", { url: "http://localhost:5173/" });
    expect(await open.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "evidence-frame", { maxWidth: 960 }))
      .toEqual({ data: "UE5H", width: 960, height: 600, url: "http://localhost:5173/", title: "Fixture", visible: false });

    const secret = await activate(true);
    await secret.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "open", { url: "http://localhost:5173/" });
    expect(await secret.registry.invoke(PREVIEW_HOST_EXTENSION_ID, "evidence-frame", {})).toEqual({ skipped: "secret" });
    expect(secret.captures).toEqual([]);
  });

  it("answers Evidence Kit and no other extension", async () => {
    const { registry } = await activate(false);
    const caller = (id: string) => ({ id, name: id, activate: (context: { registerCommand(name: string, run: () => unknown): void; invokeHostExtension(id: string, command: string, input?: unknown): Promise<unknown> }) => {
      context.registerCommand("probe", () => context.invokeHostExtension(PREVIEW_HOST_EXTENSION_ID, "evidence-frame", {}));
    } });
    await registry.activate(caller(EVIDENCE_CALLER));
    await registry.activate(caller("other.kit"));
    await expect(registry.invoke(EVIDENCE_CALLER, "probe")).resolves.toEqual({ skipped: "closed" });
    await expect(registry.invoke("other.kit", "probe")).rejects.toThrow();
  });
});
