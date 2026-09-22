import { Terminal } from "lucide-react";
import type { DesktopExtension } from "tau";
import { TerminalPanel } from "./panel.js";
import { TerminalStageTab, terminalTabParams } from "./stage-tab.js";
import { connectTerminalFont, connectTerminalHost, terminalStore } from "./store.js";
import { TerminalSettingsPage } from "./settings.js";
import { TERMINAL_HOST_EXTENSION_ID, TERMINAL_PANEL, TERMINAL_PANEL_ORDER, TERMINAL_STAGE_TAB } from "./protocol.js";

export const terminalExtension: DesktopExtension = {
  id: TERMINAL_HOST_EXTENSION_ID,
  name: "Terminal",
  activate(plugin) {
    const disconnect = connectTerminalHost(plugin.host);
    const stopFont = connectTerminalFont(plugin.preferences);
    // The panel groups terminals by the thread on screen; the event is the
    // only push a kit gets about a switch, so the store follows it here.
    plugin.events.on("active-thread-changed", (event) => terminalStore.setActiveSession(event.sessionId));
    const panel = plugin.registerPanel({ id: TERMINAL_PANEL, label: "Terminal", Icon: Terminal, order: TERMINAL_PANEL_ORDER, profiles: ["desktop", "web"], Component: TerminalPanel });
    // A terminal is the same shell wherever it is drawn: the pty lives in the
    // host, so moving one onto the stage never ends it.
    const stageTab = plugin.registerStageTab({
      kind: TERMINAL_STAGE_TAB,
      profiles: ["desktop", "web"],
      title: (params) => terminalTabParams(params).label,
      Icon: Terminal,
      render: (params, handle) => <TerminalStageTab params={terminalTabParams(params)} handle={handle} />,
    });
    const settings = plugin.registerSettingsPage({
      id: "terminal.settings",
      label: "Terminal",
      Icon: Terminal,
      order: 30,
      profiles: ["desktop", "web"],
      Component: (props) => <TerminalSettingsPage {...props} preferences={plugin.preferences} />,
    });
    const command = plugin.registerCommand({ id: "terminal.open", label: "Open terminal panel", group: "Extensions", run: (app) => app.openPanel(TERMINAL_PANEL) });
    return () => {
      command();
      settings();
      stopFont();
      stageTab();
      panel();
      disconnect();
    };
  },
};

export default terminalExtension;
