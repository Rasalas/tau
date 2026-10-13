import { Terminal } from "lucide-react";
import { Badge, SettingsSection, SettingsState, ValueList, useObservatory, type DesktopExtension } from "tau";
import { SIGNALS_EXTENSION_ID, SIGNALS_SETTINGS_PAGE } from "./protocol.js";

/** What the workbench is doing right now: host events, live counts, tool runs. A tool for Tau's own development, so it sits in Settings → Diagnostics. */
export function SignalsSections() {
  const { events, snapshot, tools, registry } = useObservatory();

  return (
    <>
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
    </>
  );
}

/** The sections, for the Settings search. */
export const SIGNALS_SETTINGS_ROWS = [
  { id: "setting-signals-now", label: "Now", keywords: ["signals", "session", "extensions", "tool runs", "counts"] },
  { id: "setting-signals-events", label: "Host events", keywords: ["signals", "events", "log", "stream"] },
];

export const observatoryExtension: DesktopExtension = {
  id: SIGNALS_EXTENSION_ID,
  name: "Signals",
  activate(plugin) {
    // Below Diagnostics' own sections (API 1.61.0); the page Signals had before opens Diagnostics.
    plugin.registerSettingsSection({
      id: "observatory.signals", page: "inspector", order: 10, profiles: ["desktop", "web"], replaces: [SIGNALS_SETTINGS_PAGE],
      rows: SIGNALS_SETTINGS_ROWS, Component: SignalsSections,
    });
    plugin.registerCommand({ id: "observatory.open", label: "Open Signals", group: "Extensions", access: "read", run: (app) => app.openSettings("inspector#setting-signals-now") });
    // `mod+shift+o` is already New thread.
    plugin.registerKeybinding({ keys: "mod+alt+o", commandId: "observatory.open" });
    // A shell command is the one tool run whose own text says what happened.
    plugin.registerToolRenderer(
      "observatory.shell-renderer",
      (tool) => tool.name === "bash" || tool.name === "powershell",
      (tool) => ({
        glyph: <Terminal size={13} />,
        title: tool.name,
        tone: "shell",
        detail: String(tool.args.command ?? "shell command"),
      }),
      { profiles: ["desktop", "web", "compact"] },
    );
  },
};

export default observatoryExtension;
