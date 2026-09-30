import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Bot, MessageCircleQuestionMark, Server } from "lucide-react";
import type { UiEnvironmentThreadView } from "../../shared/environments";
import { formatCost } from "../cost-format";
import { errorMessage } from "../../workbench/error-message";
import { answerTimestampAfter } from "../../workbench/transcript-folding";
import type { ExtensionRegistry, WorkbenchActions } from "../extension-system";
import { Region } from "./Regions";
import type { TranscriptActivity } from "./transcript-activity";
import { WorkGroup } from "./WorkRows";
import { WorkDisclosures } from "./work-disclosures";
import { usePlatform } from "../platform-context";
import { usePreferences } from "../renderer-services-context";
import { useEnvironmentThread, useEnvironmentTranscript } from "../use-environment-thread";
import { tooltipProps } from "./ui/Tooltip";
import { useStickToTail } from "./ThreadDocument";
import { VirtualTranscript } from "./VirtualTranscript";

/** Why the window cannot move to the thread's machine now; undefined when it can. */
export function openReason(view: UiEnvironmentThreadView | undefined, canOpen: boolean): string | undefined {
  if (!canOpen) return "This client cannot show another machine.";
  if (!view) return "Reaching the machine…";
  if (view.status === "unknown") return `This window does not know the machine “${view.machineName}”.`;
  if (view.status === "refused") return `${view.machineName} refuses this window.`;
  if (view.status !== "connected") return `${view.machineName} is not reachable right now.`;
  if (!view.thread) return view.indexed ? `${view.machineName} does not list this thread any more.` : `Reading ${view.machineName}'s threads…`;
  return undefined;
}

/** The line under the header: why the transcript may be stale or missing. */
function statusNote(view: UiEnvironmentThreadView | undefined, canWatch: boolean): string | undefined {
  if (!canWatch) return "This client reaches no other machine. Open the thread from the desktop window.";
  if (!view) return undefined;
  if (view.status === "unknown") return `This window does not know the machine “${view.machineName}”. Add it in Settings → Machines.`;
  if (view.status === "refused") return `${view.machineName} refuses this window${view.detail ? `: ${view.detail}` : "."}`;
  if (view.status === "offline") {
    const since = view.lastSeenAt === undefined ? "" : ` since ${new Date(view.lastSeenAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    return `${view.machineName} is offline${since}. The thread may still run there; this is what it showed last.`;
  }
  if (view.status === "connected" && view.indexed && !view.thread) return `${view.machineName} does not list this thread any more. It may have been deleted there.`;
  return undefined;
}

/**
 * A thread of another machine in a stage tab, read-only (API 1.15.0): its
 * transcript comes over the window's own connection to that machine, and the
 * window receives the thread's stream only while the tab is open. Answering
 * or taking it over happens there: "Open on <machine>" moves the window.
 */
export function RemoteThreadDocument({ machine, sessionId, registry, actions }: {
  machine: string;
  sessionId: string;
  /** For the kits' `look-in` region; without it the tab has none. */
  actions?: WorkbenchActions;
  /** Draws the tool runs with this page's tool cards; without it the tab shows messages only. */
  registry?: ExtensionRegistry | undefined;
}) {
  const environments = usePlatform().environments;
  const view = useEnvironmentThread(environments, machine, sessionId);
  const transcript = useEnvironmentTranscript(environments, view);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [opening, setOpening] = useState(false);
  const [problem, setProblem] = useState<string>();
  useStickToTail(scrollRef, transcript.messages);
  const preferences = usePreferences();
  useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const detail = preferences.transcriptDetailFor(sessionId);
  const disclosures = useMemo(() => new WorkDisclosures(), [machine, sessionId]);

  const activities = useMemo<readonly TranscriptActivity[]>(() => !registry ? [] : transcript.activity
    .filter((entry) => entry.tools.length > 0)
    .map((entry) => {
      const answerAt = answerTimestampAfter(transcript.messages, entry.anchorMessageId);
      return {
        id: entry.id,
        afterMessageId: entry.anchorMessageId,
        fallbackToTail: entry.status === "running",
        content: <WorkGroup
          id={entry.id}
          tools={entry.tools}
          registry={registry}
          detail={detail}
          disclosures={disclosures}
          status={entry.status}
          // The run there, not this page's: a tool that waits on a dialog is not stalled.
          streaming={entry.status === "running" ? true : undefined}
          waiting={Boolean(view?.asking)}
          {...(answerAt === undefined ? {} : { answerAt })}
        />,
      };
    }), [detail, disclosures, registry, transcript.activity, transcript.messages, view?.asking]);

  const canWatch = Boolean(environments?.watchThread && environments.transcriptPage);
  const name = view?.machineName ?? machine;
  const thread = view?.thread;
  const title = thread?.title || "Thread";
  const running = thread?.running === true && view?.status === "connected";
  const cost = thread?.usage?.costUsd === undefined ? undefined : formatCost(thread.usage.costUsd);
  const state = view?.status === "connected"
    ? view.asking ? "waiting for an answer" : running ? "working" : thread ? "idle" : undefined
    : view?.status === "offline" ? "offline" : view?.status === "refused" ? "refused" : undefined;
  const status = [state, cost].filter(Boolean).join(" · ");
  const reason = openReason(view, Boolean(environments));
  const note = statusNote(view, canWatch);

  const open = () => {
    if (!environments || !view?.thread || reason) return;
    setOpening(true);
    setProblem(undefined);
    // The page loads again on that machine; an error leaves this one as it was.
    environments.open(view.machine, { thread: { path: view.thread.path } }).catch((error: unknown) => {
      setOpening(false);
      setProblem(errorMessage(error));
    });
  };

  return <section className="stage-pane thread-document remote-thread-document" aria-label={`Thread ${title} on ${name}`}>
    <header className="stage-pane-header">
      <span className="stage-tab-icon"><Bot size={13} aria-hidden="true" /></span>
      <strong title={title}>{title}</strong>
      <span className="remote-thread-machine" {...tooltipProps(`Runs on ${name}; read over this window's connection there`)}>
        <Server size={11} aria-hidden="true" />{name}
      </span>
      {status ? <small>{status}</small> : null}
      {running ? <span className="spinner small" aria-label="Agent is working" /> : null}
      <span className="spacer" />
      <button
        className="text-button"
        disabled={Boolean(reason) || opening}
        aria-label={`Open on ${name}`}
        {...tooltipProps(reason ?? `Show ${name} in this window, with this thread, to answer or take it over`)}
        onClick={open}
      ><Server size={13} aria-hidden="true" /><span>{opening ? "Opening…" : `Open on ${name}`}</span></button>
    </header>
    {view?.asking && view.status === "connected" ? (
      <div className="remote-thread-band" data-level="question" role="status">
        <MessageCircleQuestionMark size={13} aria-hidden="true" />
        <span className="remote-thread-question">Asks: {view.asking.title}</span>
        <small>Answer it on {name}</small>
      </div>
    ) : null}
    {note ? <div className="remote-thread-band" role="status"><span>{note}</span></div> : null}
    {problem ? <div className="remote-thread-band" data-level="error" role="alert"><span>{problem}</span></div> : null}
    {registry && actions && view && view.status !== "unknown" ? <Region
      registry={registry}
      placement="look-in"
      actions={actions}
      lookIn={{ machine: view.machine, machineName: name, sessionId, connected: view.status === "connected" }}
    /> : null}
    {!canWatch || view?.status === "unknown"
      ? null
      : transcript.error && transcript.messages.length === 0
        ? <div className="stage-empty" role="status">{transcript.error}</div>
        : !transcript.loaded
          ? view?.status === "connected" || !view ? <div className="stage-empty" role="status">Loading the transcript from {name}…</div> : null
          : transcript.messages.length === 0
            ? <div className="stage-empty" role="status">This thread has no messages yet.</div>
            : <div className="transcript" ref={scrollRef}>
              <div className="transcript-inner">
                <VirtualTranscript
                  messages={transcript.messages}
                  scrollRef={scrollRef}
                  isStreaming={running}
                  activities={activities}
                  sessionKey={`${machine}:${sessionId}`}
                  detail={detail}
                />
              </div>
            </div>}
  </section>;
}
