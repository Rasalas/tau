// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import previewExtension from "./desktop.js";
import { EMPTY_PREVIEW_STATE, PREVIEW_BROWSER_SERVICE, PREVIEW_HOST_EXTENSION_ID, type PreviewBrowserService } from "./protocol.js";

describe("Preview browser service", () => {
  it("opens the panel and navigates for another kit, and is withdrawn with the kit", async () => {
    const invoke = vi.fn(async () => EMPTY_PREVIEW_STATE);
    const { registry } = createKitHarness(invoke);
    let browser: PreviewBrowserService | undefined;
    registry.activate({
      id: "consumer",
      name: "Consumer",
      activate: (context) => context.useService<PreviewBrowserService>(PREVIEW_BROWSER_SERVICE, (value) => {
        browser = value;
        return () => { browser = undefined; };
      }),
    });
    registry.activate(previewExtension);

    const openPanel = vi.fn();
    await browser?.open("http://localhost:8000/", { openPanel });
    expect(openPanel).toHaveBeenCalledWith("preview");
    expect(invoke).toHaveBeenCalledWith(PREVIEW_HOST_EXTENSION_ID, "open", { url: "http://localhost:8000/" });

    invoke.mockRejectedValueOnce(new Error("no window"));
    await expect(browser?.open("http://localhost:8000/", { openPanel })).rejects.toThrow("no window");

    registry.deactivate(previewExtension.id);
    expect(browser).toBeUndefined();
  });
});
