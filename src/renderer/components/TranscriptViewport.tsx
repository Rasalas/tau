import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import type { UiMessage } from "../../shared/contracts";
import type { TranscriptActivity } from "./transcript-activity";
import { TranscriptTurnNavigation } from "./TranscriptTurnNavigation";
import {
  clientIdentityKey,
  resolveTurnMessage,
  type TranscriptMessageLookup,
  type TranscriptNavigationScope,
  type TranscriptTurnStart,
} from "./transcript-navigation";
import { useTranscriptNavigation } from "./transcript-navigation-dom";
import {
  buildTranscriptTurnNavigation,
  shouldShowTranscriptTurnNavigation,
  type TranscriptTurnNavigationEntry,
} from "./transcript-turn-navigation";
import { VirtualTranscript } from "./VirtualTranscript";

export type { TranscriptNavigationScope, TranscriptTurnStart } from "./transcript-navigation";
export { useTranscriptNavigation } from "./transcript-navigation-dom";

const TRANSCRIPT_ID = "thread-transcript";
const VISIBLE_TURN_LEAD = 96;

function messageElement(node: HTMLDivElement, messageId: string): HTMLElement | undefined {
  return [...node.querySelectorAll<HTMLElement>("[data-message-id]")]
    .find((element) => element.dataset.messageId === messageId);
}

function messageContentTop(node: HTMLDivElement, element: HTMLElement): number | undefined {
  const nodeRect = node.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  if (elementRect.height > 0 || elementRect.top !== 0 || nodeRect.top !== 0) {
    return node.scrollTop + elementRect.top - nodeRect.top;
  }
  const transform = element.style.transform.match(/translateY\(\s*(-?\d+(?:\.\d+)?)px\s*\)/u);
  if (transform?.[1] !== undefined) return Number(transform[1]);
  let top = 0;
  let current: HTMLElement | null = element;
  while (current && current !== node) {
    top += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return top;
}

/** Resolve the user prompt whose row currently leads the readable viewport. */
export function visibleTranscriptTurnId(
  node: HTMLDivElement,
  entries: readonly TranscriptTurnNavigationEntry[],
  messageCount?: number,
): string | undefined {
  if (entries.length === 0) return undefined;
  const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
  // The browser clamps a real scroll position at the tail. This explicit
  // check also keeps deterministic renderer fixtures from selecting an older
  // turn when they model scrollTop as scrollHeight.
  if (node.scrollTop >= maxScrollTop - 32) return entries.at(-1)!.messageId;

  const lead = node.scrollTop + Math.min(VISIBLE_TURN_LEAD, Math.max(0, node.clientHeight * 0.35));
  let visible: TranscriptTurnNavigationEntry | undefined;
  for (const entry of entries) {
    const element = messageElement(node, entry.messageId);
    if (!element) continue;
    const top = messageContentTop(node, element);
    if (top !== undefined && top <= lead) visible = entry;
  }
  if (visible) return visible.messageId;

  // A virtualizer can leave every user row outside the DOM while it is
  // settling after a large seek. Estimate the row index until the next scroll
  // event reports the measured window.
  const renderedMessageCount = [...node.querySelectorAll<HTMLElement>("[data-index]")]
    .reduce((largest, element) => Math.max(largest, Number(element.dataset.index) + 1), 0);
  const estimatedMessageCount = Math.max(
    messageCount ?? 0,
    renderedMessageCount,
    entries.at(-1)!.messageIndex + 1,
  );
  const estimatedRowHeight = estimatedMessageCount > 0
    ? Math.max(1, node.scrollHeight / estimatedMessageCount)
    : 0;
  const estimatedIndex = estimatedRowHeight > 0
    ? Math.floor(lead / estimatedRowHeight)
    : 0;
  return [...entries].reverse().find((entry) => entry.messageIndex <= estimatedIndex)?.messageId
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
  const turnEntries = useMemo(
    () => buildTranscriptTurnNavigation(messages),
    [lookupRevision, messages],
  );
  const showTurnNavigation = shouldShowTranscriptTurnNavigation(turnEntries);
  const turnEntriesRef = useRef(turnEntries);
  turnEntriesRef.current = turnEntries;
  const [visibleTurnMessageId, setVisibleTurnMessageId] = useState<string | undefined>(
    () => turnEntries.at(-1)?.messageId,
  );
  const updateVisibleTurnRef = useRef<() => void>(() => {});
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
        ? visibleTranscriptTurnId(node, turnEntriesRef.current, messages.length)
        : turnEntriesRef.current.at(-1)?.messageId;
      setVisibleTurnMessageId((current) => current === next ? current : next);
    };
    updateVisibleTurnRef.current = update;
    update();
    if (!node) return;

    let frame: number | undefined;
    const schedule = () => {
      // Keep the active marker in sync with an explicit scroll immediately;
      // the frame still coalesces the follow-up measurement after virtualization.
      update();
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        update();
      });
    };
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(schedule);
    node.addEventListener("scroll", schedule, { passive: true });
    observer?.observe(node);
    observer?.observe(node.firstElementChild ?? node);
    schedule();
    return () => {
      node.removeEventListener("scroll", schedule);
      observer?.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (updateVisibleTurnRef.current === update) updateVisibleTurnRef.current = () => {};
    };
  }, [messages, scrollRef, turnEntries]);

  const selectTurn = useCallback((messageId: string) => {
    // Reflect the explicit choice immediately; the scroll listener will refine
    // it once the virtual row is mounted and measured.
    setVisibleTurnMessageId(messageId);
    navigation.jumpToMessage(messageId);
    updateVisibleTurnRef.current();
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => updateVisibleTurnRef.current());
    }
  }, [navigation.jumpToMessage]);
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
