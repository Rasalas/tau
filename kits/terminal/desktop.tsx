import { Terminal } from "lucide-react";
import type { DesktopExtension, WorkbenchActions } from "tau";
import { TerminalPanel } from "./panel.js";
import { restoreTerminalTab, TerminalStageTab, terminalTabParams } from "./stage-tab.js";
import { connectTerminalFont, connectTerminalHost, terminalServices, terminalStore } from "./store.js";
import { TerminalSettingsPage } from "./settings.js";
import { focusedPane, paneIds } from "./layout.js";
import { closeTerminals, focusNextPane, openTerminal, toggleTerminal } from "./controller.js";
import {
  COMPOSER_CONTEXT_CHIPS_SERVICE,
  PREVIEW_BROWSER_SERVICE,
  TERMINAL_COMMANDS,
  TERMINAL_HOST_EXTENSION_ID,
  TERMINAL_PANEL,
  TERMINAL_PANEL_ORDER,
  TERMINAL_STAGE_TAB,
  type ComposerContextChips,
  type PreviewBrowserService,
} from "./protocol.js";

/** A command keeps the actions it ran with, so a link clicked later has them too. */
function withActions(run: (actions: WorkbenchActions) => unknown) {
  return async (actions: WorkbenchActions) => {
    terminalServices.actions = actions;
    await run(actions);
  };
}

/** The shell a command without a pane of its own acts on: the panel's focused one. */
function focusedShell(): string | undefined {
  return focusedPane(terminalStore.getSnapshot().layout);
}

export const terminalExtension: DesktopExtension = {
  id: TERMINAL_HOST_EXTENSION_ID,
  name: "Terminal",
  activate(plugin) {
    const disconnect = connectTerminalHost(plugin.host);
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
    ];
    const panel = plugin.registerPanel({ id: TERMINAL_PANEL, label: "Terminal", Icon: Terminal, order: TERMINAL_PANEL_ORDER, profiles: ["desktop", "web"], Component: TerminalPanel });
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
        run: withActions((app) => { app.openPanel(TERMINAL_PANEL); return openTerminal(app, { direction: "right" }); }),
      }),
      plugin.registerCommand({
        id: TERMINAL_COMMANDS.splitDown,
        label: "Split terminal down",
        group: "Terminal",
        run: withActions((app) => { app.openPanel(TERMINAL_PANEL); return openTerminal(app, { direction: "down" }); }),
      }),
      plugin.registerCommand({
        id: TERMINAL_COMMANDS.close,
        label: "Close terminal",
        group: "Terminal",
        run: withActions(async () => {
          const id = focusedShell();
          if (id) await closeTerminals([id]);
        }),
      }),
      plugin.registerCommand({
        id: TERMINAL_COMMANDS.focusNext,
        label: "Focus next terminal",
        group: "Terminal",
        run: withActions((app) => {
          const layout = terminalStore.getSnapshot().layout;
          const group = layout.groups.find((entry) => entry.id === layout.active);
          app.openPanel(TERMINAL_PANEL);
          if (group && paneIds(group.root).length > 1) focusNextPane(1);
          else if (group) terminalStore.requestFocus(group.focused);
        }),
      }),
      // The embedded terminal is mod+j, as in T3 Code; the chords that act on a
      // focused shell (split, new, close) are the terminal's own, see keys.ts.
      plugin.registerKeybinding({ keys: "mod+j", commandId: TERMINAL_COMMANDS.toggle }),
    ];
    return () => {
      for (const dispose of disposers.reverse()) dispose();
      settings();
      stageTab();
      panel();
      for (const dispose of services) dispose();
      stopFont();
      disconnect();
    };
  },
};

export default terminalExtension;
