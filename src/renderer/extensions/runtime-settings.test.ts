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
