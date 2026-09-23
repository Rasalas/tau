import { useEffect, useRef, useState } from "react";
import { ChevronDown, Play, Plus, TerminalSquare, Trash2 } from "lucide-react";
import { Menu, useClientStorage, useKeepClear, type ClientStorage } from "tau";
import { parseShellActionDraft } from "./actions.js";

/** `tau.project-actions:<workspace>`, scoped per project by its workspace id. */
function projectActionsKey(workspace?: string): string {
  return `tau.project-actions:${workspace ?? "unknown"}`;
}

interface ProjectAction {
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

export function ProjectActionsControl({
  cwd: workspace,
  onRun,
}: {
  /** The project these actions belong to, named by its workspace id. */
  cwd?: string;
  onRun(command: string, includeInContext: boolean, name: string): void;
}) {
  const clientStorage = useClientStorage();
  const [actions, setActions] = useState<ProjectAction[]>(() => loadActions(clientStorage, workspace));
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [commandDraft, setCommandDraft] = useState("");
  // Reuses .menu without the Menu component, so it needs the same clearance.
  const editor = useRef<HTMLFormElement>(null);
  useKeepClear(editor, editing);

  useEffect(() => {
    setActions(loadActions(clientStorage, workspace));
    setMenuOpen(false);
    setEditing(false);
  }, [clientStorage, workspace]);

  const save = (next: ProjectAction[]) => {
    setActions(next);
    try { clientStorage.set(projectActionsKey(workspace), JSON.stringify(next)); } catch { /* optional preference */ }
  };
  const openEditor = () => {
    setName("");
    setCommandDraft("");
    setMenuOpen(false);
    setEditing(true);
  };
  const run = (action: ProjectAction) => onRun(action.command, action.includeInContext, action.name);
  const primary = actions[0];

  return (
    <div className="menu-anchor project-actions-control">
      {primary ? (
        <div className="chrome-group" aria-label="Project actions">
          <button className="chrome-button split-main" onClick={() => run(primary)} title={`Run ${primary.name}`}>
            <Play size={13} /> {primary.name}
          </button>
          <button className="chrome-button split-trigger" aria-label="Project actions" onClick={() => setMenuOpen(true)}>
            <ChevronDown size={13} />
          </button>
        </div>
      ) : (
        <button className="chrome-button" onClick={openEditor}>
          <Plus size={14} /> Add action
        </button>
      )}

      {menuOpen ? (
        <Menu
          align="right"
          heading="Actions"
          items={[
            ...actions.map((action) => ({
              id: `run:${action.id}`,
              label: action.name,
              description: `${action.includeInContext ? "!" : "!!"} ${action.command}`,
            })),
            { id: "add", label: "Add action" },
            { id: "clear", label: "Remove all actions", disabled: actions.length === 0 },
          ]}
          onSelect={(id) => {
            if (id === "add") openEditor();
            else if (id === "clear") save([]);
            else {
              const action = actions.find((item) => item.id === id.slice(4));
              if (action) run(action);
            }
          }}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}

      {editing ? (
        <>
          <button className="menu-scrim" aria-label="Close action editor" onClick={() => setEditing(false)} />
          <form
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
              setEditing(false);
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
              <button type="button" onClick={() => setEditing(false)}>Cancel</button>
              <button type="submit" className="primary" disabled={!name.trim() || !parseShellActionDraft(commandDraft).command}>Add</button>
            </div>
          </form>
        </>
      ) : null}
    </div>
  );
}
