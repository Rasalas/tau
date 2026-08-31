import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import type { UiMessage } from "../../shared/contracts";
import { Message } from "./Message";
import { VirtualTranscript } from "./VirtualTranscript";

export interface TranscriptActivity {
  id: string;
  afterMessageId?: string;
  content: ReactNode;
}

export interface TranscriptViewportProps {
  messages: UiMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  sessionId?: string;
  latestUserMessage?: UiMessage;
  initialTurnIsNew?: boolean;
  isStreaming: boolean;
  activity?: ReactNode;
  activityAfterMessageId?: string;
  activities?: TranscriptActivity[];
  liveStatus?: ReactNode;
  onCopyMessage?: (message: UiMessage) => void;
  onForkMessage?: (message: UiMessage) => void;
  onReachStart?: () => void;
}

interface TurnIdentity {
  id: string;
  text: string;
  timestamp: number;
}

type ScrollIntent = "older" | "newer";

interface TranscriptNavigationState {
  sessionId?: string;
  requestedTurn?: TurnIdentity;
  anchorId?: string;
  anchorPending: boolean;
  anchorLocked: boolean;
  following: boolean;
  scrollIntent?: ScrollIntent;
  lastTouchY?: number;
  lastScrollTop?: number;
  touchActive: boolean;
  pointerDown: boolean;
}

interface TranscriptNavigationOptions {
  sessionId?: string;
  latestUserMessage?: UiMessage;
  messages: UiMessage[];
  initialTurnIsNew: boolean;
  onAnchorChange(id?: string): void;
}

function turnIdentity(message?: UiMessage): TurnIdentity | undefined {
  return message
    ? { id: message.id, text: message.text, timestamp: message.timestamp }
    : undefined;
}

function sameTurn(previous: TurnIdentity | undefined, next: TurnIdentity | undefined): boolean {
  return Boolean(
    previous
    && next
    && previous.id !== next.id
    && previous.text === next.text
    && Math.abs(previous.timestamp - next.timestamp) <= 30_000,
  );
}

function resetNavigation(
  state: TranscriptNavigationState,
  options: TranscriptNavigationOptions,
): void {
  state.sessionId = options.sessionId;
  state.requestedTurn = turnIdentity(options.latestUserMessage);
  state.anchorPending = Boolean(options.initialTurnIsNew && options.latestUserMessage);
  state.anchorLocked = false;
  state.following = true;
  state.scrollIntent = undefined;
  state.lastTouchY = undefined;
  state.lastScrollTop = undefined;
  state.touchActive = false;
  state.pointerDown = false;
  setAnchor(state, options.initialTurnIsNew ? options.latestUserMessage?.id : undefined, options.onAnchorChange);
}

function setAnchor(
  state: TranscriptNavigationState,
  id: string | undefined,
  onAnchorChange: (id?: string) => void,
): void {
  state.anchorId = id;
  onAnchorChange(id);
}

function followLatest(
  state: TranscriptNavigationState,
  latestUserMessage: UiMessage | undefined,
  onAnchorChange: (id?: string) => void,
): void {
  state.following = true;
  state.anchorPending = Boolean(latestUserMessage);
  state.anchorLocked = false;
  state.scrollIntent = undefined;
  setAnchor(state, latestUserMessage?.id, onAnchorChange);
}

function followTail(
  state: TranscriptNavigationState,
  onAnchorChange: (id?: string) => void,
): void {
  state.following = true;
  state.anchorPending = false;
  state.anchorLocked = false;
  state.scrollIntent = undefined;
  setAnchor(state, undefined, onAnchorChange);
}

function stopFollowing(
  state: TranscriptNavigationState,
  onAnchorChange: (id?: string) => void,
): void {
  state.following = false;
  state.anchorPending = false;
  state.anchorLocked = false;
  state.scrollIntent = undefined;
  setAnchor(state, undefined, onAnchorChange);
}

function latestUser(messages: UiMessage[]): UiMessage | undefined {
  return [...messages].reverse().find((message) => message.role === "user");
}

/**
 * Owns the high-frequency transcript interaction state. The parent only
 * receives real page-load callbacks; wheel, touch, and ordinary scroll events
 * rerender this component instead of the workbench root.
 */
export function useTranscriptNavigation(
  ref: RefObject<HTMLDivElement | null>,
  updates: readonly unknown[],
  options: TranscriptNavigationOptions,
): {
  canJumpToLatest: boolean;
  jumpToLatest: () => void;
} {
  const navigationRef = useRef<TranscriptNavigationState | undefined>(undefined);
  if (!navigationRef.current) {
    navigationRef.current = {
      sessionId: options.sessionId,
      requestedTurn: turnIdentity(options.latestUserMessage),
      anchorId: options.initialTurnIsNew ? options.latestUserMessage?.id : undefined,
      anchorPending: Boolean(options.initialTurnIsNew && options.latestUserMessage),
      anchorLocked: false,
      following: true,
      touchActive: false,
      pointerDown: false,
    };
  }
  const [canJumpToLatest, setCanJumpToLatest] = useState(false);
  const frameRef = useRef<number | undefined>(undefined);
  const scheduleRef = useRef<() => void>(() => {});
  const onAnchorChangeRef = useRef(options.onAnchorChange);
  onAnchorChangeRef.current = options.onAnchorChange;

  const scrollMetrics = (node: HTMLDivElement) => ({
    maxScrollTop: Math.max(0, node.scrollHeight - node.clientHeight),
    hasOverflow: node.scrollHeight > node.clientHeight + 1,
  });

  const updateJumpAvailability = (node: HTMLDivElement) => {
    const { hasOverflow } = scrollMetrics(node);
    const canJump = !navigationRef.current!.following && hasOverflow;
    setCanJumpToLatest((current) => current === canJump ? current : canJump);
  };

  const placeAtTail = (node: HTMLDivElement) => {
    // The browser clamps scrollHeight to the real maximum; the explicit value
    // also keeps the preview fixture deterministic.
    node.scrollTop = node.scrollHeight;
  };

  const findAnchor = (node: HTMLDivElement): HTMLElement | undefined => {
    const id = navigationRef.current!.anchorId;
    if (!id) return undefined;
    return [...node.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((element) => element.dataset.messageId === id);
  };

  const paddingTop = (node: HTMLDivElement): number => {
    const value = Number.parseFloat(window.getComputedStyle(node).paddingTop);
    return Number.isFinite(value) ? value : 0;
  };

  const contentTop = (node: HTMLDivElement, element: HTMLElement): number => {
    const nodeRect = node.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    // Real layout has useful rects, including the virtual row's transform. The
    // offset fallback keeps the transition deterministic before first paint.
    if (elementRect.height > 0 || elementRect.top !== 0 || nodeRect.top !== 0) {
      return node.scrollTop + elementRect.top - nodeRect.top;
    }
    let top = 0;
    let current: HTMLElement | null = element;
    while (current && current !== node) {
      top += current.offsetTop;
      current = current.offsetParent as HTMLElement | null;
    }
    return top;
  };

  const viewportTop = (node: HTMLDivElement, element: HTMLElement): number | undefined => {
    const nodeRect = node.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    if (elementRect.height > 0 || elementRect.top !== 0 || nodeRect.top !== 0) {
      return elementRect.top - nodeRect.top;
    }
    return undefined;
  };

  const placeAnchor = (node: HTMLDivElement): boolean => {
    const anchor = findAnchor(node);
    if (!anchor) {
      placeAtTail(node);
      return false;
    }
    const rawTarget = contentTop(node, anchor) - paddingTop(node);
    const target = Math.max(0, rawTarget);
    const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    if (target > maxScrollTop) {
      // There is not enough content below the prompt yet. Keep the natural
      // tail; this deliberately does not manufacture a spacer.
      node.scrollTop = maxScrollTop;
      return false;
    }
    node.scrollTop = target;
    navigationRef.current!.anchorLocked = true;
    return true;
  };

  const preserveAnchor = (node: HTMLDivElement) => {
    const anchor = findAnchor(node);
    if (!anchor) return;
    const currentTop = viewportTop(node, anchor);
    if (currentTop === undefined) return;
    const desiredTop = paddingTop(node);
    const delta = currentTop - desiredTop;
    if (Math.abs(delta) < 0.5) return;
    const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    node.scrollTop = Math.max(0, Math.min(maxScrollTop, node.scrollTop + delta));
  };

  const scheduleTail = () => {
    const navigation = navigationRef.current!;
    if (!navigation.following || frameRef.current !== undefined) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined;
      const node = ref.current;
      if (!node || !navigationRef.current!.following) return;
      const navigation = navigationRef.current!;
      if (navigation.anchorPending) {
        if (placeAnchor(node)) navigation.anchorPending = false;
      } else if (navigation.anchorLocked) {
        preserveAnchor(node);
      } else {
        placeAtTail(node);
      }
      updateJumpAvailability(node);
    });
  };
  scheduleRef.current = scheduleTail;

  const jumpToLatest = useCallback(() => {
    const node = ref.current;
    const navigation = navigationRef.current!;
    if (!node) return;
    followTail(navigation, onAnchorChangeRef.current);
    setCanJumpToLatest(false);
    if (typeof node.scrollTo === "function") {
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
      if (frameRef.current === undefined) {
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = undefined;
          const current = ref.current;
          if (current && navigationRef.current!.following) {
            current.scrollTo({ top: current.scrollHeight, behavior: "smooth" });
          }
        });
      }
    } else {
      placeAtTail(node);
      scheduleRef.current();
    }
  }, [ref]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const navigation = navigationRef.current!;
    if (navigation.sessionId !== options.sessionId) {
      resetNavigation(navigation, options);
      setCanJumpToLatest(false);
    }
    navigation.lastScrollTop = node.scrollTop;
    let intentTimer: number | undefined;
    const nearTail = () => node.scrollHeight - node.scrollTop - node.clientHeight < 32;
    const clearScrollIntent = () => {
      if (intentTimer !== undefined) window.clearTimeout(intentTimer);
      navigation.scrollIntent = undefined;
      intentTimer = undefined;
    };
    const armScrollIntent = (intent: ScrollIntent) => {
      clearScrollIntent();
      navigation.scrollIntent = intent;
      intentTimer = window.setTimeout(() => {
        intentTimer = undefined;
        if (navigation.scrollIntent === intent) navigation.scrollIntent = undefined;
      }, 120);
    };
    const onScroll = () => {
      const previous = navigation.lastScrollTop;
      const next = node.scrollTop;
      navigation.lastScrollTop = next;
      const direction = previous === undefined || next === previous
        ? undefined
        : next < previous ? "older" : "newer";
      const userIntent = navigation.pointerDown || navigation.touchActive || navigation.scrollIntent !== undefined;
      const olderIntent = navigation.scrollIntent === "older" || direction === "older";
      const newerIntent = navigation.scrollIntent === "newer" || direction === "newer";
      if (userIntent && olderIntent) {
        stopFollowing(navigation, onAnchorChangeRef.current);
      } else if (userIntent && nearTail() && newerIntent && !olderIntent) {
        followTail(navigation, onAnchorChangeRef.current);
        scheduleTail();
      }
      if (intentTimer !== undefined || navigation.scrollIntent !== undefined) clearScrollIntent();
      updateJumpAvailability(node);
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        stopFollowing(navigation, onAnchorChangeRef.current);
        armScrollIntent("older");
        updateJumpAvailability(node);
      } else if (event.deltaY > 0) {
        armScrollIntent("newer");
      }
    };
    const onPointerDown = () => { navigation.pointerDown = true; };
    const onPointerUp = () => { navigation.pointerDown = false; };
    const onTouchStart = (event: TouchEvent) => {
      navigation.touchActive = true;
      navigation.lastTouchY = event.touches[0]?.clientY;
      navigation.lastScrollTop = node.scrollTop;
    };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      const previousY = navigation.lastTouchY;
      const direction = previousY === undefined || nextY === undefined
        ? undefined
        : nextY > previousY ? "older" : nextY < previousY ? "newer" : undefined;
      if (direction === "older") {
        stopFollowing(navigation, onAnchorChangeRef.current);
        armScrollIntent("older");
      } else if (direction) {
        armScrollIntent(direction);
      }
      navigation.lastTouchY = nextY;
      onScroll();
    };
    const onTouchEnd = () => {
      navigation.touchActive = false;
      navigation.lastTouchY = undefined;
      clearScrollIntent();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
        stopFollowing(navigation, onAnchorChangeRef.current);
      } else if (["ArrowDown", "PageDown"].includes(event.key)) {
        armScrollIntent("newer");
      } else if (event.key === "End") {
        followTail(navigation, onAnchorChangeRef.current);
        scheduleTail();
      }
      updateJumpAvailability(node);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("pointercancel", onPointerUp, { passive: true });
    node.addEventListener("touchstart", onTouchStart, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: true });
    node.addEventListener("touchend", onTouchEnd, { passive: true });
    node.addEventListener("touchcancel", onTouchEnd, { passive: true });
    node.addEventListener("keydown", onKeyDown);
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => scheduleTail());
    observer?.observe(node);
    const content = node.firstElementChild ?? node;
    observer?.observe(content);
    scheduleTail();
    return () => {
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("touchend", onTouchEnd);
      node.removeEventListener("touchcancel", onTouchEnd);
      node.removeEventListener("keydown", onKeyDown);
      observer?.disconnect();
      clearScrollIntent();
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
    };
  }, [options.sessionId, ref]);

  useEffect(() => {
    const navigation = navigationRef.current!;
    const next = turnIdentity(options.latestUserMessage);
    if (navigation.sessionId !== options.sessionId) return;
    const previous = navigation.requestedTurn;
    if (previous?.id === next?.id) return;
    navigation.requestedTurn = next;
    if (!next) {
      followTail(navigation, onAnchorChangeRef.current);
      scheduleRef.current();
      return;
    }
    // Pi replaces an optimistic local id with its persisted entry id. That is
    // one turn, so preserve an intentional history position and only retarget
    // the pinned row when it was still active.
    const replacement = sameTurn(previous, next)
      && !options.messages.some((message) => message.id === previous?.id);
    if (replacement) {
      if (navigation.anchorId === previous?.id) setAnchor(navigation, next.id, onAnchorChangeRef.current);
      scheduleRef.current();
      return;
    }
    followLatest(navigation, options.latestUserMessage, onAnchorChangeRef.current);
    scheduleRef.current();
  }, [
    options.latestUserMessage?.id,
    options.latestUserMessage?.text,
    options.latestUserMessage?.timestamp,
    options.messages,
    options.sessionId,
  ]);

  useEffect(() => {
    const node = ref.current;
    if (node) updateJumpAvailability(node);
    scheduleRef.current();
  // The array identity is intentionally controlled by the caller's visible records.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, updates);

  return { canJumpToLatest, jumpToLatest };
}

function activitiesForMessages(
  messages: UiMessage[],
  activities: TranscriptActivity[],
  activity?: ReactNode,
  activityAfterMessageId?: string,
): Map<string, TranscriptActivity[]> {
  const messageIds = new Set(messages.map((message) => message.id));
  const tailMessageId = messages.at(-1)?.id;
  const allActivities = [
    ...activities,
    ...(activity ? [{
      id: "turn-activity",
      afterMessageId: activityAfterMessageId,
      content: activity,
    }] : []),
  ];
  const result = new Map<string, TranscriptActivity[]>();
  for (const entry of allActivities) {
    const anchor = entry.afterMessageId
      ? (messageIds.has(entry.afterMessageId)
        ? entry.afterMessageId
        : entry.id === "turn-activity" ? tailMessageId : undefined)
      : tailMessageId;
    if (!anchor) continue;
    const anchored = result.get(anchor) ?? [];
    anchored.push(entry);
    result.set(anchor, anchored);
  }
  return result;
}

function CurrentTurn({
  messages,
  isStreaming,
  activities,
  activity,
  activityAfterMessageId,
  liveStatus,
  onCopyMessage,
  onForkMessage,
}: {
  messages: UiMessage[];
  isStreaming: boolean;
  activities: TranscriptActivity[];
  activity?: ReactNode;
  activityAfterMessageId?: string;
  liveStatus?: ReactNode;
  onCopyMessage?: (message: UiMessage) => void;
  onForkMessage?: (message: UiMessage) => void;
}) {
  const activitiesByMessage = activitiesForMessages(messages, activities, activity, activityAfterMessageId);
  return <div className="transcript-current-turn">
    {messages.map((message, index) => (
      <div className="transcript-current-row virtual-transcript-row" key={message.id} data-message-id={message.id}>
        <Message
          message={message}
          streaming={Boolean(isStreaming && message === messages.at(-1) && message.role === "assistant")}
          onCopy={onCopyMessage}
          onFork={onForkMessage}
        />
        {(activitiesByMessage.get(message.id) ?? []).map((entry) => (
          <div className="inline-transcript-activity" key={entry.id}>{entry.content}</div>
        ))}
        {index === messages.length - 1 ? liveStatus : null}
      </div>
    ))}
    {messages.length === 0 ? liveStatus : null}
  </div>;
}

// The active turn remains in the real scroll flow after virtualized history.
// That lets the anchor reach the usable top as content arrives without adding
// a synthetic spacer, while a locked anchor keeps the prompt stable as its
// answer grows.
export function TranscriptViewport({
  messages,
  scrollRef,
  sessionId,
  latestUserMessage,
  initialTurnIsNew = false,
  isStreaming,
  activity,
  activityAfterMessageId,
  activities = [],
  liveStatus,
  onCopyMessage,
  onForkMessage,
  onReachStart,
}: TranscriptViewportProps) {
  const [currentTurnAnchor, setCurrentTurnAnchor] = useState<{ sessionId?: string; id?: string }>(
    () => ({ sessionId, id: initialTurnIsNew ? latestUserMessage?.id : undefined }),
  );
  const reportCurrentTurnAnchor = useCallback((id?: string) => {
    setCurrentTurnAnchor((current) => current.sessionId === sessionId && current.id === id
      ? current
      : { sessionId, id });
  }, [sessionId]);
  const navigation = useTranscriptNavigation(
    scrollRef,
    [messages, activities, activity, liveStatus],
    {
      sessionId,
      latestUserMessage,
      messages,
      initialTurnIsNew,
      onAnchorChange: reportCurrentTurnAnchor,
    },
  );
  const currentTurnAnchorId = currentTurnAnchor.sessionId === sessionId ? currentTurnAnchor.id : undefined;
  const anchorIndex = currentTurnAnchorId
    ? messages.findIndex((message) => message.id === currentTurnAnchorId)
    : -1;
  const currentMessages = anchorIndex >= 0 ? messages.slice(anchorIndex) : [];
  const historyMessages = anchorIndex >= 0 ? messages.slice(0, anchorIndex) : messages;
  const currentMessageIds = new Set(currentMessages.map((message) => message.id));
  const currentActivities = activities.filter((entry) => currentMessageIds.has(entry.afterMessageId ?? ""));
  const historyActivities = activities.filter((entry) => !currentMessageIds.has(entry.afterMessageId ?? ""));
  const activityIsCurrent = anchorIndex >= 0
    && (!activityAfterMessageId || currentMessageIds.has(activityAfterMessageId));
  const currentActivity = activityIsCurrent ? activity : undefined;
  const currentActivityAnchor = activityIsCurrent ? activityAfterMessageId : undefined;
  const historyActivity = activityIsCurrent ? undefined : activity;
  const historyActivityAnchor = activityIsCurrent ? undefined : activityAfterMessageId;
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
          messages={historyMessages}
          scrollRef={scrollRef}
          isStreaming={Boolean(isStreaming && anchorIndex < 0)}
          activity={historyActivity}
          activityAfterMessageId={historyActivityAnchor}
          activities={historyActivities}
          onCopyMessage={onCopyMessage}
          onForkMessage={onForkMessage}
        />
        {anchorIndex >= 0 ? (
          <CurrentTurn
            messages={currentMessages}
            isStreaming={isStreaming}
            activities={currentActivities}
            activity={currentActivity}
            activityAfterMessageId={currentActivityAnchor}
            liveStatus={liveStatus}
            onCopyMessage={onCopyMessage}
            onForkMessage={onForkMessage}
          />
        ) : liveStatus}
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
}

export function latestTranscriptUser(messages: UiMessage[]): UiMessage | undefined {
  return latestUser(messages);
}
