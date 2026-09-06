import { describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "../extension-system";
import { ExtensionRegistry } from "../extension-system";
import { runtimeControls } from "./runtime-controls";

describe("runtime controls extension", () => {
  it("contributes one command that applies every kind of change", async () => {
    const registry = new ExtensionRegistry();
    registry.activate(runtimeControls);
    const reloadWorkbench = vi.fn(async () => true);
    const actions = { reloadWorkbench } as unknown as WorkbenchActions;
    const command = registry.getCommands().find((item) => item.id === "runtime.reload");

    expect(command?.label).toBe("Apply changes and reload Tau");
    await command?.run(actions);
    expect(reloadWorkbench).toHaveBeenCalledOnce();
  });
});

describe("runtime controls slash commands", () => {
  it("offers one reload command and reports a failure", async () => {
    const registry = new ExtensionRegistry();
    registry.activate(runtimeControls);
    expect(registry.getSlashCommands().map((command) => command.name)).toEqual(["reload", "tree", "fork", "clone"]);
    const reloadWorkbench = vi.fn(async () => false);
    const actions = { reloadWorkbench } as unknown as WorkbenchActions;
    await expect(registry.findSlashCommand("/reload")!.command.run("", actions)).resolves.toBe("Tau reload failed.");
  });
});

describe("runtime controls keybindings", () => {
  it("binds Tau's own chords without asking any host", () => {
    const registry = new ExtensionRegistry();
    registry.activate(runtimeControls);
    const keys = Object.fromEntries(registry.getKeybindings().map((binding) => [binding.commandId, binding.keys]));
    expect(keys).toEqual({ "runtime.command-palette": "mod+k", "runtime.new-session": "mod+n", "runtime.abort": "escape" });
  });
});
