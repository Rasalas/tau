// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { keybindingsExtension } from "./desktop.js";
import { KEYBINDINGS_HOST_EXTENSION_ID } from "./protocol.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Keybindings desktop extension", () => {
  it("binds Tau's chords and keeps them when the host is unavailable", async () => {
    const { registry } = createKitHarness(async () => { throw new Error("Host extension tau.keybindings is not installed."); });
    registry.activate(keybindingsExtension);
    await flush();
    const keys = Object.fromEntries(registry.getKeybindings().map((binding) => [binding.commandId, binding.keys]));
    expect(keys).toEqual({ "runtime.command-palette": "mod+k", "runtime.new-session": "mod+n", "runtime.abort": "escape" });
  });

  it("lets keybindings.json replace a chord and binds Pi extension shortcuts", async () => {
    const invoke = vi.fn(async (_extensionId: string, command: string, input?: unknown) => {
      if (command === "pi-keybindings") return { bindings: { "app.session.new": ["ctrl+n"], "app.model.select": ["ctrl+l"] } };
      if (command === "shortcuts") return { sessionId: "s1", shortcuts: [{ keys: "ctrl+shift+p", description: "Pick a persona", source: "persona.ts" }] };
      if (command === "run-shortcut") return input;
      throw new Error(`unexpected ${command}`);
    });
    const { registry } = createKitHarness(invoke);
    registry.activate(keybindingsExtension);
    await flush();
    const keys = Object.fromEntries(registry.getKeybindings().map((binding) => [binding.commandId, binding.keys]));
    expect(keys).toEqual({
      "runtime.command-palette": "mod+k",
      "runtime.new-session": "ctrl+n",
      "runtime.abort": "escape",
      "runtime.model": "ctrl+l",
      "pi.shortcut.ctrl+shift+p": "ctrl+shift+p",
    });
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
