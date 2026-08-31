import { memo, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import type { UiMessage } from "../../shared/contracts";
import type { TranscriptActivity } from "./transcript-activity";
import {
  clientIdentityKey,
  resolveTurnMessage,
  type TranscriptMessageLookup,
  type TranscriptNavigationScope,
  type TranscriptTurnStart,
} from "./transcript-navigation";
import { useTranscriptNavigation } from "./transcript-navigation-dom";
import { VirtualTranscript } from "./VirtualTranscript";

export type { TranscriptNavigationScope, TranscriptTurnStart } from "./transcript-navigation";
export { useTranscriptNavigation } from "./transcript-navigation-dom";

export interface TranscriptViewportProps {
  messages: UiMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  sessionId?: string;
  /** Semantic project/thread/draft scope used to invalidate navigation state. */
  scopeKey?: string;
  /** Visible record revision; changes for streaming deltas without forcing lookup rebuilds. */
  revision?: number;
  /** Incremented when user-message lookup fields change, but not for assistant deltas. */
  lookupRevision?: number;
  scope?: TranscriptNavigationScope;
  turnStart?: TranscriptTurnStart;
  isStreaming: boolean;
  activities?: readonly TranscriptActivity[];
  liveStatus?: ReactNode;
  onCopyMessage?: (message: UiMessage) => void;
  onForkMessage?: (message: UiMessage) => void;
  onReachStart?: () => void;
}

export const TranscriptViewport = memo(function TranscriptViewport({
  messages,
  scrollRef,
  sessionId,
  turnStart,
  isStreaming,
  activities = [],
  scope,
  scopeKey,
  revision,
  lookupRevision,
  liveStatus,
  onCopyMessage,
  onForkMessage,
  onReachStart,
}: TranscriptViewportProps) {
  const messageScopeKey = scopeKey ?? turnStart?.scopeKey ?? sessionId;
  const lookupRef = useRef<{
    scopeKey?: string;
    length: number;
    firstId?: string;
    lastId?: string;
    lookupRevision?: number;
    messages: UiMessage[];
    lookup: TranscriptMessageLookup;
  } | undefined>(undefined);
  const firstId = messages[0]?.id;
  const lastId = messages.at(-1)?.id;
  const previousLookup = lookupRef.current;
  if (!previousLookup
    || previousLookup.scopeKey !== messageScopeKey
    || previousLookup.length !== messages.length
    || previousLookup.firstId !== firstId
    || previousLookup.lastId !== lastId
    || previousLookup.lookupRevision !== lookupRevision
    || (lookupRevision === undefined && previousLookup.messages !== messages)) {
    const byId = new Map<string, UiMessage>();
    const byClientIdentity = new Map<string, UiMessage>();
    const byText = new Map<string, UiMessage[]>();
    const positions = new Map<string, number>();
    messages.forEach((message, index) => {
      positions.set(message.id, index);
      // Turn anchors are always user messages. Excluding assistant deltas from
      // these maps keeps the lookup immutable across every streaming update.
      if (message.role !== "user") return;
      byId.set(message.id, message);
      const textMessages = byText.get(message.text) ?? [];
      textMessages.push(message);
      byText.set(message.text, textMessages);
      if (message.clientTurnId && message.clientMessageId) {
        byClientIdentity.set(clientIdentityKey(message.clientTurnId, message.clientMessageId), message);
      }
    });
    lookupRef.current = {
      scopeKey: messageScopeKey,
      length: messages.length,
      firstId,
      lastId,
      lookupRevision,
      messages,
      lookup: { byId, byClientIdentity, byText, positions },
    };
  }
  const lookup = lookupRef.current!.lookup;
  const [currentTurnAnchor, setCurrentTurnAnchor] = useState<{ sessionId?: string; id?: string }>(
    () => ({ sessionId, id: resolveTurnMessage(messages, turnStart, lookup)?.id }),
  );
  const reportCurrentTurnAnchor = useCallback((id?: string) => {
    setCurrentTurnAnchor((current) => current.sessionId === sessionId && current.id === id
      ? current
      : { sessionId, id });
  }, [sessionId]);
  const navigation = useTranscriptNavigation(
    scrollRef,
    [messages, activities, liveStatus, turnStart, revision],
    {
      sessionId,
      scopeKey: messageScopeKey,
      lookupRevision,
      scope: scope ?? turnStart?.scope,
      turnStart,
      messages,
      lookup,
      onAnchorChange: reportCurrentTurnAnchor,
    },
  );
  const onReachStartRef = useRef(onReachStart);
  onReachStartRef.current = onReachStart;

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onScroll = () => {
      if (node.scrollTop < 120) onReachStartRef.current?.();
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [scrollRef]);

  return <div className="transcript-viewport">
    <div
      className="transcript"
      ref={scrollRef}
      tabIndex={0}
      role="log"
      aria-label="Thread transcript"
    >
      <div className="transcript-inner">
        <VirtualTranscript
          messages={messages}
          scrollRef={scrollRef}
          isStreaming={isStreaming}
          activities={activities}
          messageScopeKey={messageScopeKey}
          revision={revision}
          lookupRevision={lookupRevision}
          activeTurnStartId={currentTurnAnchor.sessionId === sessionId ? currentTurnAnchor.id : undefined}
          onCopyMessage={onCopyMessage}
          onForkMessage={onForkMessage}
        />
        {liveStatus}
      </div>
    </div>
    {navigation.canJumpToLatest ? (
      <div className="transcript-overlay">
        <button
          type="button"
          className="transcript-jump"
          aria-label="Jump to latest"
          title="Jump to latest"
          onClick={navigation.jumpToLatest}
        >
          <ChevronDown size={14} aria-hidden="true" />
          <span>Jump to latest</span>
        </button>
      </div>
    ) : null}
  </div>;
});
