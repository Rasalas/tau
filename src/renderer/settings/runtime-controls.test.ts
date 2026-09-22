import { describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "../extension-system";
import { ExtensionRegistry } from "../extension-system";
import { PreferencesStore } from "../preferences";
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

describe("runtime controls theme commands", () => {
  it("puts all three answers and the cycle in the palette", () => {
    const registry = new ExtensionRegistry();
    registry.activate(runtimeControls);
    const labels = Object.fromEntries(registry.getCommands().filter((item) => item.id.startsWith("runtime.theme")).map((item) => [item.id, item.label]));
    expect(labels).toEqual({
      "runtime.theme-system": "Theme: follow the system",
      "runtime.theme-dark": "Theme: dark",
      "runtime.theme-light": "Theme: light",
      "runtime.theme": "Cycle the theme",
    });
  });

  it("cycles the stored preference and says which one it landed on", async () => {
    const preferences = new PreferencesStore();
    const registry = new ExtensionRegistry(undefined, { preferences });
    registry.activate(runtimeControls);
    const notify = vi.fn();
    const actions = { notify } as unknown as WorkbenchActions;

    await registry.getCommands().find((item) => item.id === "runtime.theme")!.run(actions);
    expect(preferences.getSnapshot().theme).toBe("dark");
    expect(notify).toHaveBeenCalledWith("Theme: dark");

    await registry.getCommands().find((item) => item.id === "runtime.theme-light")!.run(actions);
    expect(preferences.getSnapshot().theme).toBe("light");
  });
});

describe("runtime controls slash commands", () => {
  it("offers slash commands and handles compact, model, thinking, new, and help", async () => {
    const registry = new ExtensionRegistry();
    registry.activate(runtimeControls);
    expect(registry.getSlashCommands().map((command) => command.name)).toEqual([
      "reload", "source", "tree", "fork", "clone", "compact", "model", "thinking", "new",
      "clear", "system", "instructions", "copy", "export", "session", "help",
      "name", "hotkeys", "scoped-models",
    ]);
    const reloadWorkbench = vi.fn(async () => false);
    const openWorkbenchSource = vi.fn(async () => true);
    const compactContext = vi.fn(async () => {});
    const openModelPicker = vi.fn();
    const openSettings = vi.fn();
    const setThinkingLevel = vi.fn(async () => {});
    const setModel = vi.fn(async () => true);
    const newSession = vi.fn();
    const openCommandPalette = vi.fn();
    const notify = vi.fn();
    const openInstructions = vi.fn();
    const copyChat = vi.fn(async () => {});
    const renameThread = vi.fn(async () => true);
    const actions = {
      reloadWorkbench,
      openWorkbenchSource,
      compactContext,
      openModelPicker,
      openSettings,
      setThinkingLevel,
      setModel,
      newSession,
      openCommandPalette,
      notify,
      openInstructions,
      copyChat,
      renameThread,
    } as unknown as WorkbenchActions;

    await expect(registry.findSlashCommand("/reload")!.command.run("", actions)).resolves.toBe("Tau reload failed.");
    await expect(registry.findSlashCommand("/source")!.command.run("", actions)).resolves.toBeUndefined();
    expect(openWorkbenchSource).toHaveBeenCalled();

    await registry.findSlashCommand("/compact")!.command.run("", actions);
    expect(compactContext).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Context compacted.");

    await registry.findSlashCommand("/model")!.command.run("", actions);
    expect(openModelPicker).toHaveBeenCalled();

    await registry.findSlashCommand("/model")!.command.run("gpt-5", actions);
    expect(setModel).toHaveBeenCalledWith("gpt-5");
    expect(notify).toHaveBeenCalledWith("Model switched to gpt-5.");

    await registry.findSlashCommand("/thinking")!.command.run("high", actions);
    expect(setThinkingLevel).toHaveBeenCalledWith("high");
    expect(notify).toHaveBeenCalledWith("Thinking level set to high.");

    await registry.findSlashCommand("/thinking")!.command.run("", actions);
    expect(openSettings).toHaveBeenCalledWith("defaults");

    await registry.findSlashCommand("/new")!.command.run("", actions);
    expect(newSession).toHaveBeenCalled();

    await registry.findSlashCommand("/system")!.command.run("", actions);
    expect(openInstructions).toHaveBeenCalled();

    await registry.findSlashCommand("/copy")!.command.run("", actions);
    expect(copyChat).toHaveBeenCalled();

    await registry.findSlashCommand("/clear")!.command.run("", actions);
    expect(newSession).toHaveBeenCalledTimes(2);

    await registry.findSlashCommand("/help")!.command.run("", actions);
    expect(openCommandPalette).toHaveBeenCalled();

    await registry.findSlashCommand("/name")!.command.run("my thread", actions);
    expect(renameThread).toHaveBeenCalledWith("my thread");
    expect(notify).toHaveBeenCalledWith("Thread renamed to “my thread”.");

    await registry.findSlashCommand("/hotkeys")!.command.run("", actions);
    expect(openSettings).toHaveBeenCalledWith("keybindings");

    await registry.findSlashCommand("/scoped-models")!.command.run("", actions);
    expect(openSettings).toHaveBeenCalledWith("defaults");
  });
});

describe("runtime controls keybindings", () => {
  it("binds Tau's own chords without asking any host", () => {
    const registry = new ExtensionRegistry();
    registry.activate(runtimeControls);
    const keys: Record<string, string[]> = {};
    for (const binding of registry.getKeybindings()) (keys[binding.commandId] ??= []).push(binding.keys);
    expect(keys).toEqual({
      "runtime.abort": ["escape"],
      "runtime.command-palette": ["mod+k"],
      "runtime.cycle-model": ["ctrl+p"],
      "runtime.cycle-thinking": ["shift+tab"],
      "runtime.instructions": ["mod+i"],
      "runtime.model": ["mod+shift+m"],
      "runtime.new-session": ["mod+n"],
      "runtime.rename-thread": ["mod+shift+r"],
      "runtime.settings": ["mod+,"],
      "runtime.transcript-detail": ["mod+shift+t"],
      "workbench.close-stage-tab": ["mod+w"],
      "workbench.focus-composer": ["mod+1"],
      "workbench.focus-stage": ["mod+3"],
      "workbench.focus-transcript": ["mod+2"],
      "workbench.next-stage-tab": ["mod+shift+]", "ctrl+tab"],
      "workbench.prev-stage-tab": ["mod+shift+[", "ctrl+shift+tab"],
      "workbench.toggle-dock": ["mod+b"],
      "runtime.open-prompt-editor": ["ctrl+g"],
    });
  });
});

describe("runtime controls transcript detail", () => {
  const registryWith = (preferences: PreferencesStore) => {
    const registry = new ExtensionRegistry(undefined, { preferences });
    registry.activate(runtimeControls);
    return registry;
  };
  const run = (registry: ExtensionRegistry, id: string, actions: WorkbenchActions) =>
    registry.getCommands().find((command) => command.id === id)?.run(actions);

  it("offers one command per level and one that cycles them", () => {
    const labels = registryWith(new PreferencesStore()).getCommands()
      .filter((command) => command.id.startsWith("runtime.transcript"))
      .map((command) => command.label);
    expect(labels).toEqual([
      "Transcript: focused",
      "Transcript: detailed",
      "Transcript: everything",
      "Cycle transcript detail",
    ]);
  });

  it("gives the thread on screen its own level and says so", () => {
    const preferences = new PreferencesStore();
    const notify = vi.fn();
    const actions = { activeThread: () => ({ sessionId: "thread-a", draftPending: false }), notify } as unknown as WorkbenchActions;
    run(registryWith(preferences), "runtime.transcript-everything", actions);
    expect(preferences.transcriptDetailFor("thread-a")).toBe("everything");
    expect(preferences.getSnapshot().transcriptDetail).toBe("focused");
    expect(notify).toHaveBeenCalledWith("Transcript: everything");
  });

  it("sets the default when no thread is on screen", () => {
    const preferences = new PreferencesStore();
    const actions = { activeThread: () => undefined, notify: vi.fn() } as unknown as WorkbenchActions;
    run(registryWith(preferences), "runtime.transcript-detailed", actions);
    expect(preferences.getSnapshot().transcriptDetail).toBe("detailed");
  });

  it("cycles from whatever the thread reads at now", () => {
    const preferences = new PreferencesStore();
    const registry = registryWith(preferences);
    const actions = { activeThread: () => ({ sessionId: "thread-a", draftPending: false }), notify: vi.fn() } as unknown as WorkbenchActions;
    run(registry, "runtime.transcript-detail", actions);
    expect(preferences.transcriptDetailFor("thread-a")).toBe("detailed");
    run(registry, "runtime.transcript-detail", actions);
    run(registry, "runtime.transcript-detail", actions);
    expect(preferences.transcriptDetailFor("thread-a")).toBe("focused");
  });
});

describe("runtime controls focus and dock commands", () => {
  it("registers focus and toggle dock commands with chords", () => {
    const registry = new ExtensionRegistry();
    registry.activate(runtimeControls);
    const focusComposer = vi.fn();
    const focusTranscript = vi.fn();
    const focusStage = vi.fn();
    const toggleDock = vi.fn();
    const closeActiveStageTab = vi.fn();
    const cycleStageTab = vi.fn();
    const actions = { focusComposer, focusTranscript, focusStage, toggleDock, closeActiveStageTab, cycleStageTab } as unknown as WorkbenchActions;

    const commands = registry.getCommands();
    commands.find((cmd) => cmd.id === "workbench.focus-composer")?.run(actions);
    expect(focusComposer).toHaveBeenCalledOnce();

    commands.find((cmd) => cmd.id === "workbench.focus-transcript")?.run(actions);
    expect(focusTranscript).toHaveBeenCalledOnce();

    commands.find((cmd) => cmd.id === "workbench.focus-stage")?.run(actions);
    expect(focusStage).toHaveBeenCalledOnce();

    commands.find((cmd) => cmd.id === "workbench.toggle-dock")?.run(actions);
    expect(toggleDock).toHaveBeenCalledOnce();

    commands.find((cmd) => cmd.id === "workbench.close-stage-tab")?.run(actions);
    expect(closeActiveStageTab).toHaveBeenCalledOnce();

    commands.find((cmd) => cmd.id === "workbench.next-stage-tab")?.run(actions);
    expect(cycleStageTab).toHaveBeenCalledWith(1);

    commands.find((cmd) => cmd.id === "workbench.prev-stage-tab")?.run(actions);
    expect(cycleStageTab).toHaveBeenCalledWith(-1);

    const bindings = registry.getKeybindings();
    expect(bindings.find((b) => b.commandId === "workbench.focus-composer")?.keys).toBe("mod+1");
    expect(bindings.find((b) => b.commandId === "workbench.focus-transcript")?.keys).toBe("mod+2");
    expect(bindings.find((b) => b.commandId === "workbench.focus-stage")?.keys).toBe("mod+3");
    expect(bindings.find((b) => b.commandId === "workbench.toggle-dock")?.keys).toBe("mod+b");
    expect(bindings.find((b) => b.commandId === "workbench.close-stage-tab")?.keys).toBe("mod+w");
    expect(bindings.find((b) => b.commandId === "workbench.next-stage-tab")?.keys).toBe("mod+shift+]");
    expect(bindings.find((b) => b.commandId === "workbench.prev-stage-tab")?.keys).toBe("mod+shift+[");
  });
});
