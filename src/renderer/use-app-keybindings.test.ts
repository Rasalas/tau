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

  it("runs a binding that needs the focused element's context before that element sees the key", async () => {
    const registry = new ExtensionRegistry();
    const split = vi.fn();
    const palette = vi.fn();
    await registry.activate({ id: "test", name: "Test", activate(context) {
      context.registerCommand({ id: "split", label: "Split", group: "Test", run: split });
      context.registerCommand({ id: "palette", label: "Palette", group: "Test", run: palette });
      context.registerKeybinding({ keys: "mod+d", commandId: "split", when: "terminalFocus" });
      context.registerKeybinding({ keys: "mod+k", commandId: "palette" });
    } });
    renderHook(() => useAppKeybindings(registry, {} as WorkbenchActions, vi.fn()));
    const shell = document.createElement("div");
    shell.setAttribute("data-keybinding-context", "terminal");
    const field = document.createElement("textarea");
    shell.append(field);
    document.body.append(shell);
    // The shell's own handler takes every key it sees, as xterm does.
    const shellSaw = vi.fn((event: KeyboardEvent) => event.preventDefault());
    field.addEventListener("keydown", shellSaw);
    field.focus();
    const isMac = /mac|iphone|ipad/iu.test(navigator.platform);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "d", metaKey: isMac, ctrlKey: !isMac, bubbles: true, cancelable: true }));
    expect(split).toHaveBeenCalledOnce();
    expect(shellSaw).not.toHaveBeenCalled();
    // A binding without that need waits: the shell handled the key, so it keeps it.
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: isMac, ctrlKey: !isMac, bubbles: true, cancelable: true }));
    expect(shellSaw).toHaveBeenCalledOnce();
    expect(palette).not.toHaveBeenCalled();
    shell.remove();
  });

  it("runs no chord while a field that records chords has the keyboard", async () => {
    const registry = new ExtensionRegistry();
    const run = vi.fn();
    await registry.activate({ id: "test", name: "Test", activate(context) {
      context.registerCommand({ id: "split", label: "Split", group: "Test", run });
      context.registerKeybinding({ keys: "mod+d", commandId: "split", when: "terminalFocus" });
      context.registerKeybinding({ keys: "mod+k", commandId: "split" });
    } });
    renderHook(() => useAppKeybindings(registry, {} as WorkbenchActions, vi.fn()));
    // Inside a terminal too, so the capture-phase binding would match.
    const shell = document.createElement("div");
    shell.setAttribute("data-keybinding-context", "terminal");
    const recorder = document.createElement("input");
    recorder.setAttribute("data-keybinding-capture", "");
    shell.append(recorder);
    document.body.append(shell);
    recorder.focus();
    const isMac = /mac|iphone|ipad/iu.test(navigator.platform);
    for (const key of ["d", "k"]) recorder.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: isMac, ctrlKey: !isMac, bubbles: true }));
    expect(run).not.toHaveBeenCalled();
    shell.remove();
  });
});
