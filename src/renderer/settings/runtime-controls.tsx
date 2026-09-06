import type { DesktopExtension } from "../extension-system";

/**
 * Runtime Controls: core's own contributions to the registry. Model and
 * thinking defaults, the command palette, abort, thread commands and `/reload`
 * are the workbench itself, not a kit — safe mode gets them too, which is why
 * `App` activates this one through `activateCore` (docs/CORE.md).
 *
 * Tau's own chords are bound here, so they work with no host and no kit;
 * the Keybindings kit (`kits/keybindings/`) adds whatever `keybindings.json`
 * and Pi extension shortcuts put beside them. The id stays `tau.runtime-settings`.
 */
export const runtimeControls: DesktopExtension = {
  id: "tau.runtime-settings",
  name: "Runtime Controls",
  activate(plugin) {
    plugin.registerCommand({ id: "runtime.settings", label: "Open Settings panel", group: "Runtime", run: (app) => app.openSettings() });
    plugin.registerCommand({ id: "runtime.model", label: "Set model…", group: "Runtime", run: (app) => app.openSettings("defaults") });
    plugin.registerCommand({ id: "runtime.thinking", label: "Set thinking level…", group: "Thread", run: (app) => app.openSettings("defaults") });
    plugin.registerCommand({ id: "runtime.new-session", label: "Create new thread", group: "Thread", run: (app) => app.newSession() });
    plugin.registerCommand({ id: "runtime.toggle-thinking", label: "Expand or collapse thinking blocks", group: "Thread", run: () => plugin.preferences.setShowThinking(!plugin.preferences.getSnapshot().showThinking) });
    plugin.registerCommand({ id: "runtime.abort", label: "Stop the run", group: "Runtime", run: (app) => app.abort() });
    plugin.registerCommand({ id: "runtime.command-palette", label: "Open command palette", group: "Runtime", run: (app) => app.openCommandPalette() });
    plugin.registerCommand({ id: "runtime.thread-tree", label: "Thread tree…", group: "Thread", run: (app) => app.openThreadTree("navigate") });
    plugin.registerCommand({ id: "runtime.fork-thread", label: "Fork thread…", group: "Thread", run: (app) => app.openThreadTree("fork") });
    plugin.registerCommand({ id: "runtime.duplicate-thread", label: "Duplicate thread", group: "Thread", run: async (app) => { await app.duplicateThread(); } });
    plugin.registerCommand({ id: "runtime.reload", label: "Apply changes and reload Tau", group: "Runtime", run: async (app) => { await app.reloadWorkbench(); } });
    plugin.registerSlashCommand({ name: "reload", description: "Apply source and extension changes, then reload Tau", run: async (_args, app) => (await app.reloadWorkbench()) ? undefined : "Tau reload failed." });
    plugin.registerSlashCommand({ name: "tree", description: "Move this thread to another point of its session tree", run: (_args, app) => app.openThreadTree("navigate") });
    plugin.registerSlashCommand({ name: "fork", description: "Start a new thread from an earlier message", run: (_args, app) => app.openThreadTree("fork") });
    plugin.registerSlashCommand({ name: "clone", description: "Duplicate this thread into a new one", run: async (_args, app) => (await app.duplicateThread()) ? undefined : "The thread could not be duplicated." });
    plugin.registerKeybinding({ keys: "mod+k", commandId: "runtime.command-palette" });
    plugin.registerKeybinding({ keys: "mod+n", commandId: "runtime.new-session" });
    plugin.registerKeybinding({ keys: "escape", commandId: "runtime.abort" });
  },
};
