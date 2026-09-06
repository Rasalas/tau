import { useObservatory, type DesktopExtension, type PanelProps } from "tau";
import { SIGNALS_EXTENSION_ID, SIGNALS_PANEL } from "./protocol.js";

/** What the workbench is doing right now: host events, live counts, tool runs. */
export function ObservatoryPanel({ extensionName }: PanelProps) {
  const { events, snapshot, tools, registry } = useObservatory();

  return (
    <section className="panel-body">
      <header className="panel-header">
        <h2>Signals</h2>
        <small>{extensionName.toLowerCase()}</small>
        <span className="spacer" />
        <span className="live-marker"><i /> live</span>
      </header>
      <dl className="state-grid">
        <div><dt>SESSION</dt><dd>{snapshot?.sessionId.slice(0, 8) ?? "—"}</dd></div>
        <div><dt>PI EXTENSIONS</dt><dd>{snapshot?.extensionCount ?? 0}</dd></div>
        <div><dt>DESKTOP EXTENSIONS</dt><dd>{registry.getExtensionNames().length}</dd></div>
        <div><dt>TOOL RUNS</dt><dd>{tools.length}</dd></div>
      </dl>
      <div className="event-stream">
        {events.length === 0 ? <p className="empty-copy">Host events will appear here.</p> : null}
        {[...events].reverse().map((event) => (
          <article className="event-row" key={event.id}>
            <time>{new Date(event.timestamp).toLocaleTimeString([], { hour12: false })}</time>
            <strong>{event.label}</strong>
            <span>{event.detail}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

export const observatoryExtension: DesktopExtension = {
  id: SIGNALS_EXTENSION_ID,
  name: "Signals",
  activate(plugin) {
    plugin.registerPanel({ id: SIGNALS_PANEL, label: "Signals", glyph: "signals", order: 30, Component: ObservatoryPanel });
    plugin.registerCommand({ id: "observatory.open", label: "Open signals panel", group: "Extensions", run: (app) => app.openPanel(SIGNALS_PANEL) });
    plugin.registerKeybinding({ keys: "mod+shift+o", commandId: "observatory.open" });
    // A shell command is the one tool run whose own text says what happened.
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

export default observatoryExtension;
