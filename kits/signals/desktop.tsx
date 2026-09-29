import { Activity } from "lucide-react";
import { Badge, SettingsSection, SettingsState, ValueList, useObservatory, type DesktopExtension } from "tau";
import { SIGNALS_EXTENSION_ID, SIGNALS_SETTINGS_PAGE } from "./protocol.js";

/** What the workbench is doing right now: host events, live counts, tool runs. A tool for Tau's own development, so it lives in Settings. */
export function SignalsPage() {
  const { events, snapshot, tools, registry } = useObservatory();

  return (
    <div className="settings-page signals-page">
      <h3>Signals</h3>
      <SettingsSection id="setting-signals-now" title="Now" plain headerAction={<Badge tone="success" dot>Live</Badge>}>
        <ValueList label="Now" items={[
          { label: "Session", value: snapshot?.sessionId.slice(0, 8) ?? "None", mono: true, ...(snapshot?.sessionId ? { copy: snapshot.sessionId } : {}) },
          { label: "Pi extensions", value: snapshot?.extensionCount ?? 0, mono: true },
          { label: "Desktop extensions", value: registry.getExtensionNames().length, mono: true },
          { label: "Tool runs", value: tools.length, mono: true },
        ]} />
      </SettingsSection>
      <SettingsSection id="setting-signals-events" title="Host events" plain>
        {events.length === 0 ? <SettingsState kind="empty" title="No host events yet" description="They appear here, newest first, as the host sends them." /> : (
          <div className="event-stream" role="log" aria-label="Host events">
            {[...events].reverse().map((event) => (
              <article className="event-row" key={event.id}>
                <time>{new Date(event.timestamp).toLocaleTimeString([], { hour12: false })}</time>
                <strong>{event.label}</strong>
                <span title={event.detail}>{event.detail}</span>
              </article>
            ))}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}

/** The page's sections, for the Settings search. */
export const SIGNALS_SETTINGS_ROWS = [
  { id: "setting-signals-now", label: "Now", keywords: ["session", "extensions", "tool runs", "counts"] },
  { id: "setting-signals-events", label: "Host events", keywords: ["events", "log", "stream"] },
];

export const observatoryExtension: DesktopExtension = {
  id: SIGNALS_EXTENSION_ID,
  name: "Signals",
  activate(plugin) {
    plugin.registerSettingsPage({
      id: SIGNALS_SETTINGS_PAGE, label: "Signals", description: "What this window and its host are doing, for debugging Tau itself.", Icon: Activity, group: "diagnostics", order: 90, profiles: ["desktop", "web"],
      keywords: ["developer", "debug", "events", "diagnostics"], Component: SignalsPage,
      rows: SIGNALS_SETTINGS_ROWS,
    });
    plugin.registerCommand({ id: "observatory.open", label: "Open Signals", group: "Extensions", access: "read", run: (app) => app.openSettings(SIGNALS_SETTINGS_PAGE) });
    // `mod+shift+o` is already New thread.
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
