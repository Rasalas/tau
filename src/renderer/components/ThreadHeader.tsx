import { useSyncExternalStore, type ReactNode } from "react";
import { GitBranch, PanelRightClose, PanelRightOpen } from "lucide-react";
import type { HostSnapshot } from "../../shared/contracts";
import type { ThreadViewStore } from "../../workbench/thread-view-store";
import type { TranscriptState } from "../../workbench/transcript-state";
import { threadCostLabel, threadCostOrigin } from "../cost-format";
import { usePreferences } from "../renderer-services-context";
import { DEFAULT_RUNTIME, modelOnPlan } from "../runtime-marks";
import { ProviderIconStack } from "./ProviderIconStack";
import { tooltipProps } from "./ui/Tooltip";

const turnCounts = new WeakMap<TranscriptState, number>();

/** Prompts the transcript holds; counted once per transcript state, so a streamed delta costs a lookup. */
function countTurns(transcript: TranscriptState): number {
  let count = turnCounts.get(transcript);
  if (count === undefined) {
    count = transcript.messages.reduce((sum, message) => sum + (message.role === "user" ? 1 : 0), 0);
    turnCounts.set(transcript, count);
  }
  return count;
}

function TurnCount({ view }: { view: ThreadViewStore }) {
  const turns = useSyncExternalStore(view.subscribeToTranscript, () => countTurns(view.getTranscript()));
  return turns > 0 ? <span className="thread-detail">turn {turns}</span> : null;
}

/** Branch · model · turn · cost, each only where the thread has it, as in the workbench design. */
export function ThreadDetails({ snapshot, view }: { snapshot?: HostSnapshot; view: ThreadViewStore }) {
  const preferences = usePreferences();
  const { showCosts } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const cost = showCosts && snapshot?.usage ? threadCostLabel(snapshot.usage) : undefined;
  const model = snapshot?.model;
  return <div className="thread-details">
    {snapshot?.projectLabel ? <span className="thread-detail" {...tooltipProps(snapshot.projectLabel, { side: "bottom", when: "truncated" })}>
      <GitBranch size={12} aria-hidden /><span>{snapshot.projectLabel}</span>
    </span> : null}
    {model ? <span className="thread-detail">
      <ProviderIconStack modelProvider={model.provider} runtimeProvider={snapshot?.backendKind ?? DEFAULT_RUNTIME} plan={modelOnPlan(model)} hint={false} />
      <span>{model.name}</span>
    </span> : null}
    <TurnCount view={view} />
    {cost && snapshot?.usage ? <span className="thread-detail thread-detail-cost" {...tooltipProps(threadCostOrigin(snapshot.usage), { side: "bottom" })}>{cost}</span> : null}
  </div>;
}

/**
 * The conversation's own head, where the window-wide title bar was: the
 * thread's title and details, what kits place at its end, and the stage's
 * toggle. It is the window's drag region over the conversation.
 */
export function ThreadHeader({ lead, title, details, actions, stage }: {
  /** Before the title: room for the traffic lights, a tablet's threads toggle. */
  lead?: ReactNode;
  title: ReactNode;
  details?: ReactNode;
  /** The `title-bar` region's slot. */
  actions?: ReactNode;
  stage?: { shown: boolean; shortcut?: string; onToggle(): void };
}) {
  const stageLabel = stage?.shown ? "Hide stage" : "Show stage";
  return <header className="thread-header">
    {lead}
    <div className="thread-heading">
      <div className="thread-heading-title">{title}</div>
      {details}
    </div>
    <div className="thread-header-actions">{actions}</div>
    {stage ? <button
      type="button"
      className="stage-tool"
      aria-label={stageLabel}
      aria-pressed={stage.shown}
      {...tooltipProps(stageLabel, { side: "bottom", shortcut: stage.shortcut })}
      onClick={stage.onToggle}
    >{stage.shown ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button> : null}
  </header>;
}
