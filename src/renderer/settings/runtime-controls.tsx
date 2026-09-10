import { TRANSCRIPT_DETAIL_LEVELS, nextTranscriptDetail, type TranscriptDetail } from "../../workbench/transcript-folding";
import { ShieldAlert } from "lucide-react";
import { subscriptionLoginWarning } from "../../shared/subscription-login";
import type { DesktopExtension, RegionProps, WorkbenchActions } from "../extension-system";
import type { PreferencesStore } from "../preferences";
import { THEME_PREFERENCES, nextTheme, getUserTheme, type ThemePreference } from "../theme";

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

const THEME_LABELS: Record<string, string> = {
  system: "follow the system",
  dark: "dark",
  light: "light",
};

function applyTheme(preferences: PreferencesStore, app: WorkbenchActions, theme: ThemePreference): void {
  preferences.setTheme(theme);
  const label = THEME_LABELS[theme] ?? getUserTheme(theme)?.name ?? theme;
  app.notify(`Theme: ${label}`);
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
/** Reminds, after the one-time warning, that the thread's model rides on a subscription login Pi performs. */
export function SubscriptionLoginStatus({ snapshot }: RegionProps) {
  const model = snapshot?.model;
  if (model?.login !== "subscription") return null;
  const warning = subscriptionLoginWarning(model.provider);
  return <span className="status-item-warning" title={`${warning.title}. ${warning.message}`}><ShieldAlert size={12} /> Subscription login</span>;
}

export const runtimeControls: DesktopExtension = {
  id: "tau.runtime-settings",
  name: "Runtime Controls",
  activate(plugin) {
    plugin.registerStatusItem({ id: "runtime.subscription-login", align: "left", order: 45, profiles: ["desktop", "web", "compact"], Component: SubscriptionLoginStatus });
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
    plugin.registerCommand({ id: "workbench.focus-composer", label: "Focus composer", group: "Workbench", run: (app) => app.focusComposer() });
    plugin.registerCommand({ id: "workbench.focus-transcript", label: "Focus transcript", group: "Workbench", run: (app) => app.focusTranscript() });
    plugin.registerCommand({ id: "workbench.focus-stage", label: "Focus stage", group: "Workbench", run: (app) => app.focusStage() });
    plugin.registerCommand({ id: "workbench.toggle-dock", label: "Toggle dock", group: "Workbench", run: (app) => app.toggleDock() });
    plugin.registerCommand({ id: "workbench.close-stage-tab", label: "Close active stage tab", group: "Workbench", run: (app) => app.closeActiveStageTab?.() });
    plugin.registerCommand({ id: "workbench.next-stage-tab", label: "Next stage tab", group: "Workbench", run: (app) => app.cycleStageTab?.(1) });
    plugin.registerCommand({ id: "workbench.prev-stage-tab", label: "Previous stage tab", group: "Workbench", run: (app) => app.cycleStageTab?.(-1) });
    plugin.registerSlashCommand({ name: "reload", description: "Apply source and extension changes, then reload Tau", run: async (_args, app) => (await app.reloadWorkbench()) ? undefined : "Tau reload failed." });
    plugin.registerSlashCommand({ name: "tree", description: "Move this thread to another point of its session tree", run: (_args, app) => app.openThreadTree("navigate") });
    plugin.registerSlashCommand({ name: "fork", description: "Start a new thread from an earlier message", run: (_args, app) => app.openThreadTree("fork") });
    plugin.registerSlashCommand({ name: "clone", description: "Duplicate this thread into a new one", run: async (_args, app) => (await app.duplicateThread()) ? undefined : "The thread could not be duplicated." });
    plugin.registerKeybinding({ keys: "mod+k", commandId: "runtime.command-palette" });
    plugin.registerKeybinding({ keys: "mod+n", commandId: "runtime.new-session" });
    plugin.registerKeybinding({ keys: "escape", commandId: "runtime.abort" });
    plugin.registerKeybinding({ keys: "mod+shift+t", commandId: "runtime.transcript-detail" });
    plugin.registerKeybinding({ keys: "mod+1", commandId: "workbench.focus-composer" });
    plugin.registerKeybinding({ keys: "mod+2", commandId: "workbench.focus-transcript" });
    plugin.registerKeybinding({ keys: "mod+3", commandId: "workbench.focus-stage" });
    plugin.registerKeybinding({ keys: "mod+b", commandId: "workbench.toggle-dock" });
    plugin.registerKeybinding({ keys: "mod+w", commandId: "workbench.close-stage-tab" });
    plugin.registerKeybinding({ keys: "mod+shift+]", commandId: "workbench.next-stage-tab" });
    plugin.registerKeybinding({ keys: "mod+shift+[", commandId: "workbench.prev-stage-tab" });
  },
};
