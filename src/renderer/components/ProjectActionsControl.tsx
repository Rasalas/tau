import { useEffect, useState } from "react";
import { ChevronDown, Play, Plus, TerminalSquare, Trash2 } from "lucide-react";
import { parseShellActionDraft } from "../title-bar-actions";
import { Menu } from "./Menu";

interface ProjectAction {
  id: string;
  name: string;
  command: string;
  includeInContext: boolean;
}

function storageKey(cwd?: string): string {
  return `tau.project-actions:${cwd ?? "unknown"}`;
}

function loadActions(cwd?: string): ProjectAction[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(cwd)) ?? "[]") as unknown;
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
  cwd,
  onRun,
}: {
  cwd?: string;
  onRun(command: string, includeInContext: boolean, name: string): void;
}) {
  const [actions, setActions] = useState<ProjectAction[]>(() => loadActions(cwd));
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [commandDraft, setCommandDraft] = useState("");

  useEffect(() => {
    setActions(loadActions(cwd));
    setMenuOpen(false);
    setEditing(false);
  }, [cwd]);

  const save = (next: ProjectAction[]) => {
    setActions(next);
    try { localStorage.setItem(storageKey(cwd), JSON.stringify(next)); } catch { /* optional preference */ }
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
            <div className="menu-heading">ADD ACTION</div>
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
