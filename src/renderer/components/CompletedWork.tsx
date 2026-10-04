import { ChevronRight, Clock } from "lucide-react";
import { createContext } from "react";
import type { UiMessage } from "../../shared/contracts";
import type { CompletedTurnWork } from "./completed-turn-work";
import { Message } from "./Message";
import { LazyFeatureBoundary } from "./LazyFeature";
import { useDisclosure, type WorkDisclosures } from "./work-disclosures";

export const CompletedWorkContext = createContext(false);

export function CompletedWork({ work, disclosures, onCopy }: {
  work: CompletedTurnWork;
  disclosures: WorkDisclosures;
  onCopy?: (message: UiMessage) => void;
}) {
  const [open, setOpen] = useDisclosure(disclosures, work.id, work.keepOpen);
  const activities = new Map<string, typeof work.activities[number][]>();
  const leading = [];
  for (const activity of work.activities) {
    const message = work.messages.find((candidate) => candidate.id === activity.afterMessageId || candidate.sourceEntryId === activity.afterMessageId);
    if (!message) leading.push(activity);
    else activities.set(message.id, [...(activities.get(message.id) ?? []), activity]);
  }
  const renderActivity = (activity: typeof work.activities[number]) =>
    <LazyFeatureBoundary key={activity.id} label={activity.id}>{activity.content}</LazyFeatureBoundary>;
  return <section className={`work-fold${open ? " expanded" : ""}`} data-folded-message-ids={JSON.stringify(work.messages.map((message) => message.id))}>
    <button type="button" className="work-fold-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Clock size={13} strokeWidth={1.7} aria-hidden="true" />
      <span>{work.label}</span>
      <ChevronRight className="activity-chevron" size={13} />
    </button>
    {open ? <CompletedWorkContext.Provider value={true}><div className="work-fold-body">
      {leading.map(renderActivity)}
      {work.messages.map((message) => <div key={message.id} data-message-id={message.id}>
        <Message message={message} detail="detailed" onCopy={message.text ? onCopy : undefined} />
        {(activities.get(message.id) ?? []).map(renderActivity)}
      </div>)}
    </div></CompletedWorkContext.Provider> : null}
  </section>;
}
