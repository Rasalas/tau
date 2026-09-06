import { useSyncExternalStore } from "react";
import { Bot } from "lucide-react";
import { useThreadStore, type ToolCardProps } from "tau";
import { formatCost, spawnCardModel } from "./model.js";
import { agentsStore } from "./store.js";

/**
 * One card per `tau_spawn_thread` batch. The transcript never folds, groups or
 * hides it: a spawn outlives the turn that made it, so the way into the agents
 * it started has to stay where the user read about them.
 */
export function SpawnCard({ tools, actions }: ToolCardProps) {
  const store = useThreadStore();
  const state = useSyncExternalStore(agentsStore.subscribe, agentsStore.getSnapshot);
  const navigation = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const model = spawnCardModel(tools, state, navigation.threads);
  if (model.rows.length === 0) return null;
  const cost = model.totalCostUsd === undefined ? undefined : formatCost(model.totalCostUsd);
  return (
    <section className={`agent-spawn-card status-${model.status}`}>
      <header>
        <i className={`agent-dot status-${model.status}`} aria-hidden="true" />
        <Bot size={13} aria-hidden="true" />
        <strong>{model.headline}</strong>
        {cost ? <small>{cost}</small> : null}
        <button type="button" className="text-button" onClick={() => actions.openPanel("agents")}>
          <span>Open Agents</span>
        </button>
      </header>
      <ul>
        {model.rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className={`agent-spawn-link status-${row.status}`}
              disabled={!row.threadId}
              aria-label={`Open ${row.title}, ${row.status}`}
              title={`Open ${row.title} in the stage`}
              onClick={() => { if (row.threadId) actions.openThread(row.threadId); }}
            >
              <i className={`agent-dot status-${row.status}`} aria-hidden="true" />
              <span>{row.title}</span>
              <small>{row.status}</small>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
