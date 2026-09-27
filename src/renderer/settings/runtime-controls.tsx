import { TRANSCRIPT_DETAIL_LEVELS, nextTranscriptDetail, type TranscriptDetail } from "../../workbench/transcript-folding";
import type { DesktopExtension, WorkbenchActions } from "../extension-system";
import type { PreferencesStore } from "../preferences";
import { THEME_PREFERENCES, nextTheme, getUserTheme, type ThemePreference } from "../theme";
import type { PaletteItem, PaletteMenu } from "../extension-system";
import { loadRuntimeControlRuns } from "../deferred-surfaces";

/** The levels' rows load with their own chunk the first time one opens. */
const menus = () => import("./palette-menus");
/** The slash commands' and the wordier commands' bodies are a chunk of their own too. */
const runs = loadRuntimeControlRuns;
const later = (id: string) => async (app: WorkbenchActions) => { await (await runs()).commandRuns[id]!(app); };

/** Name, description and argument hint, in the order the slash menu lists them. */
const SLASH_COMMANDS: ReadonlyArray<readonly [string, string, string?]> = [
  ["reload", "Apply source and extension changes, then reload Tau"],
  ["source", "Open Tau's editable source"],
  ["tree", "Move this thread to another point of its session tree"],
  ["fork", "Start a new thread from an earlier message"],
  ["clone", "Duplicate this thread into a new one"],
  ["compact", "Compact the current thread's context window"],
  ["model", "Open the model picker or select a model", "[query]"],
  ["thinking", "Set thinking level (none, low, medium, high, max)", "[level]"],
  ["new", "Start a new thread"],
  ["clear", "Clear conversation and start a new thread"],
  ["system", "Inspect active system prompt and AGENTS.md instructions"],
  ["instructions", "Inspect active system prompt and AGENTS.md instructions"],
  ["copy", "Copy chat as Markdown to clipboard"],
  ["export", "Export current chat as Markdown to clipboard"],
  ["session", "Display session details, runtime, and model info"],
  ["help", "Open command palette and list shortcuts"],
  ["name", "Rename the current thread / session", "<title>"],
  ["hotkeys", "View keyboard shortcuts and keybindings"],
  ["scoped-models", "Manage scoped models for quick cycling (Ctrl+P / Alt+P)"],
];

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

/** A level whose rows come from the lazily loaded module. */
function lazyLevel(title: string, rows: (loaded: Awaited<ReturnType<typeof menus>>, actions: WorkbenchActions) => PaletteItem[] | Promise<PaletteItem[]>): PaletteMenu {
  return { title, items: async (_query, { actions }) => rows(await menus(), actions) };
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
    plugin.registerCommand({ id: "runtime.settings", label: "Open Settings", group: "Runtime", access: "read", run: (app) => app.openSettings() });
    // The way back from another machine must not depend on the kits that machine serves (ADR 0025).
    const environments = plugin.environments;
    if (environments?.shownElsewhere) {
      plugin.registerCommand({
        id: "runtime.show-this-computer",
        label: "Back to this computer",
        group: "Workbench",
        access: "read",
        run: (app) => environments.showLocal().catch((error: unknown) => app.notify(error instanceof Error ? error.message : String(error))),
      });
    }
    // In the palette it lists the models; from a chord it opens the picker.
    plugin.registerCommand({ id: "runtime.model", label: "Set model…", group: "Runtime", access: "write", submenu: lazyLevel("Set model", (loaded, app) => loaded.modelItems(plugin.preferences, app)), run: (app) => (app.openModelPicker ? app.openModelPicker() : app.openSettings("models#setting-default-model")) });
    plugin.registerCommand({ id: "runtime.thinking", label: "Set thinking level…", group: "Thread", access: "write", run: (app) => app.openSettings("models#setting-thinking-level") });
    plugin.registerCommand({ id: "runtime.compact", label: "Compact context", group: "Thread", access: "write", run: later("runtime.compact") });
    plugin.registerCommand({ id: "runtime.new-session", label: "Create new thread", group: "Thread", access: "write", run: (app) => app.newSession() });
    plugin.registerCommand({ id: "runtime.new-thread-on", label: "New thread on…", group: "Thread", access: "write", submenu: lazyLevel("New thread on", (loaded, app) => loaded.runtimeItems(app)), run: (app) => app.openCommandPalette({ menu: "runtime.new-thread-on" }) });
    for (const level of TRANSCRIPT_DETAIL_LEVELS) {
      plugin.registerCommand({
        id: `runtime.transcript-${level}`,
        label: `Transcript: ${DETAIL_LABELS[level]}`,
        group: "Thread",
        access: "read",
        run: (app) => applyTranscriptDetail(plugin.preferences, app, level),
      });
    }
    plugin.registerCommand({
      id: "runtime.transcript-detail",
      label: "Cycle transcript detail",
      group: "Thread",
      access: "read",
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
        access: "read",
        run: (app) => applyTheme(plugin.preferences, app, theme),
      });
    }
    plugin.registerCommand({
      id: "runtime.theme-menu",
      label: "Change theme…",
      group: "Runtime",
      access: "read",
      submenu: lazyLevel("Change theme", (loaded) => loaded.themeItems(plugin.preferences, (app, theme) => applyTheme(plugin.preferences, app, theme))),
      run: (app) => app.openCommandPalette({ menu: "runtime.theme-menu" }),
    });
    plugin.registerCommand({
      id: "runtime.theme",
      label: "Cycle the theme",
      group: "Runtime",
      access: "read",
      run: (app) => applyTheme(plugin.preferences, app, nextTheme(plugin.preferences.getSnapshot().theme)),
    });
    plugin.registerCommand({ id: "runtime.abort", label: "Stop the run", group: "Runtime", access: "write", run: (app) => app.abort() });
    plugin.registerCommand({ id: "composer.effort", label: "Choose the reasoning effort", group: "Composer", access: "write", run: later("composer.effort") });
    plugin.registerCommand({ id: "thread.steerQueuedMessage", label: "Send the oldest queued message now", group: "Thread", access: "write", run: (app) => { app.steerQueuedMessage?.(); } });
    plugin.registerCommand({ id: "runtime.command-palette", label: "Open command palette", group: "Runtime", access: "read", run: (app) => app.openCommandPalette() });
    plugin.registerCommand({ id: "runtime.thread-tree", label: "Thread tree…", group: "Thread", access: "read", run: (app) => app.openThreadTree("navigate") });
    plugin.registerCommand({ id: "runtime.fork-thread", label: "Fork thread…", group: "Thread", access: "write", run: (app) => app.openThreadTree("fork") });
    plugin.registerCommand({ id: "runtime.duplicate-thread", label: "Duplicate thread", group: "Thread", access: "write", run: async (app) => { await app.duplicateThread(); } });
    plugin.registerCommand({ id: "runtime.reload", label: "Apply changes and reload Tau", group: "Runtime", access: "write", run: async (app) => { await app.reloadWorkbench(); } });
    plugin.registerCommand({ id: "runtime.open-source", label: "Open Tau source", group: "Runtime", access: "write", run: async (app) => { await app.openWorkbenchSource(); } });
    plugin.registerCommand({ id: "workbench.focus-composer", label: "Focus composer", group: "Workbench", access: "read", run: (app) => app.focusComposer() });
    plugin.registerCommand({ id: "workbench.focus-transcript", label: "Focus transcript", group: "Workbench", access: "read", run: (app) => app.focusTranscript() });
    plugin.registerCommand({ id: "workbench.focus-stage", label: "Focus stage", group: "Workbench", access: "read", run: (app) => app.focusStage() });
    plugin.registerCommand({ id: "workbench.toggle-sidebar", label: "Toggle sidebar", group: "Workbench", access: "read", run: (app) => app.toggleSidebar?.() });
    plugin.registerCommand({ id: "workbench.toggle-dock", label: "Toggle dock", group: "Workbench", access: "read", run: (app) => app.toggleDock() });
    // T3 Code's command id, so a keybindings.json written for it works here too.
    plugin.registerCommand({ id: "rightPanel.toggleMaximized", label: "Maximize or restore panel", group: "Workbench", access: "read", run: (app) => app.togglePanelMaximized?.() });
    plugin.registerCommand({ id: "workbench.close-stage-tab", label: "Close active stage tab", group: "Workbench", access: "read", run: (app) => app.closeActiveStageTab?.() });
    plugin.registerCommand({ id: "workbench.next-stage-tab", label: "Next stage tab", group: "Workbench", access: "read", run: (app) => app.cycleStageTab?.(1) });
    plugin.registerCommand({ id: "workbench.prev-stage-tab", label: "Previous stage tab", group: "Workbench", access: "read", run: (app) => app.cycleStageTab?.(-1) });
    plugin.registerCommand({
      id: "runtime.instructions",
      label: "Inspect active system prompt & instructions",
      group: "Thread",
      access: "read",
      run: (app) => app.openInstructions?.(),
    });
    plugin.registerCommand({
      id: "runtime.copy-chat",
      label: "Copy chat as Markdown",
      group: "Thread",
      access: "read",
      run: later("runtime.copy-chat"),
    });
    plugin.registerCommand({
      id: "runtime.rename-thread",
      label: "Rename thread",
      group: "Thread",
      access: "write",
      run: later("runtime.rename-thread"),
    });
    plugin.registerCommand({ id: "runtime.cycle-model", label: "Cycle model forward", group: "Runtime", access: "write", run: async (app) => { await app.cycleModel?.(1); } });
    plugin.registerCommand({ id: "runtime.cycle-model-backward", label: "Cycle model backward", group: "Runtime", access: "write", run: async (app) => { await app.cycleModel?.(-1); } });
    plugin.registerCommand({ id: "runtime.cycle-thinking", label: "Cycle thinking level", group: "Thread", access: "write", run: async (app) => { await app.cycleThinking?.(); } });
    plugin.registerCommand({ id: "runtime.open-prompt-editor", label: "Open prompt in external editor", group: "Composer", access: "write", run: async (app) => { await app.openPromptEditor?.(); } });
    for (const [name, description, argumentHint] of SLASH_COMMANDS) {
      plugin.registerSlashCommand({ name, description, ...(argumentHint ? { argumentHint } : {}), run: async (args, app) => (await runs()).slashRuns[name]!(args, app) });
    }
    plugin.registerKeybinding({ keys: "mod+i", commandId: "runtime.instructions" });
    plugin.registerKeybinding({ keys: "mod+k", commandId: "runtime.command-palette" });
    // As in T3 Code; the open Settings screen answers the same chord by closing.
    plugin.registerKeybinding({ keys: "mod+,", commandId: "runtime.settings" });
    // In a terminal these chords are the terminal's (Terminal Kit binds them under `terminalFocus`).
    plugin.registerKeybinding({ keys: "mod+n", commandId: "runtime.new-session", when: "!terminalFocus" });
    plugin.registerKeybinding({ keys: "mod+shift+o", commandId: "runtime.new-session", when: "!terminalFocus" });
    // Only from the chat: Escape elsewhere is a panel's, and an open overlay's always.
    plugin.registerKeybinding({ keys: "escape", commandId: "runtime.abort", when: "chatFocus" });
    plugin.registerKeybinding({ keys: "mod+shift+enter", commandId: "thread.steerQueuedMessage", when: "!terminalFocus" });
    plugin.registerKeybinding({ keys: "mod+shift+e", commandId: "composer.effort", when: "!terminalFocus" });
    plugin.registerKeybinding({ keys: "mod+shift+t", commandId: "runtime.transcript-detail" });
    plugin.registerKeybinding({ keys: "mod+shift+m", commandId: "runtime.model" });
    // Pi's chord, in the composer only: elsewhere Ctrl+P is `mod+p` off macOS, the file picker.
    plugin.registerKeybinding({ keys: "ctrl+p", commandId: "runtime.cycle-model", when: "composerFocus" });
    plugin.registerKeybinding({ keys: "shift+tab", commandId: "runtime.cycle-thinking" });
    plugin.registerKeybinding({ keys: "mod+shift+r", commandId: "runtime.rename-thread" });
    plugin.registerKeybinding({ keys: "ctrl+g", commandId: "runtime.open-prompt-editor" });
    plugin.registerKeybinding({ keys: "mod+alt+shift+a", commandId: "runtime.theme" });
    // ⌘1–⌘9 jump between threads as in T3 Code, so focus moves with ⌥ added.
    plugin.registerKeybinding({ keys: "mod+alt+1", commandId: "workbench.focus-composer" });
    plugin.registerKeybinding({ keys: "mod+alt+2", commandId: "workbench.focus-transcript" });
    plugin.registerKeybinding({ keys: "mod+alt+3", commandId: "workbench.focus-stage" });
    plugin.registerKeybinding({ keys: "mod+b", commandId: "workbench.toggle-sidebar" });
    plugin.registerKeybinding({ keys: "mod+alt+b", commandId: "workbench.toggle-dock" });
    // T3 Code ships no default chord for it; this is the dock's chord with Shift.
    plugin.registerKeybinding({ keys: "mod+alt+shift+b", commandId: "rightPanel.toggleMaximized" });
    plugin.registerKeybinding({ keys: "mod+w", commandId: "workbench.close-stage-tab" });
    plugin.registerKeybinding({ keys: "ctrl+tab", commandId: "workbench.next-stage-tab" });
    plugin.registerKeybinding({ keys: "ctrl+shift+tab", commandId: "workbench.prev-stage-tab" });
  },
};
