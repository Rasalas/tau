// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { workspaceExtension } from "./desktop.js";
import { WORKSPACE_CHANGES_PANEL, WORKSPACE_FILES_PANEL, WORKSPACE_STORE_SERVICE } from "./protocol.js";
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

  it("opens the external terminal from the workspace.open-terminal command and mod+alt+j only; /terminal is the app's own", async () => {
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

    expect(registry.getSlashCommands().some((sc) => sc.name === "terminal" || sc.name === "term")).toBe(false);

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
  });

  it("gives a phone or tablet the Files panel, the documents and the follower that keeps them on the thread's project", () => {
    const { registry } = createKitHarness(vi.fn(async () => undefined), "compact");
    registry.activate(workspaceExtension);
    expect(registry.getPanels().map((panel) => panel.id)).toContain(WORKSPACE_FILES_PANEL);
    expect(registry.getPanels().map((panel) => panel.id)).not.toContain(WORKSPACE_CHANGES_PANEL);
    expect(registry.getDocumentSource()?.id).toBe("workspace.documents");
    expect(registry.getRegions("composer-above").map((region) => region.id)).toContain("workspace.follower");
  });
});
