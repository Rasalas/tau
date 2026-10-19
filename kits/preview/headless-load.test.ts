import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createHeadlessPreviewSurface } from "./headless-surface.js";

vi.mock("./browser-fonts.js", () => ({ requireBrowserFonts: async () => undefined }));
const backend = vi.hoisted(() => ({ construct: vi.fn() }));
vi.mock("./browser-process.js", () => ({
  PreviewBrowserProcess: class { constructor() { return backend.construct(); } },
}));

function fakeBrowser() {
  const listeners = new Set<(event: { method: string; params: Record<string, unknown>; sessionId?: string }) => void>();
  let navigations = 0;
  let url = "";
  const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "Target.createTarget") return { targetId: "page" };
    if (method === "Target.attachToTarget") return { sessionId: "session" };
    if (method === "Page.navigate") { url = String(params.url); return { loaderId: `loader-${++navigations}` }; }
    if (method === "Runtime.evaluate") return { result: { value: { url, title: "" } } };
    if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{}] };
    return {};
  });
  const loaded = (loaderId: string) => { for (const listener of listeners) listener({ method: "Page.lifecycleEvent", params: { name: "load", loaderId }, sessionId: "session" }); };
  backend.construct.mockReturnValue({
    send, close: vi.fn(async () => undefined), exited: new Promise<void>(() => undefined),
    onEvent: (listener: never) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
  return { loaded };
}

it("lets a newer load replace one that never finishes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-browser-load-"));
  const browser = fakeBrowser();
  const surface = await createHeadlessPreviewSurface({ partition: "persist:tau-preview", workspaceRoot: () => "", onChange: () => undefined, log: () => undefined }, "/test/browser", directory);
  try {
    const stalled = surface.load("http://localhost:1/", 15_000);
    await vi.waitFor(() => expect(surface.state().loading).toBe(true));
    const corrected = surface.load("http://localhost:2/", 15_000);
    // The stalled wait ends without its 15 s timeout, and leaves the loading flag to the newer load.
    await stalled;
    expect(surface.state().loading).toBe(true);
    browser.loaded("loader-2");
    await corrected;
    expect(surface.state()).toMatchObject({ url: "http://localhost:2/", loading: false });
  } finally {
    await surface.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
