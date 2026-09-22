import { TRANSCRIPT_DETAIL_LEVELS, nextTranscriptDetail, type TranscriptDetail } from "../../workbench/transcript-folding";
import type { DesktopExtension, WorkbenchActions } from "../extension-system";
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
export const runtimeControls: DesktopExtension = {
  id: "tau.runtime-settings",
  name: "Runtime Controls",
  activate(plugin) {
    plugin.registerCommand({ id: "runtime.settings", label: "Open Settings panel", group: "Runtime", run: (app) => app.openSettings() });
    plugin.registerCommand({ id: "runtime.model", label: "Set model…", group: "Runtime", run: (app) => (app.openModelPicker ? app.openModelPicker() : app.openSettings("defaults")) });
    plugin.registerCommand({ id: "runtime.thinking", label: "Set thinking level…", group: "Thread", run: (app) => app.openSettings("defaults") });
    plugin.registerCommand({
      id: "runtime.compact",
      label: "Compact context",
      group: "Thread",
      run: async (app) => {
        if (app.compactContext) {
          await app.compactContext();
          app.notify("Context compacted.");
        }
      },
    });
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
    plugin.registerCommand({ id: "runtime.open-source", label: "Open Tau source", group: "Runtime", run: async (app) => { await app.openWorkbenchSource(); } });
    plugin.registerCommand({ id: "workbench.focus-composer", label: "Focus composer", group: "Workbench", run: (app) => app.focusComposer() });
    plugin.registerCommand({ id: "workbench.focus-transcript", label: "Focus transcript", group: "Workbench", run: (app) => app.focusTranscript() });
    plugin.registerCommand({ id: "workbench.focus-stage", label: "Focus stage", group: "Workbench", run: (app) => app.focusStage() });
    plugin.registerCommand({ id: "workbench.toggle-dock", label: "Toggle dock", group: "Workbench", run: (app) => app.toggleDock() });
    plugin.registerCommand({ id: "workbench.close-stage-tab", label: "Close active stage tab", group: "Workbench", run: (app) => app.closeActiveStageTab?.() });
    plugin.registerCommand({ id: "workbench.next-stage-tab", label: "Next stage tab", group: "Workbench", run: (app) => app.cycleStageTab?.(1) });
    plugin.registerCommand({ id: "workbench.prev-stage-tab", label: "Previous stage tab", group: "Workbench", run: (app) => app.cycleStageTab?.(-1) });
    plugin.registerSlashCommand({ name: "reload", description: "Apply source and extension changes, then reload Tau", run: async (_args, app) => (await app.reloadWorkbench()) ? undefined : "Tau reload failed." });
    plugin.registerSlashCommand({ name: "source", description: "Open Tau's editable source", run: async (_args, app) => (await app.openWorkbenchSource()) ? undefined : "Tau source could not be opened." });
    plugin.registerSlashCommand({ name: "tree", description: "Move this thread to another point of its session tree", run: (_args, app) => app.openThreadTree("navigate") });
    plugin.registerSlashCommand({ name: "fork", description: "Start a new thread from an earlier message", run: (_args, app) => app.openThreadTree("fork") });
    plugin.registerSlashCommand({ name: "clone", description: "Duplicate this thread into a new one", run: async (_args, app) => (await app.duplicateThread()) ? undefined : "The thread could not be duplicated." });
    plugin.registerSlashCommand({
      name: "compact",
      description: "Compact the current thread's context window",
      run: async (_args, app) => {
        if (!app.compactContext) return "Context compaction is not available.";
        await app.compactContext();
        app.notify("Context compacted.");
        return undefined;
      },
    });
    plugin.registerSlashCommand({
      name: "model",
      description: "Open the model picker or select a model",
      argumentHint: "[query]",
      run: async (args, app) => {
        const query = args.trim();
        if (query && app.setModel) {
          const success = await app.setModel(query);
          if (success) {
            app.notify(`Model switched to ${query}.`);
            return undefined;
          }
          app.notify(`No model matches “${query}”.`);
          return undefined;
        }
        if (app.openModelPicker) app.openModelPicker();
        else app.openSettings("defaults");
        return undefined;
      },
    });
    plugin.registerSlashCommand({
      name: "thinking",
      description: "Set thinking level (none, low, medium, high, max)",
      argumentHint: "[level]",
      run: async (args, app) => {
        const level = args.trim().toLowerCase();
        const valid = ["none", "low", "medium", "high", "max"];
        if (level && valid.includes(level)) {
          if (app.setThinkingLevel) {
            await app.setThinkingLevel(level);
            app.notify(`Thinking level set to ${level}.`);
            return undefined;
          }
        }
        if (level && !valid.includes(level)) {
          app.notify(`Invalid thinking level: “${level}”. Valid: none, low, medium, high, max.`);
          return undefined;
        }
        app.openSettings("defaults");
        return undefined;
      },
    });
    plugin.registerSlashCommand({
      name: "new",
      description: "Start a new thread",
      run: (_args, app) => {
        app.newSession();
        return undefined;
      },
    });
    plugin.registerSlashCommand({
      name: "clear",
      description: "Clear conversation and start a new thread",
      run: (_args, app) => {
        app.newSession();
        return undefined;
      },
    });
    plugin.registerSlashCommand({
      name: "system",
      description: "Inspect active system prompt and AGENTS.md instructions",
      run: (_args, app) => {
        app.openInstructions?.();
        return undefined;
      },
    });
    plugin.registerSlashCommand({
      name: "instructions",
      description: "Inspect active system prompt and AGENTS.md instructions",
      run: (_args, app) => {
        app.openInstructions?.();
        return undefined;
      },
    });
    plugin.registerSlashCommand({
      name: "copy",
      description: "Copy chat as Markdown to clipboard",
      run: async (_args, app) => {
        if (app.copyChat) {
          await app.copyChat();
          app.notify("Chat copied as Markdown.");
          return undefined;
        }
        return "Copy chat is not available.";
      },
    });
    plugin.registerSlashCommand({
      name: "export",
      description: "Export current chat as Markdown to clipboard",
      run: async (_args, app) => {
        if (app.copyChat) {
          await app.copyChat();
          app.notify("Exported chat to clipboard as Markdown.");
          return undefined;
        }
        return "Export is not available.";
      },
    });
    plugin.registerSlashCommand({
      name: "session",
      description: "Display session details, runtime, and model info",
      run: (_args, app) => {
        const thread = app.activeThread();
        if (!thread) return "No active session.";
        const modelStr = thread.model ? `${thread.model.provider}/${thread.model.id}` : "default";
        app.notify(`Session: ${thread.sessionId ?? "new"} · Backend: ${thread.backendKind ?? "pi"} · Model: ${modelStr}`);
        return undefined;
      },
    });
    plugin.registerSlashCommand({
      name: "help",
      description: "Open command palette and list shortcuts",
      run: (_args, app) => {
        app.openCommandPalette();
        return undefined;
      },
    });
    plugin.registerCommand({
      id: "runtime.instructions",
      label: "Inspect active system prompt & instructions",
      group: "Thread",
      run: (app) => app.openInstructions?.(),
    });
    plugin.registerCommand({
      id: "runtime.copy-chat",
      label: "Copy chat as Markdown",
      group: "Thread",
      run: async (app) => {
        if (app.copyChat) {
          await app.copyChat();
          app.notify("Chat copied as Markdown.");
        }
      },
    });
    plugin.registerCommand({
      id: "runtime.rename-thread",
      label: "Rename thread",
      group: "Thread",
      run: async (app) => {
        const currentTitle = app.activeThread()?.sessionId ?? "";
        const next = window.prompt("New thread title:", currentTitle);
        if (next && next.trim() && app.renameThread) {
          await app.renameThread(next.trim());
          app.notify(`Thread renamed to “${next.trim()}”.`);
        }
      },
    });
    plugin.registerCommand({
      id: "runtime.cycle-model",
      label: "Cycle model forward",
      group: "Runtime",
      run: async (app) => {
        if (app.cycleModel) {
          await app.cycleModel(1);
        }
      },
    });
    plugin.registerCommand({
      id: "runtime.cycle-model-backward",
      label: "Cycle model backward",
      group: "Runtime",
      run: async (app) => {
        if (app.cycleModel) {
          await app.cycleModel(-1);
        }
      },
    });
    plugin.registerCommand({
      id: "runtime.cycle-thinking",
      label: "Cycle thinking level",
      group: "Thread",
      run: async (app) => {
        if (app.cycleThinking) {
          await app.cycleThinking();
        }
      },
    });
    plugin.registerCommand({
      id: "runtime.open-prompt-editor",
      label: "Open prompt in external editor",
      group: "Composer",
      run: async (app) => {
        if (app.openPromptEditor) {
          await app.openPromptEditor();
        }
      },
    });
    plugin.registerSlashCommand({
      name: "name",
      description: "Rename the current thread / session",
      argumentHint: "<title>",
      run: async (args, app) => {
        const title = args.trim();
        if (!title) return "Usage: /name <title>";
        if (app.renameThread) {
          const ok = await app.renameThread(title);
          if (ok) {
            app.notify(`Thread renamed to “${title}”.`);
            return undefined;
          }
        }
        return "Could not rename thread.";
      },
    });
    plugin.registerSlashCommand({
      name: "hotkeys",
      description: "View keyboard shortcuts and keybindings",
      run: (_args, app) => {
        app.openSettings("keybindings");
        return undefined;
      },
    });
    plugin.registerSlashCommand({
      name: "scoped-models",
      description: "Manage scoped models for quick cycling (Ctrl+P / Alt+P)",
      run: (_args, app) => {
        if (app.openModelPicker) app.openModelPicker();
        else app.openSettings("defaults");
        return undefined;
      },
    });
    plugin.registerKeybinding({ keys: "mod+i", commandId: "runtime.instructions" });
    plugin.registerKeybinding({ keys: "mod+k", commandId: "runtime.command-palette" });
    plugin.registerKeybinding({ keys: "mod+n", commandId: "runtime.new-session" });
    plugin.registerKeybinding({ keys: "escape", commandId: "runtime.abort" });
    plugin.registerKeybinding({ keys: "mod+shift+t", commandId: "runtime.transcript-detail" });
    plugin.registerKeybinding({ keys: "mod+shift+m", commandId: "runtime.model" });
    plugin.registerKeybinding({ keys: "ctrl+p", commandId: "runtime.cycle-model" });
    plugin.registerKeybinding({ keys: "shift+tab", commandId: "runtime.cycle-thinking" });
    plugin.registerKeybinding({ keys: "mod+shift+r", commandId: "runtime.rename-thread" });
    plugin.registerKeybinding({ keys: "ctrl+g", commandId: "runtime.open-prompt-editor" });
    plugin.registerKeybinding({ keys: "mod+1", commandId: "workbench.focus-composer" });
    plugin.registerKeybinding({ keys: "mod+2", commandId: "workbench.focus-transcript" });
    plugin.registerKeybinding({ keys: "mod+3", commandId: "workbench.focus-stage" });
    plugin.registerKeybinding({ keys: "mod+b", commandId: "workbench.toggle-dock" });
    plugin.registerKeybinding({ keys: "mod+w", commandId: "workbench.close-stage-tab" });
    plugin.registerKeybinding({ keys: "mod+shift+]", commandId: "workbench.next-stage-tab" });
    plugin.registerKeybinding({ keys: "mod+shift+[", commandId: "workbench.prev-stage-tab" });
    plugin.registerKeybinding({ keys: "ctrl+tab", commandId: "workbench.next-stage-tab" });
    plugin.registerKeybinding({ keys: "ctrl+shift+tab", commandId: "workbench.prev-stage-tab" });
  },
};
