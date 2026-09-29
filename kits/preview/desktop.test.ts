// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import previewExtension from "./desktop.js";
import { EMPTY_PREVIEW_STATE, PREVIEW_BROWSER_SERVICE, PREVIEW_HOST_EXTENSION_ID, type PreviewBrowserService } from "./protocol.js";
import { notePanelShown, togglePreviewPanel } from "./store.js";

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

describe("Preview toggle", () => {
  it("binds mod+shift+j to preview.toggle", () => {
    const { registry } = createKitHarness();
    registry.activate(previewExtension);
    expect(registry.getKeybindings().find((binding) => binding.keys === "mod+shift+j")).toMatchObject({ commandId: "preview.toggle" });
    expect(registry.getKeybindingConflicts()).toEqual([]);
    registry.deactivate(previewExtension.id);
  });

  it("opens the panel, and hides the dock while the panel is shown", () => {
    const actions = { openPanel: vi.fn(), toggleDock: vi.fn() };
    togglePreviewPanel(actions);
    expect(actions.openPanel).toHaveBeenCalledWith("preview");
    notePanelShown(true);
    togglePreviewPanel(actions);
    expect(actions.toggleDock).toHaveBeenCalledOnce();
    notePanelShown(false);
  });
});
