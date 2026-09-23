import { Terminal } from "lucide-react";
import type { DesktopExtension, WorkbenchActions } from "tau";
import { TerminalPanel } from "./panel.js";
import { restoreTerminalTab, TerminalStageTab, terminalTabParams } from "./stage-tab.js";
import { connectTerminalFont, connectTerminalHost, createTerminalFontService, terminalKit, terminalServices, terminalStore } from "./store.js";
import { TerminalSettingsPage } from "./settings.js";
import { paneIds } from "./layout.js";
import { closeTerminals, focusNextPane, keyboardShell, onStage, openTerminal, runInTerminal, targetShell, toggleTerminal } from "./controller.js";
import {
  COMPOSER_CONTEXT_CHIPS_SERVICE,
  PREVIEW_BROWSER_SERVICE,
  TERMINAL_COMMANDS,
  TERMINAL_FONT_SERVICE,
  TERMINAL_HOST_EXTENSION_ID,
  TERMINAL_PANEL,
  TERMINAL_PANEL_ORDER,
  TERMINAL_PLACEMENT_SETTING,
  TERMINAL_RUN_SERVICE,
  TERMINAL_STAGE_TAB,
  terminalPlacement,
  type TerminalFontService,
  type TerminalRunService,
  type ComposerContextChips,
  type PreviewBrowserService,
  WORKSPACE_STORE_SERVICE,
  type WorkspaceStoreMirror,
} from "./protocol.js";
import { TerminalRowStatus, watchForegrounds } from "./row-status.js";

/** A command keeps the actions it ran with, so a link clicked later has them too. */
function withActions(run: (actions: WorkbenchActions) => unknown) {
  return async (actions: WorkbenchActions) => {
    terminalServices.actions = actions;
    await run(actions);
  };
}

/**
 * T3 Code's chords. Splitting and moving between panes work in the panel and
 * in a stage tab alike; on the stage `mod+w` closes the tab, which hands its
 * shells back to the panel. `mod+j` is bound twice so a shell never takes it,
 * whatever `mod` is here.
 */
export const TERMINAL_KEYBINDINGS: ReadonlyArray<{ keys: string; commandId: string; when?: string }> = [
  { keys: "mod+j", commandId: TERMINAL_COMMANDS.toggle },
  { keys: "mod+j", commandId: TERMINAL_COMMANDS.toggle, when: "terminalFocus" },
  { keys: "mod+n", commandId: TERMINAL_COMMANDS.new, when: "terminalFocus" },
  { keys: "mod+d", commandId: TERMINAL_COMMANDS.split, when: "terminalFocus" },
  { keys: "mod+shift+d", commandId: TERMINAL_COMMANDS.splitDown, when: "terminalFocus" },
  { keys: "mod+w", commandId: TERMINAL_COMMANDS.close, when: "terminalFocus && !stageFocus" },
  { keys: "mod+]", commandId: TERMINAL_COMMANDS.focusNext, when: "terminalFocus" },
  { keys: "mod+[", commandId: TERMINAL_COMMANDS.focusPrevious, when: "terminalFocus" },
];

function focusPane(app: WorkbenchActions, step: 1 | -1): void {
  const typing = keyboardShell();
  if (typing && onStage(typing)) {
    focusNextPane(step, typing);
    return;
  }
  const layout = terminalStore.getSnapshot().layout;
  const group = layout.groups.find((entry) => entry.id === layout.active);
  app.openPanel(TERMINAL_PANEL);
  if (group && paneIds(group.root).length > 1) focusNextPane(step);
  else if (group) terminalStore.requestFocus(group.focused);
}

/** A split beside the shell with the keyboard; the panel comes forward unless that shell is on the stage. */
function split(app: WorkbenchActions, direction: "right" | "down") {
  const target = targetShell();
  if (!target || !onStage(target)) app.openPanel(TERMINAL_PANEL);
  return openTerminal(app, { direction, ...(target ? { target } : {}) });
}

export const terminalExtension: DesktopExtension = {
  id: TERMINAL_HOST_EXTENSION_ID,
  name: "Terminal",
  activate(plugin) {
    const disconnect = connectTerminalHost(plugin.host);
    const stopForegrounds = watchForegrounds((id) => terminalKit.foreground({ id }));
    const stopFont = connectTerminalFont(plugin.preferences);
    // The panel groups terminals by the thread on screen; the event is the
    // only push a kit gets about a switch, so the store follows it here.
    plugin.events.on("active-thread-changed", (event) => terminalStore.setActiveSession(event.sessionId));
    const services = [
      plugin.useService<ComposerContextChips>(COMPOSER_CONTEXT_CHIPS_SERVICE, (chips) => {
        terminalServices.chips = chips;
        return () => { if (terminalServices.chips === chips) delete terminalServices.chips; };
      }),
      plugin.useService<PreviewBrowserService>(PREVIEW_BROWSER_SERVICE, (preview) => {
        terminalServices.preview = preview;
        return () => { if (terminalServices.preview === preview) delete terminalServices.preview; };
      }),
      plugin.useService<WorkspaceStoreMirror>(WORKSPACE_STORE_SERVICE, (workspace) => {
        terminalServices.workspace = workspace;
        const unmark = workspace.registerThreadRowAccessory(TerminalRowStatus);
        return () => {
          unmark();
          if (terminalServices.workspace === workspace) delete terminalServices.workspace;
        };
      }),
      plugin.provideService<TerminalRunService>(TERMINAL_RUN_SERVICE, { run: (request, actions) => runInTerminal(actions ?? terminalServices.actions, request) }),
      plugin.provideService<TerminalFontService>(TERMINAL_FONT_SERVICE, createTerminalFontService(plugin.preferences)),
    ];
    // The setting picks dock or drawer; changing it registers the panel again in its new place.
    const placementNow = () => terminalPlacement(plugin.preferences.value(TERMINAL_HOST_EXTENSION_ID, TERMINAL_PLACEMENT_SETTING));
    let placement = placementNow();
    const registerPanel = () => plugin.registerPanel({ id: TERMINAL_PANEL, label: "Terminal", Icon: Terminal, order: TERMINAL_PANEL_ORDER, profiles: ["desktop", "web"], placement, maximizable: true, Component: TerminalPanel });
    let panel = registerPanel();
    const stopPlacement = plugin.preferences.subscribe(() => {
      const next = placementNow();
      if (next === placement) return;
      placement = next;
      panel();
      panel = registerPanel();
    });
    // A terminal is the same shell wherever it is drawn: the pty lives in the
    // host, so moving one onto the stage never ends it.
    const stageTab = plugin.registerStageTab({
      kind: TERMINAL_STAGE_TAB,
      profiles: ["desktop", "web"],
      title: (params) => terminalTabParams(params).label,
      Icon: Terminal,
      render: (params, handle, actions) => <TerminalStageTab params={terminalTabParams(params)} handle={handle} actions={actions} />,
      restore: restoreTerminalTab,
    });
    const settings = plugin.registerSettingsPage({
      id: "terminal.settings",
      label: "Terminal",
      Icon: Terminal,
      order: 30,
      profiles: ["desktop", "web"],
      Component: (props) => <TerminalSettingsPage {...props} preferences={plugin.preferences} />,
    });
    const disposers = [
      plugin.registerCommand({ id: "terminal.open", label: "Open terminal panel", group: "Terminal", run: (app) => app.openPanel(TERMINAL_PANEL) }),
      plugin.registerCommand({ id: TERMINAL_COMMANDS.toggle, label: "Toggle terminal", group: "Terminal", run: withActions(toggleTerminal) }),
      plugin.registerCommand({
        id: TERMINAL_COMMANDS.new,
        label: "New terminal",
        group: "Terminal",
        run: withActions((app) => { app.openPanel(TERMINAL_PANEL); return openTerminal(app); }),
      }),
      plugin.registerCommand({
        id: TERMINAL_COMMANDS.split,
        label: "Split terminal right",
        group: "Terminal",
        run: withActions((app) => split(app, "right")),
      }),
      plugin.registerCommand({
        id: TERMINAL_COMMANDS.splitDown,
        label: "Split terminal down",
        group: "Terminal",
        run: withActions((app) => split(app, "down")),
      }),
      plugin.registerCommand({
        id: TERMINAL_COMMANDS.close,
        label: "Close terminal",
        group: "Terminal",
        run: withActions(async () => {
          const id = targetShell();
          if (id) await closeTerminals([id]);
        }),
      }),
      plugin.registerCommand({ id: TERMINAL_COMMANDS.focusNext, label: "Focus next terminal", group: "Terminal", run: withActions((app) => focusPane(app, 1)) }),
      plugin.registerCommand({ id: TERMINAL_COMMANDS.focusPrevious, label: "Focus previous terminal", group: "Terminal", run: withActions((app) => focusPane(app, -1)) }),
      ...TERMINAL_KEYBINDINGS.map((binding) => plugin.registerKeybinding(binding)),
    ];
    return () => {
      for (const dispose of disposers.reverse()) dispose();
      settings();
      stageTab();
      stopPlacement();
      panel();
      for (const dispose of services) dispose();
      stopFont();
      stopForegrounds();
      disconnect();
    };
  },
};

export default terminalExtension;
