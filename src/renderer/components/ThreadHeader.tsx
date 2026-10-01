import { useSyncExternalStore, type ReactNode } from "react";
import { GitBranch, PanelRightClose, PanelRightOpen } from "lucide-react";
import type { HostSnapshot } from "../../shared/contracts";
import type { ThreadViewStore } from "../../workbench/thread-view-store";
import type { TranscriptState } from "../../workbench/transcript-state";
import { usePreferences } from "../renderer-services-context";
import { DEFAULT_RUNTIME, modelOnPlan } from "../runtime-marks";
import { ProviderIconStack } from "./ProviderIconStack";
import { ThreadCost } from "./ThreadCost";
import { tooltipProps } from "./ui/Tooltip";
import { Region, RegionOr } from "./Regions";
import { startsTurn } from "./MessageText";
import type { ExtensionRegistry, WorkbenchActions } from "../extension-system";

const turnCounts = new WeakMap<TranscriptState, number>();

/** Prompts the transcript holds; counted once per transcript state, so a streamed delta costs a lookup. */
function countTurns(transcript: TranscriptState): number {
  let count = turnCounts.get(transcript);
  if (count === undefined) {
    count = transcript.messages.filter(startsTurn).length;
    turnCounts.set(transcript, count);
  }
  return count;
}

function TurnCount({ view }: { view: ThreadViewStore }) {
  const turns = useSyncExternalStore(view.subscribeToTranscript, () => countTurns(view.getTranscript()));
  return turns > 0 ? <span className="thread-detail thread-detail-turn">turn {turns}</span> : null;
}

/** Where kits add to the sub-line: `thread-details` items, and a `thread-branch` that replaces core's label. */
export interface ThreadDetailSlots {
  registry: ExtensionRegistry;
  actions: WorkbenchActions;
}

/** The kits' items, then their branch or core's plain one. */
function SlotDetails({ slots, snapshot, branch }: { slots?: ThreadDetailSlots; snapshot?: HostSnapshot; branch?: string }) {
  const plain = branch ? <span className="thread-detail thread-detail-branch" {...tooltipProps(branch, { side: "bottom", when: "truncated" })}>
    <GitBranch size={12} aria-hidden /><span>{branch}</span>
  </span> : null;
  if (!slots) return plain;
  return <>
    <Region bare registry={slots.registry} placement="thread-details" snapshot={snapshot} actions={slots.actions} />
    <RegionOr bare registry={slots.registry} placement="thread-branch" snapshot={snapshot} actions={slots.actions} fallback={plain} />
  </>;
}

/** The start screen's sub-line: an empty thread's branch, or what a kit says of a draft (design 1k). */
export function StartDetails({ snapshot, slots }: { snapshot?: HostSnapshot; slots?: ThreadDetailSlots }) {
  return <div className="thread-details"><SlotDetails slots={slots} snapshot={snapshot} {...(snapshot?.projectLabel ? { branch: snapshot.projectLabel } : {})} /></div>;
}

/** [Machine ·] branch · model · turn · cost, each only where the thread has it, as in the workbench design. */
export function ThreadDetails({ snapshot, view, slots, machine }: {
  snapshot?: HostSnapshot;
  view: ThreadViewStore;
  slots?: ThreadDetailSlots;
  /** The host's name, where no kit names the machine (a phone's bar, design 1n). */
  machine?: string | undefined;
}) {
  const preferences = usePreferences();
  const { showCosts } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const model = snapshot?.model;
  return <div className="thread-details">
    {machine ? <span className="thread-detail thread-detail-machine"><span>{machine}</span></span> : null}
    <SlotDetails slots={slots} snapshot={snapshot} {...(snapshot?.projectLabel ? { branch: snapshot.projectLabel } : {})} />
    {model ? <span className="thread-detail thread-detail-model">
      <ProviderIconStack modelProvider={model.provider} runtimeProvider={snapshot?.backendKind ?? DEFAULT_RUNTIME} plan={modelOnPlan(model)} hint={false} />
      <span>{model.name}</span>
    </span> : null}
    <TurnCount view={view} />
    {showCosts && snapshot?.usage ? <ThreadCost usage={snapshot.usage} className="thread-detail thread-detail-cost" /> : null}
  </div>;
}

/**
 * The conversation's own head, where the window-wide title bar was: the
 * thread's title and details, what kits place at its end, and the stage's
 * toggle. It is the window's drag region over the conversation.
 */
export function ThreadHeader({ lead, title, details, actions, tools, stage }: {
  /** Before the title: room for the traffic lights, a tablet's threads toggle. */
  lead?: ReactNode;
  title: ReactNode;
  details?: ReactNode;
  /** The `title-bar` region's slot. */
  actions?: ReactNode;
  /** The stage strip's tools, here while the stage is hidden (design 1k). */
  tools?: ReactNode;
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
    {tools ? <div className="thread-header-tools" role="toolbar" aria-label="Tools">{tools}</div> : null}
    {tools && stage ? <span className="thread-header-separator" aria-hidden /> : null}
    {stage ? <button
      type="button"
      className="stage-tool"
      aria-label={stageLabel}
      aria-pressed={stage.shown}
      {...tooltipProps(stageLabel, { side: "bottom", shortcut: stage.shortcut })}
      onClick={stage.onToggle}
    >{stage.shown ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}</button> : null}
  </header>;
}
