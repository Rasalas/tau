import type { PanelProps } from "../extension-system";
import { useObservatory } from "../workbench-context";

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
