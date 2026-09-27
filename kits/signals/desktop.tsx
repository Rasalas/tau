import { Activity } from "lucide-react";
import { useObservatory, type DesktopExtension } from "tau";
import { SIGNALS_EXTENSION_ID, SIGNALS_SETTINGS_PAGE } from "./protocol.js";

/** What the workbench is doing right now: host events, live counts, tool runs. A tool for Tau's own development, so it lives in Settings. */
export function SignalsPage() {
  const { events, snapshot, tools, registry } = useObservatory();

  return (
    <section className="signals-page">
      <p className="signals-note"><span className="live-marker"><i /> live</span> What this window and its host are doing, for debugging Tau itself.</p>
      <dl className="state-grid">
        <div><dt>Session</dt><dd>{snapshot?.sessionId.slice(0, 8) ?? "—"}</dd></div>
        <div><dt>Pi extensions</dt><dd>{snapshot?.extensionCount ?? 0}</dd></div>
        <div><dt>Desktop extensions</dt><dd>{registry.getExtensionNames().length}</dd></div>
        <div><dt>Tool runs</dt><dd>{tools.length}</dd></div>
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
    plugin.registerSettingsPage({
      id: SIGNALS_SETTINGS_PAGE, label: "Signals", Icon: Activity, group: "diagnostics", order: 90, profiles: ["desktop", "web"],
      keywords: ["developer", "debug", "events", "diagnostics"], Component: SignalsPage,
    });
    plugin.registerCommand({ id: "observatory.open", label: "Open Signals", group: "Extensions", access: "read", run: (app) => app.openSettings(SIGNALS_SETTINGS_PAGE) });
    // `mod+shift+o` is a new thread, as in T3 Code.
    plugin.registerKeybinding({ keys: "mod+alt+o", commandId: "observatory.open" });
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
      { profiles: ["desktop", "web", "compact"] },
    );
  },
};

export default observatoryExtension;
