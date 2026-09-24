import { useState, useSyncExternalStore } from "react";
import { errorMessage, READ_ONLY_REASON, tooltipProps, useHostCapabilities, type WorkbenchActions } from "tau";
import type { AgentsState } from "./protocol.js";
import { definitionRows, type DefinitionRow } from "./model.js";
import { agentsHost, definitionsStore } from "./store.js";

function DefinitionItem({ row, parentThreadId, actions }: {
  row: DefinitionRow;
  parentThreadId: string | undefined;
  actions: WorkbenchActions;
}) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const { readOnly } = useHostCapabilities();
  const { definition } = row;

  const submit = (event: { preventDefault(): void }) => {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || !parentThreadId || busy) return;
    setBusy(true);
    void (agentsHost.invoke?.("start", { parentThreadId, agent: definition.name, prompt: text }) ?? Promise.reject(new Error("Agents Kit is not connected.")))
      .then(() => {
        setPrompt("");
        setOpen(false);
        actions.notify(`Started ${definition.name}.`);
      })
      .catch((error: unknown) => actions.notify(errorMessage(error)))
      .finally(() => setBusy(false));
  };

  return (
    <li className="agent-definition">
      <div className="agent-definition-head">
        <strong>{definition.name}</strong>
        {row.open > 0 ? <small className="agent-definition-open">{row.open} open</small> : null}
        <button
          type="button"
          className="text-button"
          disabled={!parentThreadId || readOnly}
          {...tooltipProps(readOnly ? READ_ONLY_REASON : parentThreadId ? `Start ${definition.name} from this thread` : "Open a thread to start an agent from it")}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >Start</button>
      </div>
      <span className="agent-definition-description">{definition.description}</span>
      {row.settings ? <span className="agent-definition-settings">{row.settings}</span> : null}
      {open ? (
        <form className="agent-definition-form" onSubmit={submit}>
          <textarea
            aria-label={`Task for ${definition.name}`}
            placeholder={`What should ${definition.name} do?`}
            rows={3}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
              if (event.key === "Escape") setOpen(false);
            }}
          />
          <span className="agent-definition-actions">
            <button type="button" className="text-button" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="chrome-button" disabled={busy || !prompt.trim()}>{busy ? "Starting…" : `Start ${definition.name}`}</button>
          </span>
        </form>
      ) : null}
    </li>
  );
}

/**
 * The project's agent definitions above the running agents: each one is a
 * starting point, and says how many of this thread's agents it already runs.
 */
export function DefinitionsSection({ state, activeThreadId, actions }: {
  state: AgentsState | undefined;
  activeThreadId: string | undefined;
  actions: WorkbenchActions;
}) {
  const view = useSyncExternalStore(definitionsStore.subscribe, definitionsStore.getSnapshot);
  const definitions = view.state?.definitions ?? [];
  const errors = (view.state?.problems ?? []).filter((problem) => problem.level === "error").length;
  if (definitions.length === 0 && errors === 0) return null;
  const rows = definitionRows(definitions, state, activeThreadId);
  return (
    <section className="agent-definitions" aria-label="Agent definitions">
      <div className="agent-group-label">Definitions</div>
      <ul>
        {rows.map((row) => (
          <DefinitionItem key={row.definition.name} row={row} parentThreadId={activeThreadId} actions={actions} />
        ))}
      </ul>
      {errors > 0 ? (
        <small className="agent-definitions-problems">
          {errors === 1 ? "1 file" : `${errors} files`} in .tau/agents could not be used; Settings → Inspector says why.
        </small>
      ) : null}
    </section>
  );
}
