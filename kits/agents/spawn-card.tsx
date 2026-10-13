import { useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useThreadStore, type ToolCardProps } from "tau";
import { formatCost, spawnCardModel } from "./model.js";
import { AgentLineageRow } from "./lineage.js";
import { agentsStore } from "./store.js";
import { AgentProviderMark, AgentTranscriptElapsed } from "./transcript-marks.js";

/**
 * A batch expands its children; a single child opens its transcript directly.
 */
export function SpawnCard({ tools, actions }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const store = useThreadStore();
  const state = useSyncExternalStore(agentsStore.subscribe, agentsStore.getSnapshot);
  const navigation = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const model = spawnCardModel(tools, state, navigation.threads);
  if (model.rows.length === 0) return null;
  if (model.rows.length === 1) return <AgentLineageRow row={model.rows[0]!} actions={actions} transcript />;
  const cost = model.totalCostUsd === undefined ? undefined : formatCost(model.totalCostUsd);
  const headline = `${model.rows.length} subagents`;
  const parts = model.parts.map((part) => ({ ...part, text: part.kind === "running" ? part.text.replace("running", "working") : part.text }));
  return (
    <div><button
      type="button"
      className={`agent-spawn-card status-${model.status}`}
      aria-label={`${[headline, ...parts.map((part) => part.text)].join(" · ")}. Show agents`}
      aria-expanded={expanded}
      title={cost ? `Total cost: ${cost}` : undefined}
      onClick={() => setExpanded((value) => !value)}
    >
      <span className="agent-spawn-avatars" aria-hidden="true">{model.rows.slice(0, 3).map((row) => <AgentProviderMark key={row.id} row={row} />)}</span>
      <span className="agent-transcript-main"><strong>{headline}</strong>
        <span className="agent-spawn-parts">{parts.map((part) => <span key={part.kind} className={`agent-spawn-part part-${part.kind}`}>{part.text}</span>)}</span>
      </span>
      <AgentTranscriptElapsed rows={model.rows} />
      {expanded ? <ChevronDown className="agent-transcript-chevron" size={16} aria-hidden /> : <ChevronRight className="agent-transcript-chevron" size={16} aria-hidden />}
    </button>
    {expanded ? <div className="agent-spawn-list">{model.rows.map((row) => <AgentLineageRow key={row.id} row={row} actions={actions} transcript />)}</div> : null}</div>
  );
}
