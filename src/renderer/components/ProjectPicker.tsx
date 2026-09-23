import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Trash2 } from "lucide-react";
import type { UiProject } from "../../shared/contracts";
import { VirtualList } from "./VirtualList";
import { useFocusReturn } from "./ui/focus";

interface ProjectPickerProps {
  open: boolean;
  projects: readonly UiProject[];
  onBrowse: () => void;
  onClose: () => void;
  onRemove: (project: UiProject) => void | Promise<void>;
  onSelect: (project: UiProject) => void;
}

function projectInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "·";
}

/** What the host says the user should see for a project; a local host says its path. */
function projectPath(project: UiProject): string {
  return project.displayPath ?? project.path;
}

function compactPath(path: string): string {
  const home = path.match(/^\/Users\/[^/]+/u)?.[0];
  return home ? path.replace(home, "~") : path;
}

export function ProjectPicker({
  open,
  projects,
  onBrowse,
  onClose,
  onRemove,
  onSelect,
}: ProjectPickerProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ project: UiProject; x: number; y: number }>();
  const inputRef = useRef<HTMLInputElement>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  useFocusReturn(open, surfaceRef);
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return projects;
    return projects.filter((project) =>
      `${project.name} ${projectPath(project)}`.toLocaleLowerCase().includes(needle),
    );
  }, [projects, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    setContextMenu(undefined);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (contextMenu) setContextMenu(undefined);
        else onClose();
      }
      if (event.key === "Delete" && event.shiftKey) {
        const project = matches[selected];
        if (!project) return;
        event.preventDefault();
        setContextMenu(undefined);
        void onRemove(project);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contextMenu, matches, onClose, onRemove, open, selected]);

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
      <section ref={surfaceRef} className="project-picker" role="dialog" aria-modal="true" aria-label="Search projects">
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
              key={project.workspaceId ?? project.path}
              role="option"
              aria-selected={selected === index}
              className={selected === index ? "selected" : ""}
              onMouseMove={() => setSelected(index)}
              onClick={() => onSelect(project)}
              onContextMenu={(event) => {
                event.preventDefault();
                setSelected(index);
                setContextMenu({
                  project,
                  x: Math.min(event.clientX, window.innerWidth - 216),
                  y: Math.min(event.clientY, window.innerHeight - 78),
                });
              }}
            >
              <i className={project.icon ? "has-image" : ""}>
                {project.icon ? <img src={project.icon} alt="" aria-hidden="true" /> : projectInitial(project.name)}
              </i>
              <span>
                <strong>{project.name}</strong>
                <small>{compactPath(projectPath(project))}</small>
              </span>
            </button>
          )}
        />
        <footer>
          <button onClick={onBrowse}><span>＋</span> Add project from another source…</button>
          <small><kbd>↑↓</kbd> select <kbd>↵</kbd> open</small>
        </footer>
      </section>
      {contextMenu ? <div
        className="project-picker-context-menu"
        role="menu"
        style={{ left: contextMenu.x, top: contextMenu.y }}
      >
        <button type="button" role="menuitem" onClick={() => {
          const project = contextMenu.project;
          setContextMenu(undefined);
          void onRemove(project);
        }}>
          <Trash2 size={14} />
          <span><strong>Remove from Tau</strong><small>Files stay on disk</small></span>
        </button>
      </div> : null}
    </>
  );
}
