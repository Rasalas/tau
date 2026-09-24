import { useEffect, useState } from "react";
import type { ContributionOwner, ProjectSourceContribution, WorkbenchActions } from "../extension-system";

/**
 * The list of project sources extensions registered, and the source's own view
 * once one is chosen. Core owns this placement; sources are contributions.
 */
export function ProjectSourcesModal({
  actions,
  onClose,
  sources,
  initialSource,
}: {
  actions: WorkbenchActions;
  onClose(): void;
  sources: Array<ProjectSourceContribution & ContributionOwner>;
  /** A source with its own view to open on, instead of the list. */
  initialSource?: string;
}) {
  const [activeSourceId, setActiveSourceId] = useState<string | undefined>(() => sources.find((source) => source.id === initialSource && source.Component)?.id);
  const [busySourceId, setBusySourceId] = useState<string>();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const activeSource = sources.find((source) => source.id === activeSourceId);
  const visibleSources = sources.filter((source) => fuzzyMatch(`${source.label} ${source.description}`, query.trim()));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (activeSourceId) setActiveSourceId(undefined);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSourceId, onClose]);

  const selectSource = async (source: ProjectSourceContribution) => {
    if (source.Component) {
      setActiveSourceId(source.id);
      return;
    }
    setBusySourceId(source.id);
    try {
      const completed = await source.run(actions);
      if (completed !== false) onClose();
    } finally {
      setBusySourceId(undefined);
    }
  };

  const SourceComponent = activeSource?.Component;
  return (
    <>
      <button className="project-modal-scrim" aria-label="Close add project" onClick={onClose} />
      <section className="project-modal" role="dialog" aria-modal="true" aria-label="Add project">
        {activeSource?.id === "workspace.local-folder" ? null : <header className={`project-modal-title${SourceComponent ? " source-open" : ""}`}>
          <button className="modal-back" onClick={() => SourceComponent ? setActiveSourceId(undefined) : onClose()}>←</button>
          {SourceComponent ? <span><small>Project source</small><strong>{activeSource?.label}</strong></span> : <input
            autoFocus
            value={query}
            onChange={(event) => { setQuery(event.target.value); setSelected(0); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); setSelected((value) => Math.min(value + 1, Math.max(0, visibleSources.length - 1))); }
              if (event.key === "ArrowUp") { event.preventDefault(); setSelected((value) => Math.max(0, value - 1)); }
              if (event.key === "Enter" && visibleSources[selected]) { event.preventDefault(); void selectSource(visibleSources[selected]); }
            }}
            placeholder="Search project sources…"
            aria-label="Search project sources"
          />}
          <button className="modal-close" onClick={onClose}>esc</button>
        </header>}
        {SourceComponent ? (
          <SourceComponent actions={actions} onBack={() => setActiveSourceId(undefined)} onDone={onClose} />
        ) : (
          <>
            <div className="project-source-intro"><span>Sources</span></div>
            <div className="project-source-list">
              {visibleSources.map((source, index) => (
                <button className={selected === index ? "selected" : ""} key={source.id} disabled={Boolean(busySourceId)} onMouseMove={() => setSelected(index)} onClick={() => void selectSource(source)}>
                  <i>{source.glyph}</i>
                  <span><strong>{source.label}</strong><small>{source.description}</small></span>
                  <b>{busySourceId === source.id ? "working…" : "→"}</b>
                </button>
              ))}
              {visibleSources.length === 0 ? <p>No matching project sources.</p> : null}
            </div>
            <footer className="project-modal-help keyboard-hint"><kbd>↑↓</kbd> Navigate <kbd>Enter</kbd> Select <kbd>Esc</kbd> Close</footer>
          </>
        )}
      </section>
    </>
  );
}


function fuzzyMatch(value: string, query: string): boolean {
  let at = 0;
  const haystack = value.toLocaleLowerCase();
  for (const character of query.toLocaleLowerCase()) {
    at = haystack.indexOf(character, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
}
