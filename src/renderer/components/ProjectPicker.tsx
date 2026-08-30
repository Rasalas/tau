import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { UiProject } from "../../shared/contracts";
import { VirtualList } from "./VirtualList";

interface ProjectPickerProps {
  activePath?: string;
  open: boolean;
  projects: readonly UiProject[];
  onBrowse: () => void;
  onClose: () => void;
  onSelect: (project: UiProject) => void;
}

function projectInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "·";
}

function compactPath(path: string): string {
  const home = path.match(/^\/Users\/[^/]+/u)?.[0];
  return home ? path.replace(home, "~") : path;
}

export function ProjectPicker({
  activePath,
  open,
  projects,
  onBrowse,
  onClose,
  onSelect,
}: ProjectPickerProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return projects;
    return projects.filter((project) =>
      `${project.name} ${project.path}`.toLocaleLowerCase().includes(needle),
    );
  }, [projects, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    setSelected((index) => Math.min(index, Math.max(0, matches.length - 1)));
  }, [matches.length]);

  if (!open) return null;

  const activateSelected = () => {
    const project = matches[selected];
    if (project) onSelect(project);
  };

  return (
    <>
      <button className="project-picker-scrim" aria-label="Close project picker" onClick={onClose} />
      <section className="project-picker" role="dialog" aria-modal="true" aria-label="Search projects">
        <header>
          <span className="project-picker-search-glyph"><Search size={15} /></span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((index) => Math.min(index + 1, Math.max(0, matches.length - 1)));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((index) => Math.max(index - 1, 0));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                activateSelected();
              }
            }}
            placeholder="Search projects"
            aria-label="Search projects"
          />
          <kbd>esc</kbd>
        </header>
        <div className="project-picker-heading">
          <span>Projects</span>
          <small>{matches.length}</small>
        </div>
        <VirtualList
          items={matches}
          itemHeight={56}
          overscan={6}
          className="project-picker-results"
          role="listbox"
          scrollToIndex={selected}
          empty={<p>No matching projects</p>}
          renderItem={(project, index) => (
            <button
              key={project.path}
              role="option"
              aria-selected={selected === index}
              className={selected === index ? "selected" : ""}
              onMouseMove={() => setSelected(index)}
              onClick={() => onSelect(project)}
            >
              <i>{projectInitial(project.name)}</i>
              <span>
                <strong>{project.name}</strong>
                <small>{compactPath(project.path)}</small>
              </span>
              {project.path === activePath ? <em>active</em> : null}
            </button>
          )}
        />
        <footer>
          <button onClick={onBrowse}><span>＋</span> Add project from another source…</button>
          <small><kbd>↑↓</kbd> select <kbd>↵</kbd> open</small>
        </footer>
      </section>
    </>
  );
}
