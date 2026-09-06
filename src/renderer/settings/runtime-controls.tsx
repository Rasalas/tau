import { TRANSCRIPT_DETAIL_LEVELS, nextTranscriptDetail, type TranscriptDetail } from "../../workbench/transcript-folding";
import type { DesktopExtension, WorkbenchActions } from "../extension-system";
import type { PreferencesStore } from "../preferences";
import { THEME_PREFERENCES, nextTheme, type ThemePreference } from "../theme";

const DETAIL_LABELS: Record<TranscriptDetail, string> = {
  focused: "focused",
  detailed: "detailed",
  everything: "everything",
};

/**
 * A level the user picks from the palette belongs to the thread in front of
 * them; with no thread on screen it is the default for every thread.
 */
function applyTranscriptDetail(preferences: PreferencesStore, app: WorkbenchActions, level: TranscriptDetail): void {
  const sessionId = app.activeThread()?.sessionId;
  if (sessionId) preferences.overrideTranscriptDetail(sessionId, level);
  else preferences.setTranscriptDetail(level);
  app.notify(`Transcript: ${DETAIL_LABELS[level]}`);
}

const THEME_LABELS: Record<ThemePreference, string> = {
  system: "follow the system",
  dark: "dark",
  light: "light",
};

function applyTheme(preferences: PreferencesStore, app: WorkbenchActions, theme: ThemePreference): void {
  preferences.setTheme(theme);
  app.notify(`Theme: ${THEME_LABELS[theme]}`);
}

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
    for (const level of TRANSCRIPT_DETAIL_LEVELS) {
      plugin.registerCommand({
        id: `runtime.transcript-${level}`,
        label: `Transcript: ${DETAIL_LABELS[level]}`,
        group: "Thread",
        run: (app) => applyTranscriptDetail(plugin.preferences, app, level),
      });
    }
    plugin.registerCommand({
      id: "runtime.transcript-detail",
      label: "Cycle transcript detail",
      group: "Thread",
      run: (app) => applyTranscriptDetail(
        plugin.preferences,
        app,
        nextTranscriptDetail(plugin.preferences.transcriptDetailFor(app.activeThread()?.sessionId)),
      ),
    });
    for (const theme of THEME_PREFERENCES) {
      plugin.registerCommand({
        id: `runtime.theme-${theme}`,
        label: `Theme: ${THEME_LABELS[theme]}`,
        group: "Runtime",
        run: (app) => applyTheme(plugin.preferences, app, theme),
      });
    }
    plugin.registerCommand({
      id: "runtime.theme",
      label: "Cycle the theme",
      group: "Runtime",
      run: (app) => applyTheme(plugin.preferences, app, nextTheme(plugin.preferences.getSnapshot().theme)),
    });
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
    plugin.registerKeybinding({ keys: "mod+shift+t", commandId: "runtime.transcript-detail" });
  },
};
