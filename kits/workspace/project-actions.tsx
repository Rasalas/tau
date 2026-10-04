import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, Play, Plus, TerminalSquare, Trash2 } from "lucide-react";
import { Menu, Popover, tooltipProps, useClientStorage, useKeepClear, type ClientStorage, type MenuItem } from "tau";
import { parseShellActionDraft } from "./actions.js";

/** `tau.project-actions:<workspace>`, scoped per project by its workspace id. */
function projectActionsKey(workspace?: string): string {
  return `tau.project-actions:${workspace ?? "unknown"}`;
}

export interface ProjectAction {
  id: string;
  name: string;
  command: string;
  includeInContext: boolean;
}

function loadActions(storage: ClientStorage, workspace?: string): ProjectAction[] {
  try {
    const value = JSON.parse(storage.get(projectActionsKey(workspace)) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is ProjectAction => Boolean(
      item && typeof item === "object" &&
      typeof (item as ProjectAction).id === "string" &&
      typeof (item as ProjectAction).name === "string" &&
      typeof (item as ProjectAction).command === "string" &&
      typeof (item as ProjectAction).includeInContext === "boolean",
    ));
  } catch {
    return [];
  }
}

export interface ProjectActionsState {
  actions: ProjectAction[];
  run(action: ProjectAction): void;
  save(next: ProjectAction[]): void;
  editing: boolean;
  openEditor(): void;
  closeEditor(): void;
}

/** A project's saved actions and the editor that adds one; the title bar draws them inline or in its overflow menu. */
export function useProjectActions(workspace: string | undefined, onRun: (command: string, includeInContext: boolean, name: string) => void): ProjectActionsState {
  const clientStorage = useClientStorage();
  const [actions, setActions] = useState<ProjectAction[]>(() => loadActions(clientStorage, workspace));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setActions(loadActions(clientStorage, workspace));
    setEditing(false);
  }, [clientStorage, workspace]);

  return {
    actions,
    run: (action) => onRun(action.command, action.includeInContext, action.name),
    save: (next) => {
      setActions(next);
      try { clientStorage.set(projectActionsKey(workspace), JSON.stringify(next)); } catch { /* optional preference */ }
    },
    editing,
    openEditor: () => setEditing(true),
    closeEditor: () => setEditing(false),
  };
}

/** The menu entries of the project's actions: run each, add one, remove all. */
export function projectActionItems(actions: readonly ProjectAction[]): MenuItem[] {
  return [
    ...actions.map((action) => ({
      id: `run:${action.id}`,
      label: action.name,
      description: `${action.includeInContext ? "!" : "!!"} ${action.command}`,
    })),
    { id: "add", label: "Add action" },
    { id: "clear", label: "Remove all actions", disabled: actions.length === 0 },
  ];
}

/** Runs what `projectActionItems` offered; false when the id is not one of them. */
export function pickProjectAction(state: ProjectActionsState, id: string): boolean {
  if (id === "add") state.openEditor();
  else if (id === "clear") state.save([]);
  else if (id.startsWith("run:")) {
    const action = state.actions.find((item) => item.id === id.slice(4));
    if (action) state.run(action);
  } else return false;
  return true;
}

/** The form that adds an action, hung below whichever anchor opened it. */
export function ProjectActionEditor({ state, anchor }: { state: ProjectActionsState; anchor?: RefObject<HTMLDivElement | null> }) {
  const [name, setName] = useState("");
  const [commandDraft, setCommandDraft] = useState("");
  // Reuses .menu without the Menu component, so it needs the same clearance.
  const editor = useRef<HTMLFormElement>(null);
  useKeepClear(editor, !anchor);
  const { actions, save, closeEditor } = state;
  const form = <form
        ref={editor}
        className="menu below right project-action-editor"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = parseShellActionDraft(commandDraft);
          if (!name.trim() || !parsed.command) return;
          save([...actions, {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            name: name.trim(),
            command: parsed.command,
            includeInContext: parsed.includeInContext,
          }]);
          closeEditor();
        }}
      >
        <div className="menu-heading">Add action</div>
        <label><span>Name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Test" /></label>
        <label>
          <span>Pi shell command</span>
          <div className="action-command-field"><TerminalSquare size={13} /><input value={commandDraft} onChange={(event) => setCommandDraft(event.target.value)} placeholder="!! npm test" /></div>
        </label>
        <p><code>!!</code> keeps output out of model context. Use <code>!</code> when the agent should see it.</p>
        <div className="project-action-form-buttons">
          {actions.length > 0 ? <button type="button" className="danger" onClick={() => save([])} title="Remove all actions"><Trash2 size={13} /></button> : null}
          <span />
          <button type="button" onClick={closeEditor}>Cancel</button>
          <button type="submit" className="primary" disabled={!name.trim() || !parseShellActionDraft(commandDraft).command}>Add</button>
        </div>
      </form>;
  return anchor ? <Popover anchor={anchor} align="end" label="Add project script" className="project-action-editor-shell" onClose={closeEditor}>{form}</Popover> : <><button className="menu-scrim" aria-label="Close action editor" onClick={closeEditor} />{form}</>;
}

/** The project's actions as a split button (run the first, the rest in its menu), or "Add action"; `iconOnly` drops the label. */
export function ProjectActionsControl({ state, iconOnly = false, card = false }: { state: ProjectActionsState; iconOnly?: boolean; card?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const primary = state.actions[0];
  const anchor = useRef<HTMLDivElement>(null);
  const tip = (label: string) => tooltipProps(label, { side: "bottom" });

  return (
    <div ref={anchor} className={`menu-anchor project-actions-control${card ? " workspace-card-script-control" : ""}`}>
      {primary ? (
        <div className="chrome-group" aria-label="Project actions">
          <button className="chrome-button split-main" aria-label={primary.name} {...tip(`Run ${primary.name}`)} onClick={() => state.run(primary)}>
            <Play size={13} />{iconOnly ? null : <span>{primary.name}</span>}
          </button>
          <button className="chrome-button split-trigger" aria-label="Project actions" onClick={() => setMenuOpen(true)}>
            <ChevronDown size={13} />
          </button>
        </div>
      ) : (
        <button className="chrome-button" aria-label={card ? "Add project script" : "Add action"} {...(iconOnly ? tip("Add action") : {})} onClick={state.openEditor}>
          <Plus size={14} />{iconOnly ? null : <span>{card ? "Add project script" : "Add action"}</span>}
        </button>
      )}

      {menuOpen ? (
        <Menu
          align="right"
          heading="Actions"
          items={projectActionItems(state.actions)}
          onSelect={(id) => pickProjectAction(state, id)}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}

      {state.editing ? <ProjectActionEditor state={state} anchor={card ? anchor : undefined} /> : null}
    </div>
  );
}
