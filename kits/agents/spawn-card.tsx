import { useState, useSyncExternalStore } from "react";
import { Bot, CircleHelp } from "lucide-react";
import { useThreadStore, type ToolCardProps } from "tau";
import { formatCost, spawnCardModel } from "./model.js";
import { AgentLineageRow } from "./lineage.js";
import { agentsStore } from "./store.js";

/**
 * One line per `tau_spawn_thread` batch: "Started 6 agents · 5 running ·
 * 1 question", which expands the linked chats. The transcript never folds it: a
 * spawn outlives the turn that made it.
 */
export function SpawnCard({ tools, actions }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const store = useThreadStore();
  const state = useSyncExternalStore(agentsStore.subscribe, agentsStore.getSnapshot);
  const navigation = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const model = spawnCardModel(tools, state, navigation.threads);
  if (model.rows.length === 0) return null;
  const cost = model.totalCostUsd === undefined ? undefined : formatCost(model.totalCostUsd);
  return (
    <div><button
      type="button"
      className={`agent-spawn-card status-${model.status}`}
      aria-label={`${model.summary}. Show agents`}
      aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}
    >
      <Bot size={14} aria-hidden="true" />
      <strong>{model.headline}</strong>
      {model.parts.map((part) => (
        <span key={part.kind} className={`agent-spawn-part part-${part.kind}`}>
          {part.kind === "running" ? <span className="spinner info spinner-sm" aria-hidden="true" /> : null}
          {part.kind === "question" ? <CircleHelp size={12} aria-hidden="true" /> : null}
          {part.text}
        </span>
      ))}
      {cost ? <small className="agent-spawn-cost">{cost}</small> : null}
    </button>
    {expanded ? <div className="agent-spawn-list">{model.rows.map((row) => <AgentLineageRow key={row.id} row={row} actions={actions} />)}</div> : null}</div>
  );
}
