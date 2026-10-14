import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ExtensionUiPrompt, UiMessage, UiTurnActivityEntry } from "../shared/contracts";
import { ThreadViewStore } from "../workbench/thread-view-store";
import { TranscriptViewport } from "./components/TranscriptViewport";
import { useConversationActivities } from "./conversation-activities";
import { ExtensionRegistry } from "./extension-system";

const SESSION = "activity-stream-benchmark";
const noop = () => {};
const done = async () => undefined;
const prompts: readonly ExtensionUiPrompt[] = [];

export function activityStreamFixture(turns: number, historyEntries: number): ThreadViewStore {
  const messages: UiMessage[] = Array.from({ length: turns * 2 }, (_, index) => ({
    id: `message-${index}`, role: index % 2 === 0 ? "user" : "assistant",
    text: `Turn ${Math.floor(index / 2)}\n\nA settled benchmark message.`, timestamp: index * 10,
  }));
  const history: UiTurnActivityEntry[] = Array.from({ length: historyEntries }, (_, index) => ({
    id: `history-${index}`, anchorMessageId: messages[index * 2].id, status: "completed",
    tools: [{ id: `tool-${index}`, name: "read", args: { path: "file.ts" }, status: "done", startedAt: index * 20 + 1, endedAt: index * 20 + 2 }],
  }));
  const store = new ThreadViewStore();
  store.beginThread(SESSION);
  store.setMessages(messages);
  store.setTurnActivityHistory(history);
  return store;
}

/** The real activity projection with new message arrays on every stream frame. */
export default function ActivityStreamScenario({ turns, historyEntries, bytes, updates, onTick, onFinished }: {
  turns: number; historyEntries: number; bytes: number; updates: number;
  onTick(tick: number): void;
  onFinished(bytes: number): void;
}) {
  const [store] = useState(() => activityStreamFixture(turns, historyEntries));
  const [registry] = useState(() => new ExtensionRegistry());
  const transcript = useSyncExternalStore(store.subscribeToTranscript, store.getTranscript);
  const { transcriptActivities } = useConversationActivities({
    pendingNewThread: false, running: true, prompts, registry, viewStore: store, detail: "focused",
    recoverThread: done, copyToolOutput: done, loadToolOutput: done, abort: noop,
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const committedUpdate = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => {
    const acknowledge = committedUpdate.current;
    committedUpdate.current = undefined;
    acknowledge?.();
  }, [transcript.revision]);

  useEffect(() => {
    let stopped = false;
    let tick = 0;
    let sent = 0;
    const initialLength = store.getTranscript().messages.at(-1)!.text.length;
    const step = async () => {
      if (stopped) return;
      if (tick === updates) { onFinished(store.getTranscript().messages.at(-1)!.text.length - initialLength); return; }
      const next = Math.floor(bytes * (tick + 1) / updates);
      // Zero is the parent's initial tick. Every requested update must change
      // it so production React's commit measurement includes the first one.
      onTick(tick + 1);
      const committed = new Promise<void>((resolve) => { committedUpdate.current = resolve; });
      store.dispatch({ type: "assistant-delta", sessionId: SESSION, id: `message-${turns * 2 - 1}`, delta: "x".repeat(next - sent) });
      store.flushAssistantDeltas();
      // Frame scheduling alone does not acknowledge a React commit. Await the
      // rendered transcript revision before sending more data or finishing.
      await committed;
      if (stopped) return;
      sent = next;
      tick += 1;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(() => requestAnimationFrame(step));
    return () => {
      stopped = true;
      committedUpdate.current?.();
      committedUpdate.current = undefined;
    };
  }, [bytes, onFinished, onTick, store, turns, updates]);

  const anchor = transcript.messages[8];
  return <TranscriptViewport
    messages={[...transcript.messages]}
    revision={transcript.revision}
    lookupRevision={transcript.lookupRevision}
    scrollRef={scrollRef}
    sessionId={SESSION}
    turnStart={{ turnId: "historical-turn", sessionId: SESSION, messageId: anchor.id, text: anchor.text, timestamp: anchor.timestamp }}
    isStreaming
    activities={transcriptActivities}
  />;
}
