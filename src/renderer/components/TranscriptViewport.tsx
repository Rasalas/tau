import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import type { UiMessage } from "../../shared/contracts";
import type { TranscriptActivity } from "./transcript-activity";
import { TranscriptTurnNavigation } from "./TranscriptTurnNavigation";
import {
  clientIdentityKey,
  resolveTurnMessage,
  type TranscriptNavigationScope,
  type TranscriptTurnStart,
} from "../../workbench/transcript-navigation";
import { useTranscriptNavigation } from "./transcript-navigation-dom";
import { contentTop, FrameLoop } from "./transcript-scroll-controller";
import {
  buildTranscriptTurnNavigation,
  shouldShowTranscriptTurnNavigation,
  type TranscriptTurnNavigationEntry,
} from "./transcript-turn-navigation";
import { VirtualTranscript, type TranscriptVisibleRange } from "./VirtualTranscript";

export type { TranscriptNavigationScope, TranscriptTurnStart } from "../../workbench/transcript-navigation";
export { useTranscriptNavigation } from "./transcript-navigation-dom";

const TRANSCRIPT_ID = "thread-transcript";
const VISIBLE_TURN_LEAD = 96;
const HISTORY_REACH_START_PX = 120;

interface MutableTranscriptMessageLookup {
  byId: Map<string, UiMessage>;
  byClientIdentity: Map<string, UiMessage>;
  byText: Map<string, UiMessage[]>;
  positions: Map<string, number>;
}

function emptyTranscriptMessageLookup(): MutableTranscriptMessageLookup {
  return {
    byId: new Map(),
    byClientIdentity: new Map(),
    byText: new Map(),
    positions: new Map(),
  };
}

function populateTranscriptMessageLookup(
  messages: readonly UiMessage[],
  lookup: MutableTranscriptMessageLookup,
): void {
  lookup.byId.clear();
  lookup.byClientIdentity.clear();
  lookup.byText.clear();
  lookup.positions.clear();
  messages.forEach((message, index) => {
    lookup.positions.set(message.id, index);
    // Turn anchors are always user messages. Excluding assistant deltas from
    // these maps keeps the lookup immutable across every streaming update.
    if (message.role !== "user") return;
    lookup.byId.set(message.id, message);
    const textMessages = lookup.byText.get(message.text) ?? [];
    textMessages.push(message);
    lookup.byText.set(message.text, textMessages);
    if (message.clientTurnId && message.clientMessageId) {
      lookup.byClientIdentity.set(clientIdentityKey(message.clientTurnId, message.clientMessageId), message);
    }
  });
}

function virtualizerVisibleRange(node: HTMLDivElement): TranscriptVisibleRange | undefined {
  const content = node.querySelector<HTMLElement>(".virtual-transcript");
  const startIndex = Number.parseInt(content?.dataset.visibleStartIndex ?? "", 10);
  const endIndex = Number.parseInt(content?.dataset.visibleEndIndex ?? "", 10);
  return Number.isInteger(startIndex) && Number.isInteger(endIndex)
    ? { startIndex, endIndex }
    : undefined;
}

/** Resolve the user prompt whose row currently leads the readable viewport. */
export function visibleTranscriptTurnId(
  node: HTMLDivElement,
  entries: readonly TranscriptTurnNavigationEntry[],
  visibleRange?: TranscriptVisibleRange,
): string | undefined {
  if (entries.length === 0) return undefined;

  const lead = node.scrollTop + Math.min(VISIBLE_TURN_LEAD, Math.max(0, node.clientHeight * 0.35));
  const elementsByMessageId = new Map<string, HTMLElement>();
  node.querySelectorAll<HTMLElement>("[data-message-id]").forEach((element) => {
    const messageId = element.dataset.messageId;
    if (messageId !== undefined) elementsByMessageId.set(messageId, element);
  });
  let visible: TranscriptTurnNavigationEntry | undefined;
  for (const entry of entries) {
    const element = elementsByMessageId.get(entry.messageId);
    if (!element) continue;
    if (contentTop(node, element) <= lead) visible = entry;
  }
  if (visible) return visible.messageId;

  // If the current user row is outside the DOM, use the virtualizer's real
  // measured viewport range. Do not infer a row from total scroll height:
  // assistant/tool rows are variable-height and make that estimate wrong.
  const measuredRange = visibleRange ?? virtualizerVisibleRange(node);
  if (!measuredRange) return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.messageIndex < measuredRange.startIndex) return entry.messageId;
  }
  return entries.find((entry) => entry.messageIndex <= measuredRange.endIndex)?.messageId
    ?? entries[0]!.messageId;
}

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
  const firstId = messages[0]?.id;
  const lastId = messages.at(-1)?.id;
  // Resolve the initial anchor through the existing message array. The
  // reusable lookup is filled after first paint so a long transcript does not
  // pay four O(history) map builds on the mount-critical path.
  const lookup = useMemo(
    () => emptyTranscriptMessageLookup(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messageScopeKey, messages.length, firstId, lastId, lookupRevision, lookupRevision === undefined ? messages : undefined],
  );
  const [turnEntries, setTurnEntries] = useState<TranscriptTurnNavigationEntry[]>([]);
  useEffect(() => {
    // Keep the first transcript paint on the existing virtualizer path. Prompt
    // previews are useful after that paint, but building hundreds of them is
    // unnecessary work on the mount-critical path.
    let frame: number | undefined;
    const update = () => {
      populateTranscriptMessageLookup(messages, lookup);
      setTurnEntries(buildTranscriptTurnNavigation(messages));
    };
    if (typeof window.requestAnimationFrame === "function") {
      frame = window.requestAnimationFrame(update);
    } else {
      update();
    }
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [lookup, lookupRevision, messages]);
  const showTurnNavigation = shouldShowTranscriptTurnNavigation(turnEntries);
  const turnEntriesRef = useRef(turnEntries);
  useLayoutEffect(() => { turnEntriesRef.current = turnEntries; }, [turnEntries]);
  const [visibleTurnMessageId, setVisibleTurnMessageId] = useState<string | undefined>(
    () => turnEntries.at(-1)?.messageId,
  );
  const updateVisibleTurnRef = useRef<() => void>(() => {});
  // One frame slot for the turn marker: a scroll burst and an explicit
  // selection coalesce into a single follow-up measurement.
  const [turnMarkerFrame] = useState(() => new FrameLoop());
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
  useEffect(() => {
    const node = scrollRef.current;
    const update = () => {
      const next = node
        ? visibleTranscriptTurnId(node, turnEntriesRef.current)
        : turnEntriesRef.current.at(-1)?.messageId;
      if (next === undefined) return;
      setVisibleTurnMessageId((current) => current === next ? current : next);
    };
    updateVisibleTurnRef.current = update;
    update();
    if (!node) return;

    const schedule = () => {
      // Keep the active marker in sync with an explicit scroll immediately;
      // the frame still coalesces the follow-up measurement after virtualization.
      update();
      turnMarkerFrame.schedule(update);
    };
    const unsubscribeScroll = navigation.subscribeScroll(schedule);
    const unsubscribeResize = navigation.subscribeResize(schedule);
    schedule();
    return () => {
      unsubscribeScroll();
      unsubscribeResize();
      turnMarkerFrame.cancel();
      if (updateVisibleTurnRef.current === update) updateVisibleTurnRef.current = () => {};
    };
  }, [messages, navigation.subscribeResize, navigation.subscribeScroll, scrollRef, turnEntries, turnMarkerFrame]);

  const selectTurn = useCallback((messageId: string) => {
    // Reflect the explicit choice immediately; the scroll listener will refine
    // it once the virtual row is mounted and measured.
    setVisibleTurnMessageId(messageId);
    navigation.jumpToMessage(messageId);
    updateVisibleTurnRef.current();
    turnMarkerFrame.schedule(() => updateVisibleTurnRef.current());
  }, [navigation.jumpToMessage, turnMarkerFrame]);
  const onReachStartRef = useRef(onReachStart);
  useLayoutEffect(() => { onReachStartRef.current = onReachStart; }, [onReachStart]);

  useEffect(() => navigation.subscribeScroll(() => {
    const node = scrollRef.current;
    if (node && node.scrollTop < HISTORY_REACH_START_PX) onReachStartRef.current?.();
  }), [navigation.subscribeScroll, scrollRef]);

  return <div className={`transcript-viewport${showTurnNavigation ? " with-turn-navigation" : ""}`}>
    {showTurnNavigation ? (
      <TranscriptTurnNavigation
        entries={turnEntries}
        activeMessageId={visibleTurnMessageId}
        transcriptId={TRANSCRIPT_ID}
        onSelect={selectTurn}
      />
    ) : null}
    <div
      className="transcript"
      ref={scrollRef}
      id={TRANSCRIPT_ID}
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
