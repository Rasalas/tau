import { Terminal } from "lucide-react";
import type { DesktopExtension } from "tau";
import { TerminalPanel } from "./panel.js";
import { connectTerminalHost, terminalStore } from "./store.js";
import { TERMINAL_HOST_EXTENSION_ID, TERMINAL_PANEL, TERMINAL_PANEL_ORDER } from "./protocol.js";

export const terminalExtension: DesktopExtension = {
  id: TERMINAL_HOST_EXTENSION_ID,
  name: "Terminal",
  activate(plugin) {
    const disconnect = connectTerminalHost(plugin.host);
    // The panel groups terminals by the thread on screen; the event is the
    // only push a kit gets about a switch, so the store follows it here.
    plugin.events.on("active-thread-changed", (event) => terminalStore.setActiveSession(event.sessionId));
    const panel = plugin.registerPanel({ id: TERMINAL_PANEL, label: "Terminal", Icon: Terminal, order: TERMINAL_PANEL_ORDER, profiles: ["desktop", "web"], Component: TerminalPanel });
    const command = plugin.registerCommand({ id: "terminal.open", label: "Open terminal panel", group: "Extensions", run: (app) => app.openPanel(TERMINAL_PANEL) });
    return () => {
      command();
      panel();
      disconnect();
    };
  },
};

export default terminalExtension;
