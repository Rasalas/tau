import { useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { Check, ChevronDown, FolderOpen, Layers, ListChecks, MessageSquare, MoreHorizontal, Plus, Search, Settings, SlidersHorizontal } from "lucide-react";
import { errorMessage, MiddleTruncate, ProjectIcon, READ_ONLY_REASON, VirtualList, tooltipProps, useContextMenu, useEscapeLayer, useHostCapabilities, useThreadStore, useWorkbenchShell, type UiProject, type WorkbenchActions } from "tau";
import { matchingGroup, NO_PROJECT, projectFilterLabel, projectById, projectId, projectName, rankProjects, selectedProjects, type RailProjectFilter, type SavedProjectGroup } from "./project-filter.js";
import { homeRelative } from "./folder-finder.js";
import { useWorkspaceStore } from "./store-context.js";

type Entry = { kind: "all" | "heading" | "group" | "project"; id: string; label: string; group?: SavedProjectGroup; project?: UiProject };

export function ProjectFilterMenu({ filter, groups, projects, counts, hasNoProject = true, onChange, onClose, onSave, onRemove, onSettings, footer, onPick }: {
  filter: RailProjectFilter;
  groups: readonly SavedProjectGroup[];
  projects: readonly UiProject[];
  counts?: ReadonlyMap<string, number>;
  hasNoProject?: boolean;
  onChange?(filter: RailProjectFilter): void;
  onClose(): void;
  onSave?(name: string, projects: readonly string[], id?: string): boolean;
  onRemove?(id: string): void;
  onSettings?(project: UiProject): void;
  footer?: ReactNode;
  onPick?(project: UiProject): void;
}) {
  const selected = selectedProjects(filter, projects);
  const names = (ids: readonly string[]) => ids.map((id) => projectName(id, projects)).join(", ");
  const [query, setQuery] = useState("");
  const [multiple, setMultiple] = useState(false);
  const [naming, setNaming] = useState<{ id?: string; projects: readonly string[] }>();
  const [name, setName] = useState("");
  const [highlighted, setHighlighted] = useState(() => onPick ? Math.max(0, projects.findIndex((project) => selected?.includes(projectId(project)))) : 0);
  const input = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const lastContextClick = useRef(0);
  const openContextMenu = useContextMenu();
  const prefix = useId();
  const group = matchingGroup(filter, groups, projects);
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const entries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = (text: string) => !needle || text.toLocaleLowerCase().includes(needle);
    const saved = groups.filter((entry) => matches(`${entry.name} ${names(entry.projects)}`));
    const projectEntries: Entry[] = rankProjects(projects, needle).map((project) => ({ kind: "project", id: projectId(project), label: project.name, project }));
    if (hasNoProject && matches("No project")) projectEntries.push({ kind: "project", id: NO_PROJECT, label: "No project" });
    return [
      ...(!onPick && matches("All projects") ? [{ kind: "all", id: "all", label: "All projects" } as Entry] : []),
      ...(saved.length ? [{ kind: "heading", id: "saved", label: "Saved" } as Entry, ...saved.map((entry): Entry => ({ kind: "group", id: entry.id, label: entry.name, group: entry }))] : []),
      ...(!onPick && projectEntries.length ? [{ kind: "heading", id: "projects", label: "Projects" } as Entry] : []), ...projectEntries,
    ];
  }, [query, groups, projects, hasNoProject, onPick]);
  const activeIndex = entries[highlighted] && entries[highlighted]?.kind !== "heading" ? highlighted : Math.max(0, entries.findIndex((entry) => entry.kind !== "heading"));
  useLayoutEffect(() => { input.current?.focus(); }, []);
  useLayoutEffect(() => { if (naming) { nameInput.current?.focus(); nameInput.current?.select(); } }, [naming]);
  useEscapeLayer(() => { if (naming) { setNaming(undefined); input.current?.focus(); } else onClose(); });

  const change = (ids: readonly string[] | undefined) => { setNaming(undefined); onChange?.(ids); };
  const pick = (entry: Entry | undefined, additive = false) => {
    if (!entry || entry.kind === "heading") return;
    if (onPick && entry.project) { onPick(entry.project); return; }
    if (entry.kind === "group") { onChange?.(entry.group!.projects); onClose(); return; }
    if (entry.kind === "all") { change(undefined); onClose(); return; }
    if (multiple || additive) {
      const before = selected ?? (multiple ? [...projects.map(projectId), ...(hasNoProject ? [NO_PROJECT] : [])] : []);
      change(before.includes(entry.id) ? before.filter((id) => id !== entry.id) : [...before, entry.id]);
      setMultiple(true);
    } else { change([entry.id]); onClose(); }
  };
  const beginSave = (existing?: SavedProjectGroup) => {
    const ids = existing?.projects ?? selected;
    if (!ids?.length) return;
    setName(existing?.name ?? "");
    setNaming({ id: existing?.id, projects: ids });
  };
  const duplicate = groups.some((entry) => entry.id !== naming?.id && entry.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  const save = () => {
    if (!naming || !name.trim() || duplicate) return;
    if (onSave?.(name, naming.projects, naming.id)) onClose();
  };
  const groupMenu = async (event: MouseEvent, saved: SavedProjectGroup) => {
    event.preventDefault(); event.stopPropagation();
    const choice = await openContextMenu(event, [{ items: [{ id: "rename", label: "Rename group" }, { id: "remove", label: "Delete group", destructive: true }] }]);
    if (choice === "rename") beginSave(saved);
    if (choice === "remove") onRemove?.(saved.id);
  };
  return <>
    <button type="button" className="project-switcher-scrim" aria-label="Close project filter" onClick={onClose} />
    <section className="project-switcher-popover rail-project-menu" role="dialog" aria-label={onPick ? "Switch project" : "Filter by project"} onKeyDown={(event) => {
      if (event.target === nameInput.current) { if (event.key === "Enter") { event.preventDefault(); save(); } return; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        let next = activeIndex + (event.key === "ArrowDown" ? 1 : -1);
        while (entries[next]?.kind === "heading") next += event.key === "ArrowDown" ? 1 : -1;
        if (next >= 0 && next < entries.length) { setHighlighted(next); input.current?.focus(); }
      }
      if (event.key === "Enter" && event.target === input.current) { event.preventDefault(); pick(entries[activeIndex], event.ctrlKey || event.metaKey); }
    }}>
      <label className="rail-project-search"><Search size={14} /><input ref={input} value={query} aria-label="Search projects" placeholder="Find a project or group" onChange={(event) => { setQuery(event.target.value); setHighlighted(0); }} aria-activedescendant={`${prefix}-${activeIndex}`} /></label>
      <VirtualList items={entries} itemHeight={onPick ? 45 : 31} overscan={6} className={`rail-project-results${onPick ? " project-switcher-results" : ""}`} role="listbox" scrollToIndex={activeIndex} empty={<p>No matching projects or groups</p>} renderItem={(entry, index) => {
        if (entry.kind === "heading") return <div className="rail-project-heading">{entry.label}</div>;
        const picked = entry.kind === "all" ? selected === undefined : entry.kind === "group" ? group?.id === entry.id
          : multiple ? selected === undefined || selected.includes(entry.id) : selected?.length === 1 && selected[0] === entry.id;
        const fullPath = entry.project?.displayPath ?? entry.project?.path;
        const shortPath = fullPath ? homeRelative(fullPath) : "";
        const summary = (entry.group ? names(entry.group.projects) : undefined)
          ?? (entry.project && projects.some((candidate) => candidate !== entry.project && candidate.name === entry.label) ? fullPath : undefined);
        const count = counts?.get(entry.id);
        return <div className={`rail-project-entry${activeIndex === index ? " highlighted" : ""}`} onMouseMove={() => setHighlighted(index)}>
          <button type="button" id={`${prefix}-${index}`} className="rail-project-pick" role={multiple && entry.kind === "project" ? "checkbox" : "option"}
            aria-label={entry.label} {...(multiple && entry.kind === "project" ? { "aria-checked": picked } : { "aria-selected": picked })}
            onClick={(event) => { if (event.ctrlKey && Date.now() - lastContextClick.current < 400) return; pick(entry, event.ctrlKey || event.metaKey); }}
            onContextMenu={(event) => {
              if (entry.group) { void groupMenu(event, entry.group); return; }
              if (entry.kind === "project" && event.ctrlKey) { event.preventDefault(); lastContextClick.current = Date.now(); pick(entry, true); }
              else if (entry.project && onSettings) { event.preventDefault(); onSettings(entry.project); }
            }}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); pick(entry, true); } }}>
            {multiple ? entry.kind !== "project" ? <i className="rail-project-check-space" /> : <i aria-hidden="true" className={`rail-project-check${picked ? " checked" : ""}`}>{picked ? <Check size={10} /> : null}</i> : null}
            {entry.kind === "all" || entry.kind === "group" ? <Layers size={14} /> : entry.project ? <ProjectIcon project={entry.project} className="rail-project-tile" /> : <MessageSquare size={14} />}
            <span className={`rail-project-name${picked ? " picked" : ""}`}><strong>{entry.label}</strong>{onPick ? <small><MiddleTruncate value={shortPath} tail={Math.min(shortPath.length - shortPath.lastIndexOf("/"), 16)} {...tooltipProps(fullPath, { side: "right" })} /></small> : null}</span>
            {summary ? <small className="rail-project-summary" title={summary}>{summary}</small> : null}
            {!multiple && picked ? onPick ? <small className="current">current</small> : <Check size={13} className="rail-project-current" /> : count !== undefined ? <small className="rail-project-count">{count}</small> : null}
          </button>
          {entry.group || entry.project && onSettings ? <button type="button" className="rail-project-settings" aria-label={`${entry.group ? "Group actions:" : "Settings for"} ${entry.label}`} onClick={(event) => { if (entry.group) void groupMenu(event, entry.group); else onSettings?.(entry.project!); }}>{entry.group ? <MoreHorizontal size={13} /> : <Settings size={13} />}</button> : null}
        </div>;
      }} />
      {onPick ? null : <footer className="rail-project-footer">
        {naming ? <>
          <label className="rail-project-name-field"><Layers size={14} /><input ref={nameInput} value={name} maxLength={60} placeholder="Group name" aria-label="Group name" onChange={(event) => setName(event.target.value)} /></label>
          <div className="rail-project-selection"><small role="status">{duplicate ? "This name is already used" : names(naming.projects)}</small><button type="button" onClick={() => { setNaming(undefined); input.current?.focus(); }}>Cancel</button><button type="button" className="primary" disabled={!name.trim() || duplicate} onClick={save}>Save</button></div>
        </> : multiple ? <div className="rail-project-selection"><small>{selected === undefined ? "All projects" : `${selected.length} selected`}</small>{!group ? <button type="button" disabled={!selected?.length} onClick={() => beginSave()}>Save…</button> : null}<button type="button" className="primary" onClick={onClose}>Done</button></div> : <>
          <button type="button" className="rail-project-multiple" onClick={() => setMultiple(true)}><ListChecks size={14} /><span>Select multiple…</span><small>Ctrl/⌘-click</small></button>
          {footer}
        </>}
      </footer>}
    </section>
  </>;
}

/** The filter and its New thread button share one selection, without changing the open conversation. */
export function RailProjectControls({ actions, counts, children }: { actions: WorkbenchActions; counts: () => ReadonlyMap<string, number>; children?: ReactNode }) {
  const workspace = useWorkspaceStore();
  const threadStore = useThreadStore();
  const { registry } = useWorkbenchShell();
  const projects = useSyncExternalStore(threadStore.subscribeToProjects, threadStore.getProjects);
  const filter = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().railProjectFilter);
  const groups = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().railProjectGroups);
  const [open, setOpen] = useState(false);
  const openMenu = useContextMenu();
  const { readOnly } = useHostCapabilities();
  const filterButton = useRef<HTMLButtonElement>(null);
  const createScratch = registry.getProjectSources().find((entry) => entry.createThreadWorkspace)?.createThreadWorkspace;
  const ids = selectedProjects(filter, projects);
  const group = matchingGroup(filter, groups, projects);
  const label = projectFilterLabel(filter, groups, projects);
  const single = ids?.length === 1 ? projectById(ids[0]!, projects) : undefined;
  const close = () => { setOpen(false); filterButton.current?.focus(); };
  const start = (id: string) => {
    if (id === NO_PROJECT) {
      void createScratch?.().then((project) => actions.newSession({ project })).catch((error: unknown) => actions.notify(errorMessage(error), "error"));
    } else {
      const project = projectById(id, projects);
      if (project) actions.newSession({ workspace: id });
    }
  };
  return <>
    <button ref={filterButton} type="button" className={`sidebar-action project-filter${filter !== undefined ? " filtered" : ""}`} aria-label={filter === undefined ? "Filter threads by project" : `Filter threads by project: ${label}`} aria-haspopup="dialog" aria-expanded={open}
      {...tooltipProps(open ? undefined : "Filter by project or saved group", { side: "bottom" })}
      onClick={() => { if (open) close(); else { setOpen(true); } }}>
      {single ? <ProjectIcon project={single} className="project-filter-tile" /> : <Layers size={14} />}
      <span>{label}</span>{group ? <small>{group.projects.length}</small> : null}<ChevronDown size={10} />
    </button>
    <div className="rail-head-actions">{children}<button type="button" className="sidebar-action new-thread" aria-label="New thread" disabled={readOnly}
      {...tooltipProps(readOnly ? READ_ONLY_REASON : "New thread", { side: "bottom", ...(readOnly ? {} : { shortcut: registry.keybindingLabel("runtime.new-session") }) })}
      onClick={(event) => {
        if (ids === undefined) actions.newSession();
        else if (ids.length === 1 && (ids[0] === NO_PROJECT || single)) start(ids[0]!);
        else void openMenu(event, [{ items: ids.length ? ids.map((id) => {
          const project = projectById(id, projects);
          return { id, label: projectName(id, projects), icon: project ? <ProjectIcon project={project} /> : <MessageSquare size={14} />, disabled: id !== NO_PROJECT && !project };
        }) : [{ id: "empty", label: "Choose projects from the filter first", disabled: true }] }]).then((id) => { if (id) start(id); });
      }}><Plus size={15} /></button></div>
    {open ? <ProjectFilterMenu filter={filter} groups={groups} projects={projects} counts={counts()} hasNoProject={Boolean(createScratch)} onChange={(next) => workspace.setRailProjectFilter(next)} onClose={close}
      onSave={(name, selected, id) => workspace.saveRailProjectGroup(name, selected, id)} onRemove={(id) => workspace.removeRailProjectGroup(id)}
      onSettings={(project) => { close(); workspace.openProjectSettings({ projectPath: project.path, projectName: project.name, workspaceId: project.workspaceId }); }}
      footer={<div className="rail-project-management">{readOnly ? null : <button type="button" onClick={() => { close(); actions.openProjectSources(); }}><FolderOpen size={13} />Open a project…</button>}<button type="button" aria-label="Manage projects" onClick={() => { close(); actions.openSettings("workspace.source-control"); }}><SlidersHorizontal size={13} /></button></div>} /> : null}

  </>;
}
