import { lazy } from "react";
import { HostUnavailableError, type DesktopExtension, type DesktopExtensionContext, type WorkbenchActions } from "../extension-system";
import { errorMessage } from "../error-message";
import type { PiKeybindingsState, PiShortcutsState } from "../../shared/keybindings-protocol";

// Keep optional extension UI out of the workbench's first renderer chunk. The
// registry still owns activation; React loads a contribution when its slot is
// actually rendered.
const LazyPreviewPanel = lazy(() => import("./preview-panel").then(({ PreviewPanel }) => ({ default: PreviewPanel })));
const LazyObservatoryPanel = lazy(() => import("./observatory-panel").then(({ ObservatoryPanel }) => ({ default: ObservatoryPanel })));
import { accessKitExtension } from "./access-kit";
import { claudeCodeExtension } from "./claude-code-kit";
import { ReviewOverlay, REVIEW_OVERLAY, WORKSPACE_STORE_SERVICE, type ReviewWorkspaceStore } from "./review-overlay";
import { computerUsePresentationExtension } from "./computer-use";
import { serviceTierKitExtension } from "./service-tier-kit";
import { agentsExtension } from "./agents-kit";
import { piUiExtension } from "./pi-ui";
import { PREVIEW_PANEL, PreviewFollower, isPreviewState, previewKit, previewStore } from "./preview-store";
import { PREVIEW_HOST_EXTENSION_ID, PREVIEW_STATE_EVENT } from "../../shared/preview-protocol";
import { packagesExtension } from "./packages-kit";
import { questionnaireExtension } from "./questionnaire-kit";
import { COMMIT_MESSAGE_OPTIONS, registerCommitMessages } from "./commit-messages";

export const reviewExtension: DesktopExtension = {
  id: "tau.review",
  name: "Review Kit",
  activate(plugin) {
    plugin.registerOptions([
      { id: "split-diff", kind: "toggle", label: "Open diffs in split view", defaultValue: false },
      ...COMMIT_MESSAGE_OPTIONS,
    ]);
    plugin.registerCommand({ id: "review.changes", label: "Inspect Git changes", group: "Project", run: (app) => app.openPanel("changes") });
    // Everything below reads the workspace a kit owns; without that kit there
    // is no worktree to review, so the contributions come and go with it.
    return plugin.useService<ReviewWorkspaceStore>(WORKSPACE_STORE_SERVICE, (workspace) => {
      const disposers = [
        plugin.registerOverlay({ id: REVIEW_OVERLAY, Component: (props) => <ReviewOverlay {...props} workspace={workspace} /> }),
        plugin.registerCommand({ id: "review.open", label: "Review changes", group: "Project", run: () => workspace.openReview() }),
        plugin.registerKeybinding({ keys: "mod+shift+d", commandId: "review.open" }),
        registerCommitMessages(plugin, workspace),
      ];
      return () => { for (const dispose of disposers.reverse()) dispose(); };
    });
  },
};

export const observatoryExtension: DesktopExtension = {
  id: "tau.observatory",
  name: "Signals",
  activate(plugin) {
    plugin.registerPanel({ id: "observatory", label: "Signals", glyph: "signals", order: 30, Component: LazyObservatoryPanel });
    plugin.registerCommand({ id: "observatory.open", label: "Open signals panel", group: "Extensions", run: (app) => app.openPanel("observatory") });
    plugin.registerKeybinding({ keys: "mod+shift+o", commandId: "observatory.open" });
    plugin.registerToolRenderer(
      "observatory.shell-renderer",
      (tool) => tool.name === "bash" || tool.name === "powershell",
      (tool) => ({
        glyph: "$",
        title: tool.name,
        tone: "shell",
        detail: String(tool.args.command ?? "shell command"),
      }),
    );
  },
};

/**
 * Tau's chords for the runtime commands, and the Pi action whose entry in
 * `~/.pi/agent/keybindings.json` replaces each of them when the user set one.
 */
const RUNTIME_KEYBINDINGS: ReadonlyArray<{ commandId: string; keys?: string; piAction?: string }> = [
  { commandId: "runtime.command-palette", keys: "mod+k" },
  { commandId: "runtime.new-session", keys: "mod+n", piAction: "app.session.new" },
  { commandId: "runtime.abort", keys: "escape", piAction: "app.interrupt" },
  { commandId: "runtime.model", piAction: "app.model.select" },
  { commandId: "runtime.toggle-thinking", piAction: "app.thinking.toggle" },
];

// No host, or a host without this extension's entry (safe mode): Tau's chords stay.
const ignoreHostUnavailable = (error: unknown) => {
  if (error instanceof HostUnavailableError || /is not installed/u.test(errorMessage(error))) return;
  console.warn("Pi keybindings are unavailable", error);
};

function bindRuntimeKeys(plugin: DesktopExtensionContext, isDisposed: () => boolean): void {
  const defaults = new Map<string, () => void>();
  for (const entry of RUNTIME_KEYBINDINGS) {
    if (entry.keys) defaults.set(entry.commandId, plugin.registerKeybinding({ keys: entry.keys, commandId: entry.commandId }));
  }
  void plugin.host.invoke("pi-keybindings").then((state) => {
    if (isDisposed()) return;
    const bindings = (state as PiKeybindingsState).bindings;
    for (const entry of RUNTIME_KEYBINDINGS) {
      const keys = entry.piAction ? bindings[entry.piAction] : undefined;
      if (!keys?.length) continue;
      defaults.get(entry.commandId)?.();
      for (const chord of keys) {
        try { plugin.registerKeybinding({ keys: chord, commandId: entry.commandId }); } catch (error) { console.warn(`keybindings.json: ${entry.piAction} = ${chord} is not a chord Tau understands`, error); }
      }
    }
  }).catch(ignoreHostUnavailable);
}

/** Shortcuts Pi extensions registered: a palette command each, bound to the same chord. */
function bindPiShortcuts(plugin: DesktopExtensionContext, isDisposed: () => boolean): () => void {
  let disposers: Array<() => void> = [];
  const clear = () => { disposers.forEach((dispose) => dispose()); disposers = []; };
  const refresh = (sessionId?: string) => plugin.host.invoke("shortcuts", sessionId ? { sessionId } : undefined).then((state) => {
    if (isDisposed()) return;
    clear();
    for (const shortcut of (state as PiShortcutsState).shortcuts) {
      const id = `pi.shortcut.${shortcut.keys}`;
      try {
        disposers.push(plugin.registerCommand({
          id,
          label: shortcut.description ?? `Pi shortcut ${shortcut.keys}`,
          group: "Pi",
          run: async (app) => {
            try { await plugin.host.invoke("run-shortcut", { keys: shortcut.keys, sessionId: app.activeThread()?.sessionId }); } catch (error) { app.notify(errorMessage(error)); }
          },
        }));
        disposers.push(plugin.registerKeybinding({ keys: shortcut.keys, commandId: id }));
      } catch (error) {
        console.warn(`Pi shortcut ${shortcut.keys} from ${shortcut.source} could not be bound`, error);
      }
    }
  }).catch(ignoreHostUnavailable);
  void refresh();
  plugin.events.on("active-thread-changed", (event) => void refresh(event.sessionId));
  return clear;
}

/**
 * Preview Kit: a browser panel the host draws over, and the tools that let the
 * agent open, read and drive the page it just changed.
 */
export const previewExtension: DesktopExtension = {
  id: PREVIEW_HOST_EXTENSION_ID,
  name: "Preview",
  activate(plugin) {
    plugin.registerPanel({ id: PREVIEW_PANEL, label: "Preview", glyph: "preview", order: 40, Component: LazyPreviewPanel });
    plugin.registerRegion({ id: "preview.follower", placement: "composer-above", order: 60, Component: PreviewFollower });
    plugin.host.onEvent(PREVIEW_STATE_EVENT, (payload) => { if (isPreviewState(payload)) previewStore.set(payload); });
    const open = async (url: string, app: WorkbenchActions): Promise<string | undefined> => {
      app.openPanel(PREVIEW_PANEL);
      if (!url) return undefined;
      try {
        await previewKit.open({ url });
      } catch (error) {
        return errorMessage(error);
      }
      return undefined;
    };
    plugin.registerCommand({ id: "preview.open", label: "Open preview panel", group: "Extensions", run: (app) => { void open("", app); } });
    plugin.registerSlashCommand({
      name: "preview",
      description: "Open a URL in the preview panel",
      argumentHint: "<url>",
      run: (args, app) => open(args.trim(), app),
    });
    plugin.registerKeybinding({ keys: "mod+shift+b", commandId: "preview.open" });
  },
};

export const settingsExtension: DesktopExtension = {
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
    let disposed = false;
    bindRuntimeKeys(plugin, () => disposed);
    const clearShortcuts = bindPiShortcuts(plugin, () => disposed);
    return () => { disposed = true; clearShortcuts(); };
  },
};

export const bundledExtensions = [
  accessKitExtension,
  serviceTierKitExtension,
  reviewExtension,
  observatoryExtension,
  computerUsePresentationExtension,
  agentsExtension,
  piUiExtension,
  previewExtension,
  questionnaireExtension,
  packagesExtension,
  settingsExtension,
  claudeCodeExtension,
];
