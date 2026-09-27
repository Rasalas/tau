import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import type { UiMessage } from "../../shared/contracts";
import type { TranscriptActivity } from "./transcript-activity";
import type { TranscriptDetail } from "../../workbench/transcript-folding";
import { TranscriptTurnNavigation } from "./TranscriptTurnNavigation";
import { TranscriptSearch } from "../deferred-surfaces";
import {
  clientIdentityKey,
  resolveTurnMessage,
  type TranscriptNavigationScope,
  type TranscriptTurnStart,
} from "../../workbench/transcript-navigation";
import { useTranscriptNavigation } from "./transcript-navigation-dom";
import { contentTop, FrameLoop, nearTranscriptStart, nearTranscriptTail } from "./transcript-scroll-controller";
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
/** Older turns load while the reader is still this many viewports from the start. */
const HISTORY_REACH_VIEWPORTS = 2;

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

/** How the caller resolves the ends of the rail, which the DOM alone cannot say. */
export interface VisibleTranscriptTurnOptions {
  /** Virtualizer-measured row range, used when no user row is mounted. */
  visibleRange?: TranscriptVisibleRange;
  /** The transcript has reached its end. */
  atTail?: boolean;
  /** The transcript still sits at its start. */
  atStart?: boolean;
}

/** Resolve the user prompt whose row currently leads the readable viewport. */
export function visibleTranscriptTurnId(
  node: HTMLDivElement,
  entries: readonly TranscriptTurnNavigationEntry[],
  options: VisibleTranscriptTurnOptions = {},
): string | undefined {
  if (entries.length === 0) return undefined;

  // The ends of the scroll own the ends of the rail. A short final turn keeps
  // its prompt below the lead line, so without a tail clamp the marker stops a
  // turn short of the bottom and the rail advertises scroll that is not there.
  // A transcript that fits its viewport is read from the top, so start wins.
  if (options.atStart) return entries[0]!.messageId;
  if (options.atTail) return entries[entries.length - 1]!.messageId;

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
  const measuredRange = options.visibleRange ?? virtualizerVisibleRange(node);
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
  /** How much of a turn this transcript shows; `focused` leaves thinking out. */
  detail?: TranscriptDetail;
  liveStatus?: ReactNode;
  onCopyMessage?: (message: UiMessage) => void;
  onForkMessage?: (message: UiMessage) => void;
  onEditMessage?: (message: UiMessage) => void;
  /** Sends the prompt of a failed last answer again. */
  onRetryMessage?: (message: UiMessage) => void;
  onFocusComposer?: () => void;
  /** The reader heads for the start and is near it, or the rows do not fill the viewport; the caller loads older turns. */
  onReachStart?: () => void;
  /** Sits above the first loaded row and must take no height: the older turns' loading or error line. */
  history?: ReactNode;
}

export const TranscriptViewport = memo(function TranscriptViewport({
  messages,
  scrollRef,
  sessionId,
  turnStart,
  isStreaming,
  activities = [],
  detail,
  scope,
  scopeKey,
  revision,
  lookupRevision,
  liveStatus,
  onCopyMessage,
  onForkMessage,
  onEditMessage,
  onRetryMessage,
  onFocusComposer,
  onReachStart,
  history,
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
        ? visibleTranscriptTurnId(node, turnEntriesRef.current, {
            atStart: nearTranscriptStart(node),
            atTail: nearTranscriptTail(node),
          })
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

  useEffect(() => {
    const node = scrollRef.current;
    let previous = node?.scrollTop;
    const unsubscribe = navigation.subscribeScroll(() => {
      if (!node) return;
      const top = node.scrollTop;
      const towardStart = previous !== undefined && top < previous;
      previous = top;
      // Only the reader's own way up: a thread switch or the tail follow never loads a page.
      if (towardStart && !navigation.isFollowing() && top < node.clientHeight * HISTORY_REACH_VIEWPORTS) onReachStartRef.current?.();
    });
    if (!node) return unsubscribe;
    // At the very top, a wheel or a pull further up moves nothing, so no scroll event says so.
    let touchY: number | undefined;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && node.scrollTop <= 0) onReachStartRef.current?.();
    };
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY; };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y !== undefined && touchY !== undefined && y > touchY && node.scrollTop <= 0) onReachStartRef.current?.();
      touchY = y;
    };
    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("touchstart", onTouchStart, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      unsubscribe();
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
    };
  }, [navigation.isFollowing, navigation.subscribeScroll, scrollRef]);

  // Rows that do not fill the viewport give the reader nothing to scroll up with.
  const hasMessages = messages.length > 0;
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !hasMessages) return;
    const fill = () => {
      if (node.clientHeight > 0 && node.scrollHeight <= node.clientHeight) onReachStartRef.current?.();
    };
    fill();
    return navigation.subscribeResize(fill);
  }, [hasMessages, messages.length, navigation.subscribeResize, scrollRef, sessionId]);

  const [searchOpen, setSearchOpen] = useState(false);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (searchOpen) return;
    const node = scrollRef.current;
    if (!node) return;

    if (event.key === "/" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f")) {
      event.preventDefault();
      setSearchOpen(true);
      return;
    }

    if (event.key === "Escape" || event.key === "i" || (event.key === "Enter" && !event.shiftKey)) {
      event.preventDefault();
      onFocusComposer?.();
      return;
    }

    const scrollByAmount = (delta: number) => {
      if (typeof node.scrollBy === "function") {
        node.scrollBy({ top: delta, behavior: "smooth" });
      } else {
        node.scrollTop += delta;
      }
    };
    const scrollToAmount = (target: number) => {
      if (typeof node.scrollTo === "function") {
        node.scrollTo({ top: target, behavior: "smooth" });
      } else {
        node.scrollTop = target;
      }
    };

    if (event.key === "j" || (event.key === "ArrowDown" && !event.ctrlKey && !event.metaKey)) {
      event.preventDefault();
      scrollByAmount(60);
      return;
    }

    if (event.key === "k" || (event.key === "ArrowUp" && !event.ctrlKey && !event.metaKey)) {
      event.preventDefault();
      scrollByAmount(-60);
      return;
    }

    if (event.key === "PageDown" || (event.ctrlKey && event.key === "d") || (!event.ctrlKey && !event.metaKey && event.key === "d")) {
      event.preventDefault();
      scrollByAmount(node.clientHeight * 0.7);
      return;
    }

    if (event.key === "PageUp" || (event.ctrlKey && event.key === "u") || (!event.ctrlKey && !event.metaKey && event.key === "u")) {
      event.preventDefault();
      scrollByAmount(-node.clientHeight * 0.7);
      return;
    }

    if (event.key === "g" || event.key === "Home") {
      event.preventDefault();
      scrollToAmount(0);
      return;
    }

    if (event.key === "G" || event.key === "End") {
      event.preventDefault();
      scrollToAmount(node.scrollHeight);
      return;
    }

    if (event.key === "[") {
      event.preventDefault();
      if (turnEntries.length > 0) {
        const currentIndex = turnEntries.findIndex((e) => e.messageId === visibleTurnMessageId);
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : 0;
        selectTurn(turnEntries[prevIndex]!.messageId);
      }
      return;
    }

    if (event.key === "]") {
      event.preventDefault();
      if (turnEntries.length > 0) {
        const currentIndex = turnEntries.findIndex((e) => e.messageId === visibleTurnMessageId);
        const nextIndex = currentIndex !== -1 && currentIndex < turnEntries.length - 1 ? currentIndex + 1 : turnEntries.length - 1;
        selectTurn(turnEntries[nextIndex]!.messageId);
      }
      return;
    }

    if (event.key === "c" && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      if (lastAssistant && onCopyMessage) {
        onCopyMessage(lastAssistant);
      }
      return;
    }
  };

  return <div className={`transcript-viewport${showTurnNavigation ? " with-turn-navigation" : ""}`}>
    {showTurnNavigation ? (
      <TranscriptTurnNavigation
        entries={turnEntries}
        activeMessageId={visibleTurnMessageId}
        transcriptId={TRANSCRIPT_ID}
        onSelect={selectTurn}
      />
    ) : null}
    {searchOpen ? (
      <TranscriptSearch
        messages={messages}
        onJump={navigation.jumpToMessage}
        onClose={() => {
          setSearchOpen(false);
          scrollRef.current?.focus();
        }}
      />
    ) : null}
    <div
      className="transcript"
      ref={scrollRef}
      id={TRANSCRIPT_ID}
      tabIndex={0}
      role="log"
      aria-label="Thread transcript"
      onKeyDown={handleKeyDown}
    >
      <div className="transcript-inner">
        {history}
        <VirtualTranscript
          messages={messages}
          scrollRef={scrollRef}
          isStreaming={isStreaming}
          activities={activities}
          detail={detail}
          messageScopeKey={messageScopeKey}
          revision={revision}
          lookupRevision={lookupRevision}
          activeTurnStartId={currentTurnAnchor.sessionId === sessionId ? currentTurnAnchor.id : undefined}
          onCopyMessage={onCopyMessage}
          onForkMessage={onForkMessage}
          onEditMessage={onEditMessage}
          onRetryMessage={onRetryMessage}
          onFocusComposer={onFocusComposer}
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
