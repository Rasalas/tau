import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createPreviewHostExtension, type PreviewSurface } from "./host.js";
import { EMPTY_PREVIEW_STATE } from "./protocol.js";

const factories = vi.hoisted(() => ({ electron: vi.fn(), headless: vi.fn() }));
vi.mock("./view.js", () => ({ createElectronPreviewSurface: factories.electron }));
vi.mock("./headless-surface.js", () => ({
  previewBrowserCommand: () => "/test/chromium",
  createHeadlessPreviewSurface: factories.headless,
  clearHeadlessPreviewProfile: async () => undefined,
}));

const originalType = Object.getOwnPropertyDescriptor(process, "type");
afterEach(() => {
  if (originalType) Object.defineProperty(process, "type", originalType);
  else Reflect.deleteProperty(process, "type");
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it.each([true, false])("uses a headless browser only when the Electron host cannot draw, drawable=%s", async (drawable) => {
  Object.defineProperty(process, "type", { configurable: true, value: "browser" });
  vi.stubEnv("TAU_PREVIEW_BROWSER", "");
  const surface: PreviewSurface = {
    zoomFactor: () => 1, place: () => undefined, load: async () => undefined,
    navigate: () => undefined, setZoom: () => undefined, setAppearance: async () => undefined,
    state: () => ({ ...EMPTY_PREVIEW_STATE, url: "http://fixture.test", title: "Fixture" }),
    viewport: () => ({ width: 1280, height: 800 }), evaluate: async () => undefined,
    capture: async () => ({ base64: "", width: 1280, height: 800 }),
    record: async () => ({ chunks: [], mimeType: "video/webm" }), pressKey: () => undefined,
    destroy: () => undefined,
  };
  factories.electron.mockReturnValue(drawable ? surface : undefined);
  factories.headless.mockResolvedValue(surface);
  const stateDir = await mkdtemp(join(tmpdir(), "tau-preview-selection-"));
  const noteSubprocess = vi.fn();
  const registry = await activateHostKit(createPreviewHostExtension(), { stateDir, findCommand: () => undefined, noteSubprocess });
  try {
    await registry.invoke("tau.preview", "open", { url: "http://fixture.test" });
    expect(factories.headless).toHaveBeenCalledTimes(drawable ? 0 : 1);
    expect(noteSubprocess).toHaveBeenCalledTimes(drawable ? 0 : 1);
  } finally { await registry.dispose(); await rm(stateDir, { recursive: true, force: true }); }
});
