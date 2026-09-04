import { describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "../extension-system";
import { ExtensionRegistry } from "../extension-system";
import { settingsExtension } from "./index";

describe("runtime settings extension", () => {
  it("contributes one command that applies every kind of change", async () => {
    const registry = new ExtensionRegistry();
    registry.activate(settingsExtension);
    const reloadWorkbench = vi.fn(async () => true);
    const actions = { reloadWorkbench } as unknown as WorkbenchActions;
    const command = registry.getCommands().find((item) => item.id === "runtime.reload");

    expect(command?.label).toBe("Apply changes and reload Tau");
    await command?.run(actions);
    expect(reloadWorkbench).toHaveBeenCalledOnce();
  });
});

describe("runtime settings slash commands", () => {
  it("offers one reload command and reports a failure", async () => {
    const registry = new ExtensionRegistry();
    registry.activate(settingsExtension);
    expect(registry.getSlashCommands().map((command) => command.name)).toEqual(["reload", "tree", "fork", "clone"]);
    const reloadWorkbench = vi.fn(async () => false);
    const actions = { reloadWorkbench } as unknown as WorkbenchActions;
    await expect(registry.findSlashCommand("/reload")!.command.run("", actions)).resolves.toBe("Tau reload failed.");
  });
});

describe("runtime settings keybindings", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("binds Tau's chords and keeps them when the host is unavailable", async () => {
    const registry = new ExtensionRegistry();
    registry.activate(settingsExtension);
    await flush();
    const keys = Object.fromEntries(registry.getKeybindings().map((binding) => [binding.commandId, binding.keys]));
    expect(keys).toEqual({ "runtime.command-palette": "mod+k", "runtime.new-session": "mod+n", "runtime.abort": "escape" });
  });

  it("lets keybindings.json replace a runtime chord and binds Pi extension shortcuts", async () => {
    const invoke = vi.fn(async (_extensionId: string, command: string, input?: unknown) => {
      if (command === "pi-keybindings") return { bindings: { "app.session.new": ["ctrl+n"], "app.model.select": ["ctrl+l"] } };
      if (command === "shortcuts") return { sessionId: "s1", shortcuts: [{ keys: "ctrl+shift+p", description: "Pick a persona", source: "persona.ts" }] };
      if (command === "run-shortcut") return input;
      throw new Error(`unexpected ${command}`);
    });
    const registry = new ExtensionRegistry({ invoke });
    registry.activate(settingsExtension);
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
    expect(invoke).toHaveBeenCalledWith("tau.runtime-settings", "run-shortcut", { keys: "ctrl+shift+p", sessionId: "s1" });
    expect(notify).not.toHaveBeenCalled();
    // Switching threads asks again and replaces the previous shortcut set.
    registry.dispatchWorkbenchEvent({ type: "active-thread-changed", sessionId: "s2" });
    await flush();
    expect(invoke).toHaveBeenCalledWith("tau.runtime-settings", "shortcuts", { sessionId: "s2" });
    expect(registry.getCommands().filter((command) => command.id.startsWith("pi.shortcut.")).length).toBe(1);
  });
});
