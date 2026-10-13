// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { setHostClient } from "./host-client-context";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { READ_ONLY_REASON } from "./use-host-capabilities";
import { useAppKeybindings } from "./use-app-keybindings";
import { ExtensionRegistry, type WorkbenchActions } from "./extension-system";

describe("useAppKeybindings", () => {
  it.each([
    { keys: "enter", modified: false, composition: { isComposing: true } },
    { keys: "enter", modified: false, composition: { keyCode: 229 } },
    { keys: "mod+shift+enter", modified: true, composition: { isComposing: true } },
    { keys: "mod+shift+enter", modified: true, composition: { keyCode: 229 } },
  ])("leaves IME Enter to the field before dispatching a command (%j)", async ({ keys, modified, composition }) => {
    const registry = new ExtensionRegistry();
    const run = vi.fn();
    await registry.activate({ id: "test", name: "Test", activate(context) {
      context.registerCommand({ id: "send", label: "Send", group: "Test", run });
      context.registerKeybinding({ keys, commandId: "send", when: "editableFocus" });
    } });
    const actions = {} as WorkbenchActions;
    renderHook(() => useAppKeybindings(registry, actions, vi.fn()));
    const field = document.body.appendChild(document.createElement("textarea"));
    const sawKey = vi.fn();
    field.addEventListener("keydown", sawKey);
    field.focus();
    const isMac = /mac|iphone|ipad/iu.test(navigator.platform);
    const key = { key: "Enter", metaKey: modified && isMac, ctrlKey: modified && !isMac, shiftKey: modified, bubbles: true, cancelable: true };
    try {
      const allowed = field.dispatchEvent(new KeyboardEvent("keydown", { ...key, ...composition }));
      expect(run).not.toHaveBeenCalled();
      expect(allowed).toBe(true);
      expect(sawKey).toHaveBeenCalledOnce();
      field.dispatchEvent(new KeyboardEvent("keydown", key));
      expect(run).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledWith(actions);
    } finally {
      field.remove();
    }
  });

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

  it("reports a command that throws as an error, by its label and never its id", async () => {
    const registry = new ExtensionRegistry();
    await registry.activate({ id: "test", name: "Test", activate(context) {
      context.registerCommand({ id: "thread.settle", label: "Settle thread", group: "Test", run: async () => { throw new Error("Nothing to settle."); } });
      context.registerKeybinding({ keys: "mod+k", commandId: "thread.settle" });
    } });
    const onNotice = vi.fn();
    renderHook(() => useAppKeybindings(registry, {} as WorkbenchActions, onNotice));
    const isMac = /mac|iphone|ipad/iu.test(navigator.platform);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: isMac, ctrlKey: !isMac, bubbles: true }));
    await vi.waitFor(() => { expect(onNotice).toHaveBeenCalledWith("Settle thread: Nothing to settle.", "error"); });
    expect(JSON.stringify(onNotice.mock.calls)).not.toContain("thread.settle");
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

  it("says why instead of running a chord's command that writes on a Read-only device", async () => {
    const registry = new ExtensionRegistry();
    const pin = vi.fn();
    const next = vi.fn();
    await registry.activate({ id: "test", name: "Test", activate(context) {
      context.registerCommand({ id: "pin", label: "Pin", group: "Test", run: pin });
      context.registerCommand({ id: "next", label: "Next", group: "Test", access: "read", run: next });
      context.registerKeybinding({ keys: "mod+shift+u", commandId: "pin" });
      context.registerKeybinding({ keys: "mod+shift+y", commandId: "next" });
    } });
    setHostClient(createFakeHostClient({ isReadOnly: () => true }));
    const onNotice = vi.fn();
    const { unmount } = renderHook(() => useAppKeybindings(registry, {} as WorkbenchActions, onNotice));
    try {
      const isMac = /mac|iphone|ipad/iu.test(navigator.platform);
      const press = (key: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: true, metaKey: isMac, ctrlKey: !isMac, bubbles: true, cancelable: true }));
      press("u");
      expect(pin).not.toHaveBeenCalled();
      expect(onNotice).toHaveBeenCalledWith(READ_ONLY_REASON);
      press("y");
      expect(next).toHaveBeenCalledOnce();
    } finally {
      unmount();
      setHostClient(undefined);
    }
  });
});
