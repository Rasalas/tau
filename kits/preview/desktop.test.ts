// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import type { WorkbenchActions } from "tau";
import previewExtension from "./desktop.js";
import { EMPTY_PREVIEW_STATE, PREVIEW_BROWSER_SERVICE, PREVIEW_HOST_EXTENSION_ID, PREVIEW_LINKS_SERVICE, type PreviewBrowserService, type PreviewLinksService } from "./protocol.js";
import { PREVIEW_SETTINGS } from "./settings.js";
import { notePanelShown, togglePreviewPanel, workbenchActions } from "./store.js";

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

describe("Preview links service", () => {
  it.each(["app", "system"] as const)("opens Option-clicked reply links externally without a download when the preference is %s", (target) => {
    const invoke = vi.fn(async () => EMPTY_PREVIEW_STATE);
    const { registry, preferences } = createKitHarness(invoke);
    preferences.setValue(PREVIEW_HOST_EXTENSION_ID, PREVIEW_SETTINGS.linkTarget, target);
    const actions = { openPanel: vi.fn(), openExternal: vi.fn() };
    workbenchActions.set(actions as unknown as WorkbenchActions);
    document.body.innerHTML = `<div class="markdown"><a href="https://example.com/a" target="_blank"><span>Link</span></a></div>`;
    const click = (init: MouseEventInit = {}) => {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, altKey: true, ...init });
      document.querySelector("span")!.dispatchEvent(event);
      return event;
    };
    registry.activate(previewExtension);
    try {
      expect(click({ button: 1 }).defaultPrevented).toBe(false);
      const handled = new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true });
      handled.preventDefault();
      document.querySelector("span")!.dispatchEvent(handled);
      expect(actions.openExternal).not.toHaveBeenCalled();
      expect(click().defaultPrevented).toBe(true);
      expect(actions.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/a");
      expect(actions.openPanel).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      registry.deactivate(previewExtension.id);
      expect(click().defaultPrevented).toBe(false);
      expect(actions.openExternal).toHaveBeenCalledTimes(1);
    } finally {
      registry.deactivate(previewExtension.id);
      workbenchActions.set(undefined);
      document.body.innerHTML = "";
    }
  });

  function linksWith(target: "app" | "system" | undefined) {
    const invoke = vi.fn(async () => EMPTY_PREVIEW_STATE);
    const { registry, preferences } = createKitHarness(invoke);
    if (target) preferences.setValue(PREVIEW_HOST_EXTENSION_ID, PREVIEW_SETTINGS.linkTarget, target);
    let links: PreviewLinksService | undefined;
    registry.activate({ id: "consumer", name: "Consumer", activate: (context) => context.useService<PreviewLinksService>(PREVIEW_LINKS_SERVICE, (value) => { links = value; return () => { links = undefined; }; }) });
    registry.activate(previewExtension);
    return { invoke, registry, links: () => links!, openPanel: vi.fn() };
  }
  const plain = { metaKey: false, ctrlKey: false };

  it("follows the setting a link in a reply follows: in the Preview when asked, else left to the caller", async () => {
    const asked = linksWith("app");
    expect(asked.links().open("https://example.com/a", plain, asked)).toBe(true);
    expect(asked.openPanel).toHaveBeenCalledWith("preview");
    await vi.waitFor(() => expect(asked.invoke).toHaveBeenCalledWith(PREVIEW_HOST_EXTENSION_ID, "open", { url: "https://example.com/a" }));
    asked.registry.deactivate(previewExtension.id);

    for (const target of ["system", undefined] as const) {
      const system = linksWith(target);
      expect(system.links().open("https://example.com/a", plain, system)).toBe(false);
      expect(system.openPanel).not.toHaveBeenCalled();
      system.registry.deactivate(previewExtension.id);
    }
  });

  it("sends modifier clicks and any other scheme to the system browser, and is withdrawn with the kit", () => {
    const asked = linksWith("app");
    expect(asked.links().open("https://example.com/a", { metaKey: true, ctrlKey: false }, asked)).toBe(false);
    expect(asked.links().open("https://example.com/a", { metaKey: false, ctrlKey: true }, asked)).toBe(false);
    expect(asked.links().open("https://example.com/a", { metaKey: false, ctrlKey: false, altKey: true }, asked)).toBe(false);
    expect(asked.links().open("mailto:a@b.c", plain, asked)).toBe(false);
    expect(asked.openPanel).not.toHaveBeenCalled();
    asked.registry.deactivate(previewExtension.id);
    expect(() => asked.links()).not.toThrow();
    expect(asked.links()).toBeUndefined();
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
