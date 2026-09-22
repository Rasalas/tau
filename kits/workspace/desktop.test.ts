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

  it("registers workspace.open-terminal command with mod+alt+j keybinding and /terminal and /term slash commands", async () => {
    const invoke = vi.fn(async (_extensionId: string, command: string, _input?: unknown) => {
      if (command === "list-terminals") return [{ id: "ghostty", name: "Ghostty" }, { id: "terminal", name: "Terminal" }];
      if (command === "open-terminal") return undefined;
      return undefined;
    });
    const { registry } = createKitHarness(invoke);
    registry.activate(workspaceExtension);

    const command = registry.getCommands().find((cmd) => cmd.id === "workspace.open-terminal");
    expect(command).toBeDefined();
    expect(command?.label).toBe("Open in external terminal");
    expect(command?.group).toBe("Project");

    const keybinding = registry.getKeybindings().find((kb) => kb.commandId === "workspace.open-terminal");
    expect(keybinding).toBeDefined();
    // mod+j is Terminal Kit's embedded terminal, as in T3 Code.
    expect(keybinding?.keys).toBe("mod+alt+j");

    const slashTerminal = registry.getSlashCommands().find((sc) => sc.name === "terminal");
    expect(slashTerminal).toBeDefined();
    expect(slashTerminal?.description).toContain("Ghostty");

    const slashTerm = registry.getSlashCommands().find((sc) => sc.name === "term");
    expect(slashTerm).toBeDefined();

    let store!: WorkspaceStore;
    registry.activate({
      id: "test.terminal.consumer",
      name: "Test Terminal Consumer",
      activate(ctx) {
        ctx.useService(WORKSPACE_STORE_SERVICE, (s) => { store = s as WorkspaceStore; });
      },
    });
    expect(store).toBeDefined();
    store.update({ terminals: [{ id: "ghostty", name: "Ghostty" }] });
    const notify = vi.fn();
    const actions = { notify } as unknown as WorkbenchActions;

    const openTerminalSpy = vi.spyOn(store, "openTerminal").mockResolvedValue(undefined);
    await command?.run(actions);
    expect(notify).toHaveBeenCalledWith("Opening in Ghostty…");
    expect(openTerminalSpy).toHaveBeenCalled();

    notify.mockClear();
    openTerminalSpy.mockClear();
    slashTerminal?.run("", actions);
    expect(notify).toHaveBeenCalledWith("Opening in Ghostty…");
    expect(openTerminalSpy).toHaveBeenCalled();

    notify.mockClear();
    openTerminalSpy.mockClear();
    slashTerm?.run("", actions);
    expect(notify).toHaveBeenCalledWith("Opening in Ghostty…");
    expect(openTerminalSpy).toHaveBeenCalled();
  });
});
