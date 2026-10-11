import { useSyncExternalStore } from "react";
import { CircleHelp } from "lucide-react";
import { type RegionProps } from "tau";
import { rowOf, waitingBelow } from "./model.js";
import { openAgent } from "./subagent-view.js";
import { agentsStore } from "./store.js";

/**
 * Above the composer: agents anywhere below this thread that hold on a
 * question, each one a way into it. The card that carries the question sits in
 * the composer; this names who asks, which a deep agent's card does not.
 */
export function AgentQuestionsBanner({ snapshot, actions }: RegionProps) {
  const state = useSyncExternalStore(agentsStore.subscribe, agentsStore.getSnapshot);
  const asking = waitingBelow(state, snapshot?.sessionId);
  if (asking.length === 0 || actions.activeThread()?.sessionId !== snapshot?.sessionId) return null;
  const open = (index: number) => openAgent(rowOf(asking[index]!, new Map()), actions);
  return (
    <div className="agent-asks" role="status" aria-label={asking.length === 1 ? "Sub-agent needs input" : `${asking.length} sub-agents need input`}>
      <CircleHelp size={13} aria-hidden="true" />
      <span className="agent-asks-text">
        <strong>{asking.length === 1 ? "Sub-agent needs input" : `${asking.length} sub-agents need input`}</strong>
        {" · "}
        {asking.map((link, index) => (
          <span key={link.id}>
            {index > 0 ? ", " : null}
            <button type="button" className="agent-asks-link" onClick={() => open(index)}>{link.title}</button>
          </span>
        ))}
      </span>
      <button type="button" className="agent-asks-open" onClick={() => open(0)}>Open question</button>
    </div>
  );
}
