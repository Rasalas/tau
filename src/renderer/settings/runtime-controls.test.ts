// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "../extension-system";
import { ExtensionRegistry } from "../extension-system";
import { PreferencesStore } from "../preferences";
import { runtimeControls } from "./runtime-controls";
import type { Platform } from "../../workbench/platform";
import type { PlatformEnvironments } from "../../workbench/environments";
import { showGoal } from "../goal-state";

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
      "runtime.theme-menu": "Change theme…",
      "runtime.theme": "Cycle the theme",
    });
  });

  it("lists them after the other Runtime commands, so an empty palette does not open on five theme rows", () => {
    const registry = new ExtensionRegistry();
    registry.activate(runtimeControls);
    const runtime = registry.getCommands().filter((item) => item.group === "Runtime").map((item) => item.id);
    const firstTheme = runtime.findIndex((id) => id.startsWith("runtime.theme"));
    expect(runtime.slice(firstTheme).every((id) => id.startsWith("runtime.theme"))).toBe(true);
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

  it("offers a level of themes in the palette, and opens the palette on it from a chord", async () => {
    const preferences = new PreferencesStore();
    const registry = new ExtensionRegistry(undefined, { preferences });
    registry.activate(runtimeControls);
    const notify = vi.fn();
    const openCommandPalette = vi.fn();
    const actions = { notify, openCommandPalette } as unknown as WorkbenchActions;
    const command = registry.getCommands().find((item) => item.id === "runtime.theme-menu")!;
    const rows = await command.submenu!.items("", { actions, index: { projects: [], threads: [] }, signal: new AbortController().signal });
    expect(rows.map((row) => [row.label, row.current])).toEqual([["System", true], ["Dark", false], ["Light", false]]);
    await rows[2]!.run!(actions);
    expect(preferences.getSnapshot().theme).toBe("light");
    expect(notify).toHaveBeenCalledWith("Theme: light");
    await command.run(actions);
    expect(openCommandPalette).toHaveBeenCalledWith({ menu: "runtime.theme-menu" });
  });
});

describe("runtime controls slash commands", () => {
  it("keeps goal refusal, pause, resume, end and errors through the deferred command body", async () => {
    const registry = new ExtensionRegistry();
    registry.activate(runtimeControls);
    const command = registry.getSlashCommands().find((entry) => entry.name === "goal")!;
    const threadGoal = vi.fn();
    const actions = { threadGoal, notify: vi.fn() } as unknown as WorkbenchActions;
    const goal = { objective: "Synthetic goal", status: "active" as const, actions: { pause: true, resume: true }, updatedAt: 1 };
    try {
      showGoal("test", undefined, false);
      expect(await command.run("pause", actions)).toContain("runtime keeps no goals");
      expect(threadGoal).not.toHaveBeenCalled();
      showGoal("test", goal, true);
      await command.run("pause", actions);
      expect(threadGoal).toHaveBeenLastCalledWith("pause");
      showGoal("test", { ...goal, status: "paused" }, true);
      await command.run("resume", actions);
      expect(threadGoal).toHaveBeenLastCalledWith("resume");
      await command.run("end", actions);
      expect(threadGoal).toHaveBeenLastCalledWith("clear");
      threadGoal.mockRejectedValueOnce(new Error("Runtime unavailable"));
      expect(await command.run("end", actions)).toBe("Runtime unavailable");
    } finally { showGoal(undefined, undefined, false); }
  });

  it("offers slash commands and handles compact, model, thinking, new, and help", async () => {
    const registry = new ExtensionRegistry();
    registry.activate(runtimeControls);
    expect(registry.getSlashCommands().map((command) => command.name)).toEqual([
      "reload", "source", "tree", "fork", "clone", "compact", "model", "thinking", "new",
      "clear", "system", "instructions", "copy", "export", "session", "help",
      "name", "hotkeys", "scoped-models", "goal",
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
    expect(notify).not.toHaveBeenCalledWith("Context compacted.");

    await registry.findSlashCommand("/model")!.command.run("", actions);
    expect(openModelPicker).toHaveBeenCalled();

    await registry.findSlashCommand("/model")!.command.run("gpt-5", actions);
    expect(setModel).toHaveBeenCalledWith("gpt-5");
    expect(notify).toHaveBeenCalledWith("Model switched to gpt-5.");

    await registry.findSlashCommand("/thinking")!.command.run("high", actions);
    expect(setThinkingLevel).toHaveBeenCalledWith("high");
    expect(notify).toHaveBeenCalledWith("Thinking level set to high.");

    // Without a composer there is only the default Pi starts on.
    await registry.findSlashCommand("/thinking")!.command.run("", actions);
    expect(openSettings).toHaveBeenCalledWith("runtimes/pi#setting-default-thinking");

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
    expect(registry.getCommand("runtime.rename-thread")?.unavailable?.()).toBe("Open a thread to rename it.");

    await registry.findSlashCommand("/hotkeys")!.command.run("", actions);
    expect(openSettings).toHaveBeenCalledWith("keybindings");

    await registry.findSlashCommand("/scoped-models")!.command.run("", actions);
    expect(openModelPicker).toHaveBeenCalledTimes(2);
  });
});

describe("choosing the thinking level of the thread on screen", () => {
  afterEach(() => { document.body.replaceChildren(); });
  const chip = (disabled = false) => {
    const button = document.createElement("button");
    button.dataset.composerShortcut = "composer.effort";
    button.disabled = disabled;
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    document.body.append(button);
    return clicked;
  };

  it("opens the composer's thinking menu, the way the chord does, from /thinking and from the palette", async () => {
    const registry = new ExtensionRegistry();
    registry.activate(runtimeControls);
    const clicked = chip();
    const openSettings = vi.fn();
    const actions = { openSettings, notify: vi.fn() } as unknown as WorkbenchActions;
    await registry.findSlashCommand("/thinking")!.command.run("", actions);
    await registry.getCommands().find((item) => item.id === "runtime.thinking")!.run(actions);
    expect(clicked).toHaveBeenCalledTimes(2);
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("says so when the thread's runtime sets its reasoning itself, and goes to Pi's default where no composer is", async () => {
    const registry = new ExtensionRegistry();
    registry.activate(runtimeControls);
    const openSettings = vi.fn();
    const notify = vi.fn();
    const actions = { openSettings, notify } as unknown as WorkbenchActions;
    const command = registry.getCommands().find((item) => item.id === "runtime.thinking")!;
    await command.run(actions);
    expect(openSettings).toHaveBeenCalledWith("runtimes/pi#setting-default-thinking");
    const clicked = chip(true);
    await command.run(actions);
    expect(notify).toHaveBeenCalledWith("This thread's runtime sets its reasoning itself.");
    expect(clicked).not.toHaveBeenCalled();
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});

describe("runtime controls keybindings", () => {
  it("offers bounded reasoning commands under the compatible composer ids without default shortcuts", async () => {
    const registry = new ExtensionRegistry();
    registry.activate(runtimeControls);
    const cycleThinking = vi.fn();
    const actions = { cycleThinking } as unknown as WorkbenchActions;
    for (const [id, direction] of [["composer.increaseEffort", 1], ["composer.decreaseEffort", -1]] as const) {
      const command = registry.getCommands().find((entry) => entry.id === id)!;
      expect(command.access).toBe("write");
      await command.run(actions);
      expect(cycleThinking).toHaveBeenLastCalledWith(direction, true);
      expect(registry.getKeybindings().some((binding) => binding.commandId === id)).toBe(false);
    }
  });

  it("binds Tau's own chords without asking any host", () => {
    const registry = new ExtensionRegistry();
    registry.activate(runtimeControls);
    const keys: Record<string, string[]> = {};
    for (const binding of registry.getKeybindings()) (keys[binding.commandId] ??= []).push(binding.keys);
    expect(keys).toEqual({
      "runtime.abort": ["escape"],
      "thread.steerQueuedMessage": ["mod+shift+enter"],
      "composer.effort": ["mod+shift+e"],
      "runtime.command-palette": ["mod+k"],
      "navigation.back": ["mod+["],
      "navigation.forward": ["mod+]"],
      "runtime.cycle-model": ["ctrl+p"],
      "runtime.instructions": ["mod+i"],
      "thread.find": ["mod+f"],
      "runtime.model": ["mod+shift+m"],
      "runtime.new-session": ["mod+n", "mod+shift+n"],
      "runtime.new-session-in": ["mod+shift+o"],
      "runtime.rename-thread": ["f2"],
      "runtime.compact": ["mod+alt+k"],
      "workbench.split-stage": ["mod+\\"],
      "workbench.toggle-spine": ["mod+shift+\\"],
      "runtime.settings": ["mod+,"],
      "runtime.theme": ["mod+alt+shift+a"],
      "runtime.transcript-detail": ["mod+alt+t"],
      "workbench.close-stage-tab": ["mod+w"],
      "workbench.reopen-stage-tab": ["mod+shift+t"],
      "workbench.focus-next-area": ["f6"],
      "workbench.focus-previous-area": ["shift+f6"],
      "workbench.focus-composer": ["mod+alt+1"],
      "workbench.focus-stage": ["mod+alt+3"],
      "workbench.focus-transcript": ["mod+alt+2"],
      "workbench.next-stage-tab": ["ctrl+tab"],
      "workbench.prev-stage-tab": ["ctrl+shift+tab"],
      "workbench.toggle-dock": ["mod+alt+b"],
      "workbench.toggle-sidebar": ["mod+b"],
      "runtime.open-prompt-editor": ["ctrl+g"],
      "rightPanel.toggleMaximized": ["mod+alt+shift+b"],
    });
    // The command stays in the palette; ⇧Tab is Plan Kit's now and ⌘⇧E opens the thinking menu.
    expect(registry.getCommands().map((command) => command.id)).toContain("runtime.cycle-thinking");
    const scoped = Object.fromEntries(registry.getKeybindings().filter((binding) => binding.when).map((binding) => [binding.keys, binding.when]));
    expect(scoped).toEqual({
      "mod+f": "!terminalFocus && !previewFocus && !editorFocus && !overlayOpen", "mod+[": "!terminalFocus", "mod+]": "!terminalFocus",
      "mod+n": "!terminalFocus && isDesktop", "mod+shift+t": "!terminalFocus && isDesktop", "mod+shift+enter": "!terminalFocus", "mod+shift+e": "!terminalFocus",
      "mod+shift+n": "!terminalFocus && isDesktop", "mod+shift+o": "!terminalFocus", "mod+w": "isDesktop", "ctrl+tab": "isDesktop", "ctrl+shift+tab": "isDesktop",
      "ctrl+p": "composerFocus", escape: "chatFocus", f2: "!terminalFocus",
    });
  });

  // A browser keeps ⌘W, ⌘N, ⇧⌘N, ⇧⌘T and Ctrl+Tab; a tab closes, opens, reopens and switches with ⌥ variants.
  it.each(["web", "compact"] as const)("binds a %s client's own chords where a browser keeps the usual ones", (profile) => {
    const registry = new ExtensionRegistry(undefined, { preferences: new PreferencesStore(), profile });
    registry.activate(runtimeControls);
    const keys: Record<string, string[]> = {};
    for (const binding of registry.getKeybindings()) (keys[binding.commandId] ??= []).push(binding.keys);
    expect(keys["runtime.new-session"]).toEqual(["mod+alt+n"]);
    expect(keys["workbench.close-stage-tab"]).toEqual(["mod+alt+w"]);
    expect(keys["workbench.reopen-stage-tab"]).toEqual(["mod+alt+shift+w"]);
    expect(keys["workbench.next-stage-tab"]).toEqual(["mod+alt+]"]);
    expect(keys["workbench.prev-stage-tab"]).toEqual(["mod+alt+["]);
    expect(registry.getKeybindingConflicts()).toEqual([]);
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

    const toggleSidebar = vi.fn();
    commands.find((cmd) => cmd.id === "workbench.toggle-sidebar")?.run({ ...actions, toggleSidebar });
    expect(toggleSidebar).toHaveBeenCalledOnce();
    // Without the action (an older client) the command does nothing rather than throw.
    expect(() => commands.find((cmd) => cmd.id === "workbench.toggle-sidebar")?.run(actions)).not.toThrow();
  });
});

describe("the way back to this machine", () => {
  const registryWith = (environments: Partial<PlatformEnvironments>) => {
    const registry = new ExtensionRegistry(undefined, { preferences: new PreferencesStore(), platform: () => ({ environments } as unknown as Platform) });
    registry.activate(runtimeControls);
    return registry.getCommands().find((item) => item.id === "runtime.show-this-computer");
  };

  it("is in the palette only while the page shows another machine, whatever kits that one serves", async () => {
    expect(registryWith({})).toBeUndefined();
    const showLocal = vi.fn(async () => undefined);
    const command = registryWith({ shownElsewhere: "host-studio", showLocal });
    expect(command?.label).toBe("Back to this machine");
    await command!.run({ notify: vi.fn() } as unknown as WorkbenchActions);
    expect(showLocal).toHaveBeenCalledOnce();
  });
});

it.each(["desktop", "web"] as const)("opts the model, theme and runtime menus into direct search and lists the focus chords on %s", async (profile) => {
  const registry = new ExtensionRegistry(undefined, { preferences: new PreferencesStore(), profile });
  await registry.activate(runtimeControls);
  for (const id of ["runtime.model", "runtime.theme-menu", "runtime.new-thread-on"]) expect(registry.getCommand(id)?.submenu?.searchable).toBe(true);
  const chords = registry.getDefaultKeybindings("workbench.focus-next-area").map((binding) => binding.keys);
  expect(chords).toContain("f6");
  expect(chords.includes("mod+f6")).toBe(profile === "web");
  expect(registry.getCommand("workbench.focus-next-area")).toMatchObject({ group: "View", access: "read" });
});
