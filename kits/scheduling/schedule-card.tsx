import { useState, useSyncExternalStore } from "react";
import { CalendarClock } from "lucide-react";
import { errorMessage, type RegionProps } from "tau";
import type { SchedulingFeed } from "./feed.js";
import { scheduleText } from "./job-summary.js";
import type { ScheduleRequest } from "./protocol.js";

const LEVELS: Record<string, string> = { "read-only": "Read-only", ask: "Ask before edits", auto: "Auto review", full: "Full access" };

function ProposalCard({ request, feed, canManage, automationsOn }: { request: ScheduleRequest; feed: SchedulingFeed; canManage: boolean; automationsOn: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const answer = async (approve: boolean) => {
    if (busy || !canManage) return;
    setBusy(true); setError(undefined);
    try { await feed.invoke(approve ? "approve-schedule" : "decline-schedule", approve ? { id: request.id, turnOn: !automationsOn } : { id: request.id }); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };
  const { config } = request;
  return <section className="scheduling-secret scheduling-proposal" aria-label="Automation proposal">
    <header><CalendarClock size={14} /><strong>Automation</strong><span>proposed by this thread</span></header>
    <p><strong>{config.name}</strong> · {scheduleText(config.schedule)} · {config.target ? "continues this thread" : "a new thread each run"} · {LEVELS[config.accessLevel ?? ""] ?? config.accessLevel}</p>
    <p>{request.reason}</p>
    <details><summary>Prompt</summary><pre>{config.prompt}</pre></details>
    <small>{!canManage ? "Approve this in this machine's own Tau window." : !automationsOn ? "Automations are off. Approving turns them on." : "Runs at most at this thread's access level. You can edit or delete it on the Automations page."}</small>
    {error ? <p role="alert">{error}</p> : null}
    <footer><button type="button" disabled={busy || !canManage} onClick={() => void answer(false)}>Decline</button><button type="button" className="primary" disabled={busy || !canManage} onClick={() => void answer(true)}>{busy ? "Saving…" : automationsOn ? "Approve" : "Turn on and approve"}</button></footer>
  </section>;
}

/** The owner's answer to an agent's `tau_schedule_thread`: nothing exists until they approve. */
export default function ScheduleProposal({ actions, feed }: RegionProps & { feed: SchedulingFeed }) {
  const { state } = useSyncExternalStore(feed.subscribe, feed.get);
  const request = state?.scheduleRequests?.find((entry) => entry.threadId === actions.activeThread()?.sessionId && entry.status === "pending");
  return request ? <ProposalCard key={request.id} request={request} feed={feed} canManage={state?.canManage === true} automationsOn={state?.enabled === true} /> : null;
}
