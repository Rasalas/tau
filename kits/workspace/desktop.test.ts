// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { workspaceExtension } from "./desktop.js";
import { WORKSPACE_STORE_SERVICE } from "./protocol.js";
import type { WorkspaceStore } from "./store.js";

describe("Workspace Kit desktop extension", () => {
  it("registers workspace.open-in-editor command with mod+o keybinding and /code slash command", async () => {
    const invoke = vi.fn(async (_extensionId: string, command: string, _input?: unknown) => {
      if (command === "list-editors") return [{ id: "code", name: "VS Code" }, { id: "cursor", name: "Cursor" }];
      if (command === "open-in-editor") return undefined;
      return undefined;
    });
    const { registry } = createKitHarness(invoke);
    registry.activate(workspaceExtension);

    const command = registry.getCommands().find((cmd) => cmd.id === "workspace.open-in-editor");
    expect(command).toBeDefined();
    expect(command?.label).toBe("Open in external editor");
    expect(command?.group).toBe("Project");

    const keybinding = registry.getKeybindings().find((kb) => kb.commandId === "workspace.open-in-editor");
    expect(keybinding).toBeDefined();
    expect(keybinding?.keys).toBe("mod+o");

    const slashCmd = registry.getSlashCommands().find((sc) => sc.name === "code");
    expect(slashCmd).toBeDefined();
    expect(slashCmd?.description).toContain("VS Code");

    let store!: WorkspaceStore;
    registry.activate({
      id: "test.consumer",
      name: "Test Consumer",
      activate(ctx) {
        ctx.useService(WORKSPACE_STORE_SERVICE, (s) => { store = s as WorkspaceStore; });
      },
    });
    expect(store).toBeDefined();
    store.update({ editors: [{ id: "code", name: "VS Code" }] });
    const notify = vi.fn();
    const actions = { notify } as unknown as WorkbenchActions;

    const openInEditorSpy = vi.spyOn(store, "openInEditor").mockResolvedValue(undefined);
    await command?.run(actions);
    expect(notify).toHaveBeenCalledWith("Opening in VS Code…");
    expect(openInEditorSpy).toHaveBeenCalled();

    notify.mockClear();
    openInEditorSpy.mockClear();
    slashCmd?.run("", actions);
    expect(notify).toHaveBeenCalledWith("Opening in VS Code…");
    expect(openInEditorSpy).toHaveBeenCalled();
  });
});
