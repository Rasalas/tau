import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, ChevronRight, MessageSquare, Plus, Search, Trash2 } from "lucide-react";
import type { UiProject, UiSession } from "../../shared/contracts";
import { pickerOrder } from "../../workbench/new-thread-project";
import { namesWorkspace } from "../../shared/workspace-identity";
import type { ToastHandle, ToastOptions } from "../../workbench/toast-store";
import { Sheet } from "../deferred-surfaces";
import { Popover } from "./ui/Dialog";
import { useContextMenu } from "./ui/ContextMenu";
import { tooltipProps } from "./ui/Tooltip";
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
  /** With a toast, a removal waits for it and its Undo; without one it goes at once. */
  toast?: ((options: ToastOptions) => ToastHandle) | undefined;
}

const keyOf = (project: UiProject) => project.workspaceId ?? project.path;

/** A text field with text in it, where Shift+Delete cuts (Linux, Windows). */
function cutsText(target: EventTarget | null): boolean {
  return (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.value !== "";
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
  toast,
}: ProjectPickerProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  /** Removed, while their toast still offers Undo. */
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set());
  const openMenu = useContextMenu();
  const inputRef = useRef<HTMLInputElement>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  useFocusReturn(open, surfaceRef);
  // Read when it opens: a thread finishing meanwhile must not move the row under the pointer.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const ordered = useMemo(() => pickerOrder(projects, threads, preselect), [projects, preselect, open]);
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const kept = removing.size ? ordered.filter((project) => !removing.has(keyOf(project))) : ordered;
    if (!needle) return kept;
    return kept.filter((project) =>
      `${project.name} ${project.displayPath ?? project.path}`.toLocaleLowerCase().includes(needle),
    );
  }, [ordered, query, removing]);
  // The row after the projects is "Add project…".
  const last = matches.length + (onNoProject ? 1 : 0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    // A touch keyboard would cover the list; there the search waits for a tap.
    if (!sheet) window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, sheet]);

  /** Hides the project at once; it leaves Tau when its toast goes without Undo. */
  const remove = (project: UiProject) => {
    if (!toast) { void onRemove(project); return; }
    const key = keyOf(project);
    const show = (hidden: boolean) => setRemoving((current) => {
      const next = new Set(current);
      if (hidden) next.add(key); else next.delete(key);
      return next;
    });
    let undone = false;
    show(true);
    toast({
      id: `project-picker.remove:${key}`,
      type: "success",
      title: `Removed ${project.name} from Tau`,
      description: "Its files stay on disk.",
      actions: [{ label: "Undo", run: () => { undone = true; } }],
      onClose: () => {
        if (undone) show(false);
        else void Promise.resolve(onRemove(project)).finally(() => show(false));
      },
    });
  };
  const removeRef = useRef(remove);
  removeRef.current = remove;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Delete" && event.shiftKey && !cutsText(event.target)) {
        const project = matches[selected];
        if (!project) return;
        event.preventDefault();
        removeRef.current(project);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [matches, onClose, open, selected]);

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
    {!sheet || searchOpen ? <label className="project-picker-search">
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
    </label> : null}
    {sheet ? null : <div className="project-picker-heading">{heading}</div>}
    {sheet && onNoProject ? <button type="button" className="mobile-no-project" onClick={onNoProject}><MessageSquare size={22} /><span>No project<small>Start a task without a project</small></span><ChevronRight size={18} /></button> : null}
    <VirtualList
      items={matches}
      itemHeight={sheet ? 96 : 50}
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
            setSelected(index);
            void openMenu(event, [{ items: [{ id: "remove", label: "Remove from Tau", description: "Files stay on disk", icon: <Trash2 size={14} />, destructive: true }] }])
              .then((choice) => { if (choice === "remove") remove(project); });
          }}
        >
          <ProjectIcon project={project} />
          <span>
            <strong>{project.name}</strong>
            <small {...tooltipProps(project.displayPath ?? project.path, { when: "truncated", variant: "code" })}>{machine ? `${machine} · ` : ""}{compactPath(project.displayPath ?? project.path)}</small>
          </span>
          {sheet ? <ChevronRight size={18} /> : preselect !== undefined && namesWorkspace(preselect, project.workspaceId, project.path) ? <Check size={14} aria-label="current" /> : null}
        </button>
      )}
    />
    {!sheet && onNoProject ? <button type="button" className={`project-picker-add${selected === matches.length ? " selected" : ""}`} onMouseMove={() => setSelected(matches.length)} onClick={onNoProject}>No project <small>Private scratch folder for this thread</small></button> : null}
    {sheet ? null : <button
      type="button"
      className={`project-picker-add${selected === last ? " selected" : ""}`}
      onMouseMove={() => setSelected(last)}
      onClick={onBrowse}
    ><Plus size={15} /> Add project…</button>}
    {sheet ? null : <footer className="keyboard-hint"><kbd>↑↓</kbd> select <kbd>↵</kbd> start</footer>}
  </>;

  let surface: ReactNode;
  if (sheet) surface = <Sheet presentation="page" title="Choose project" className="project-picker-sheet" headerActions={<><button type="button" aria-label="Search projects" aria-expanded={searchOpen} onClick={() => { setSearchOpen((value) => !value); setQuery(""); }}><Search size={22} /></button><button type="button" aria-label="Add project" onClick={onBrowse}><Plus size={24} /></button></>} onClose={onClose}>{body}</Sheet>;
  else if (anchor) surface = <Popover anchor={anchor} label="Search projects" className="project-picker anchored" onClose={onClose}>{body}</Popover>;
  else surface = <>
    <button className="project-picker-scrim" aria-label="Close project picker" onClick={onClose} />
    <section ref={surfaceRef} className="project-picker" role="dialog" aria-modal="true" aria-label="Search projects">{body}</section>
  </>;

  return <>{surface}</>;
}
