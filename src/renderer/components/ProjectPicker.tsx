import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, Plus, Search, Trash2 } from "lucide-react";
import type { UiProject, UiSession } from "../../shared/contracts";
import { pickerOrder } from "../../workbench/new-thread-project";
import { namesWorkspace } from "../../shared/workspace-identity";
import { Sheet } from "../touch/Sheet";
import { Popover } from "./ui/Dialog";
import { ProjectIcon } from "./ProjectIcon";
import { VirtualList } from "./VirtualList";
import { useFocusReturn } from "./ui/focus";
import "./project-picker.css";

interface ProjectPickerProps {
  open: boolean;
  projects: readonly UiProject[];
  /** Orders the list by the last thread worked in. */
  threads?: readonly UiSession[];
  /** The project in context (workspace id or path): first, checked and selected. */
  preselect?: string | undefined;
  /** The machine the projects are on, under each name. */
  machine?: string | undefined;
  heading?: string;
  /** A bottom sheet, as on a phone or tablet. */
  sheet?: boolean;
  /** Opens as a popover at this point instead of over the window. */
  anchor?: RefObject<HTMLElement | null> | { x: number; y: number } | undefined;
  onBrowse: () => void;
  onNoProject?: () => void;
  onClose: () => void;
  onRemove: (project: UiProject) => void | Promise<void>;
  onSelect: (project: UiProject) => void;
}

function compactPath(path: string): string {
  const home = path.match(/^\/Users\/[^/]+/u)?.[0];
  return home ? path.replace(home, "~") : path;
}

/** "New thread" asks for the project first, so a thread never starts in the wrong project: search, recent first, then "Add project…". */
export function ProjectPicker({
  open,
  projects,
  threads = [],
  preselect,
  machine,
  heading = "New thread in",
  sheet,
  anchor,
  onBrowse,
  onNoProject,
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
  // Read when it opens: a thread finishing meanwhile must not move the row under the pointer.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const ordered = useMemo(() => pickerOrder(projects, threads, preselect), [projects, preselect, open]);
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return ordered;
    return ordered.filter((project) =>
      `${project.name} ${project.displayPath ?? project.path}`.toLocaleLowerCase().includes(needle),
    );
  }, [ordered, query]);
  // The row after the projects is "Add project…".
  const last = matches.length + (onNoProject ? 1 : 0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    setContextMenu(undefined);
    // A touch keyboard would cover the list; there the search waits for a tap.
    if (!sheet) window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, sheet]);

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
    setSelected((index) => Math.min(index, last));
  }, [last]);

  if (!open) return null;

  const activate = (index: number) => {
    const project = matches[index];
    if (project) onSelect(project);
    else if (onNoProject && index === matches.length) onNoProject();
    else onBrowse();
  };

  const body = <>
    <label className="project-picker-search">
      <Search size={15} />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSelected((index) => Math.max(0, Math.min(last, index + (event.key === "ArrowDown" ? 1 : -1))));
          }
          if (event.key === "Enter") {
            event.preventDefault();
            activate(selected);
          }
        }}
        placeholder="Search projects…"
        aria-label="Search projects"
      />
      {sheet ? null : <kbd className="keyboard-hint">esc</kbd>}
    </label>
    {sheet ? null : <div className="project-picker-heading">{heading}</div>}
    <VirtualList
      items={matches}
      itemHeight={sheet ? 56 : 50}
      overscan={6}
      className="project-picker-results"
      role="listbox"
      scrollToIndex={selected < last ? selected : undefined}
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
          <ProjectIcon project={project} />
          <span>
            <strong>{project.name}</strong>
            <small>{machine ? `${machine} · ` : ""}{compactPath(project.displayPath ?? project.path)}</small>
          </span>
          {preselect !== undefined && namesWorkspace(preselect, project.workspaceId, project.path) ? <Check size={14} aria-label="current" /> : null}
        </button>
      )}
    />
    {onNoProject ? <button type="button" className={`project-picker-add${selected === matches.length ? " selected" : ""}`} onMouseMove={() => setSelected(matches.length)} onClick={onNoProject}>No project <small>Private scratch folder for this thread</small></button> : null}
    <button
      type="button"
      className={`project-picker-add${selected === last ? " selected" : ""}`}
      onMouseMove={() => setSelected(last)}
      onClick={onBrowse}
    ><Plus size={15} /> Add project…</button>
    {sheet ? null : <footer className="keyboard-hint"><kbd>↑↓</kbd> select <kbd>↵</kbd> start</footer>}
  </>;

  let surface: ReactNode;
  if (sheet) surface = <Sheet title={heading} className="project-picker-sheet" onClose={onClose}>{body}</Sheet>;
  else if (anchor) surface = <Popover anchor={anchor} label="Search projects" className="project-picker anchored" onClose={onClose}>{body}</Popover>;
  else surface = <>
    <button className="project-picker-scrim" aria-label="Close project picker" onClick={onClose} />
    <section ref={surfaceRef} className="project-picker" role="dialog" aria-modal="true" aria-label="Search projects">{body}</section>
  </>;

  return (
    <>
      {surface}
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
