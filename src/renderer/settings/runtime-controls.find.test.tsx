// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRegistry, type WorkbenchActions } from "../extension-system";
import { useAppKeybindings } from "../use-app-keybindings";
import { runtimeControls } from "./runtime-controls";

const mac = /mac|iphone|ipad/iu.test(navigator.platform);

describe("Find in thread", () => {
  afterEach(() => { cleanup(); document.body.replaceChildren(); });

  function openWindow() {
    const registry = new ExtensionRegistry();
    registry.activate(runtimeControls);
    const findInThread = vi.fn();
    renderHook(() => useAppKeybindings(registry, { findInThread } as unknown as WorkbenchActions, vi.fn()));
    return { registry, findInThread };
  }

  /** ⌘F (Ctrl+F elsewhere) pressed in a field that sits inside `context`; true when nothing stopped the key. */
  function pressFind(context?: string) {
    const host = document.body.appendChild(document.createElement("div"));
    if (context) host.setAttribute("data-keybinding-context", context);
    const field = host.appendChild(document.createElement("textarea"));
    field.focus();
    return field.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }));
  }

  it("is a command in the palette, bound to the common find chord and rebindable", () => {
    const { registry } = openWindow();
    expect(registry.getCommand("thread.find")).toMatchObject({ label: "Find in thread", group: "Thread", access: "read" });
    expect(registry.keybindingLabel("thread.find")).toMatch(/F$/u);
    registry.applyKeybindingOverrides({ "thread.find": "mod+alt+f" });
    expect(registry.getKeybindings().filter((binding) => binding.commandId === "thread.find").map((binding) => binding.keys)).toEqual(["mod+alt+f"]);
  });

  it("opens the find from the composer, where the transcript does not have the keyboard", () => {
    const { findInThread } = openWindow();
    expect(pressFind("composer")).toBe(false);
    expect(findInThread).toHaveBeenCalledOnce();
  });

  it("leaves the chord to a terminal, the preview, the Files editor and an open dialog", () => {
    const { findInThread } = openWindow();
    for (const context of ["terminal", "preview", "editor"]) expect(pressFind(context)).toBe(true);
    const dialog = document.body.appendChild(document.createElement("div"));
    dialog.setAttribute("role", "dialog");
    expect(pressFind()).toBe(true);
    expect(findInThread).not.toHaveBeenCalled();
  });
});
