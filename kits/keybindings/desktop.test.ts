// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { keybindingsExtension } from "./desktop.js";
import { KEYBINDINGS_HOST_EXTENSION_ID } from "./protocol.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Keybindings desktop extension", () => {
  it("binds nothing of its own when the host is unavailable, leaving core's chords alone", async () => {
    const { registry } = createKitHarness(async () => { throw new Error("Host extension tau.keybindings is not installed."); });
    registry.activate(keybindingsExtension);
    await flush();
    expect(registry.getKeybindings()).toEqual([]);
  });

  it("replaces core's chord for a rebound Pi action and binds Pi extension shortcuts", async () => {
    const invoke = vi.fn(async (_extensionId: string, command: string, input?: unknown) => {
      if (command === "pi-keybindings") return {
        bindings: {
          "app.session.new": ["ctrl+n"],
          "app.model.select": ["ctrl+l"],
          "app.model.cycleForward": ["alt+m"],
          "app.session.rename": ["ctrl+r"],
        },
      };
      if (command === "shortcuts") return { sessionId: "s1", shortcuts: [{ keys: "ctrl+shift+p", description: "Pick a persona", source: "persona.ts" }] };
      if (command === "run-shortcut") return input;
      throw new Error(`unexpected ${command}`);
    });
    const { registry } = createKitHarness(invoke);
    // Core's own chords for the same commands, as `runtimeControls` binds them.
    registry.activateCore({ id: "tau.runtime-settings", name: "Runtime Controls", activate(context) {
      context.registerKeybinding({ keys: "ctrl+shift+n", commandId: "runtime.new-session" });
      context.registerKeybinding({ keys: "ctrl+shift+m", commandId: "runtime.model" });
      context.registerKeybinding({ keys: "ctrl+p", commandId: "runtime.cycle-model" });
      context.registerKeybinding({ keys: "mod+r", commandId: "runtime.rename-thread" });
      context.registerKeybinding({ keys: "escape", commandId: "runtime.abort" });
    } });
    registry.activate(keybindingsExtension);
    await flush();
    const keys = Object.fromEntries(registry.getKeybindings().map((binding) => [binding.commandId, binding.keys]));
    expect(keys).toEqual({
      // The rebound ones answer to their key alone; the one not mentioned keeps default.
      "runtime.new-session": "ctrl+n",
      "runtime.model": "ctrl+l",
      "runtime.cycle-model": "alt+m",
      "runtime.rename-thread": "ctrl+r",
      "runtime.abort": "escape",
      "pi.shortcut.ctrl+shift+p": "ctrl+shift+p",
    });

    // Removing the kit gives the defaults back.
    registry.deactivate("tau.keybindings");
    expect(Object.fromEntries(registry.getKeybindings().map((binding) => [binding.commandId, binding.keys]))).toEqual({
      "runtime.new-session": "ctrl+shift+n",
      "runtime.model": "ctrl+shift+m",
      "runtime.cycle-model": "ctrl+p",
      "runtime.rename-thread": "mod+r",
      "runtime.abort": "escape",
    });
    registry.activate(keybindingsExtension);
    await flush();
    const shortcut = registry.getCommands().find((command) => command.id === "pi.shortcut.ctrl+shift+p");
    expect(shortcut?.label).toBe("Pick a persona");
    const notify = vi.fn();
    await shortcut?.run({ activeThread: () => ({ sessionId: "s1", draftPending: false }), notify } as unknown as WorkbenchActions);
    expect(invoke).toHaveBeenCalledWith(KEYBINDINGS_HOST_EXTENSION_ID, "run-shortcut", { keys: "ctrl+shift+p", sessionId: "s1" });
    expect(notify).not.toHaveBeenCalled();
    // Switching threads asks again and replaces the previous shortcut set.
    registry.dispatchWorkbenchEvent({ type: "active-thread-changed", sessionId: "s2" });
    await flush();
    expect(invoke).toHaveBeenCalledWith(KEYBINDINGS_HOST_EXTENSION_ID, "shortcuts", { sessionId: "s2" });
    expect(registry.getCommands().filter((command) => command.id.startsWith("pi.shortcut.")).length).toBe(1);
  });
});
