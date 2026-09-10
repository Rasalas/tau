// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAppKeybindings } from "./use-app-keybindings";
import { ExtensionRegistry, type WorkbenchActions } from "./extension-system";

describe("useAppKeybindings", () => {
  it("dispatches matched keybindings on keydown", async () => {
    const registry = new ExtensionRegistry();
    const run = vi.fn();
    await registry.activate({
      id: "test",
      name: "Test",
      activate(context) {
        context.registerCommand({ id: "test.cmd", label: "Test", group: "Test", run });
        context.registerKeybinding({ keys: "mod+k", commandId: "test.cmd" });
      },
    });

    const actions = {} as WorkbenchActions;
    const onNotice = vi.fn();

    renderHook(() => useAppKeybindings(registry, actions, onNotice));

    const isMac = /mac|iphone|ipad/iu.test(navigator.platform);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: isMac, ctrlKey: !isMac, bubbles: true }));

    expect(run).toHaveBeenCalledWith(actions);
  });
});
