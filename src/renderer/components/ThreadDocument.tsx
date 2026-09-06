import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Bot } from "lucide-react";
import type { UiMessage } from "../../shared/contracts";
import { formatCost } from "../cost-format";
import { errorMessage } from "../error-message";
import { useThreadShell } from "../use-thread-shell";
import { useThreadStore } from "../workbench-context";
import { VirtualTranscript } from "./VirtualTranscript";

/** How often a streaming thread's tab re-reads its transcript. An idle tab polls nothing. */
export const THREAD_TAB_POLL_MS = 2_000;

/** Below this the reader is at the tail and a reload should keep them there. */
const STICK_TO_TAIL_PX = 120;

interface LoadState {
  messages: UiMessage[];
  loaded: boolean;
  error?: string;
}

/**
 * Another thread's transcript in a stage tab, read-only: the composer keeps
 * addressing the active thread, and "Take over" is the one way to switch.
 *
 * The host publishes a background thread's index entry when its turn settles,
 * which is the reload signal; while it is streaming nothing is published until
 * the end, so the tab polls — and only then.
 */
export function ThreadDocument({ sessionId, loadThread, onTakeOver }: {
  sessionId: string;
  loadThread(sessionId: string): Promise<UiMessage[]>;
  onTakeOver(sessionId: string): void;
}) {
  const store = useThreadStore();
  const session = useThreadShell(sessionId);
  const activity = useSyncExternalStore(store.subscribeToActivity, store.getActivity);
  const streaming = activity.runningThreadIds.includes(sessionId);
  const [state, setState] = useState<LoadState>({ messages: [], loaded: false });
  const [tick, setTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Two reload signals besides the poll: the index entry the host republishes
  // when a background turn settles, and the moment this thread becomes the one
  // on screen — which is when the host is holding its runtime again.
  const revision = `${session?.modifiedAt ?? 0}:${session?.messageCount ?? 0}:${activity.activeThreadId === sessionId}`;

  useEffect(() => {
    if (!streaming) return;
    const timer = window.setInterval(() => setTick((current) => current + 1), THREAD_TAB_POLL_MS);
    return () => window.clearInterval(timer);
  }, [streaming]);

  useEffect(() => {
    let cancelled = false;
    void loadThread(sessionId).then(
      (messages) => { if (!cancelled) setState({ messages, loaded: true }); },
      (error: unknown) => { if (!cancelled) setState((current) => ({ ...current, loaded: true, error: errorMessage(error) })); },
    );
    return () => { cancelled = true; };
  // `revision` and `tick` are reload signals, not values this effect reads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadThread, sessionId, revision, tick]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || node.scrollHeight - node.scrollTop - node.clientHeight > STICK_TO_TAIL_PX) return;
    node.scrollTop = node.scrollHeight;
  }, [state.messages]);

  const title = session?.title || "Agent";
  const cost = session?.usage?.costUsd === undefined ? undefined : formatCost(session.usage.costUsd);
  const status = [streaming ? "working" : session ? "idle" : "gone", cost].filter(Boolean).join(" · ");

  return <section className="stage-pane thread-document" aria-label={`Thread ${title}`}>
    <header className="stage-pane-header">
      <span className="stage-tab-icon"><Bot size={13} aria-hidden="true" /></span>
      <strong title={title}>{title}</strong>
      <small>{status}</small>
      {streaming ? <span className="spinner small" aria-label="Agent is working" /> : null}
      <span className="spacer" />
      <button
        className="text-button"
        disabled={!session}
        title="Make this the thread the composer talks to"
        onClick={() => onTakeOver(sessionId)}
      ><span>Take over</span></button>
    </header>
    {!session
      ? <div className="stage-empty" role="status">This thread is not in the index any more. It may have been deleted or pruned.</div>
      : state.error
        // The host only reads a transcript it is holding a runtime for, and it
        // releases the least recently used one. Take over opens the thread again.
        ? <div className="stage-empty" role="status">{state.error} Take over makes it the thread on screen and loads it.</div>
        : !state.loaded
          ? <div className="stage-empty" role="status">Loading the transcript…</div>
          : state.messages.length === 0
            ? <div className="stage-empty" role="status">This thread has no messages yet.</div>
            : <div className="transcript" ref={scrollRef}>
              <div className="transcript-inner">
                <VirtualTranscript
                  messages={state.messages}
                  scrollRef={scrollRef}
                  isStreaming={streaming}
                  sessionKey={sessionId}
                />
              </div>
            </div>}
  </section>;
}
