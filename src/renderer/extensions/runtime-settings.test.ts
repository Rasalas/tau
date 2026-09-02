import { describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "../extension-system";
import { ExtensionRegistry } from "../extension-system";
import { settingsExtension } from "./index";

describe("runtime settings extension", () => {
  it("contributes a command that reloads Pi and desktop extensions", async () => {
    const registry = new ExtensionRegistry();
    registry.activate(settingsExtension);
    const reloadRuntime = vi.fn(async () => true);
    const actions = { reloadRuntime } as unknown as WorkbenchActions;
    const command = registry.getCommands().find((item) => item.id === "runtime.reload");

    expect(command?.label).toBe("Reload Pi and desktop extensions");
    await command?.run(actions);
    expect(reloadRuntime).toHaveBeenCalledOnce();
  });
});

describe("runtime settings slash commands", () => {
  it("offers /reload, /rebuild and /restart and reports a failed reload", async () => {
    const registry = new ExtensionRegistry();
    registry.activate(settingsExtension);
    expect(registry.getSlashCommands().map((command) => command.name)).toEqual(["reload", "rebuild", "restart"]);
    const reloadRuntime = vi.fn(async () => false);
    const restartWorkbench = vi.fn();
    const actions = { reloadRuntime, restartWorkbench } as unknown as WorkbenchActions;
    await expect(registry.findSlashCommand("/reload")!.command.run("", actions)).resolves.toBe("Runtime reload failed.");
    expect(registry.findSlashCommand("/restart")!.command.run("", actions)).toBeUndefined();
    expect(restartWorkbench).toHaveBeenCalledOnce();
  });
});
