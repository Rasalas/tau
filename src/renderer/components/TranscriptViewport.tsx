import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import type { UiMessage } from "../../shared/contracts";
import type { TranscriptActivity } from "./transcript-activity";
import { VirtualTranscript } from "./VirtualTranscript";

/** The logical send that owns an anchored, streaming turn. */
export interface TranscriptTurnStart {
  /** Stable ID for the logical send, independent of any persisted message ID. */
  turnId: string;
  sessionId?: string;
  messageId?: string;
  text?: string;
  timestamp?: number;
  awaitingMessage?: boolean;
  preserveAcrossSessionChange?: boolean;
}

export interface TranscriptViewportProps {
  messages: UiMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  sessionId?: string;
  turnStart?: TranscriptTurnStart;
  isStreaming: boolean;
  activities?: readonly TranscriptActivity[];
  liveStatus?: ReactNode;
  onCopyMessage?: (message: UiMessage) => void;
  onForkMessage?: (message: UiMessage) => void;
  onReachStart?: () => void;
}

type ScrollIntent = "older" | "newer";

interface TranscriptNavigationState {
  sessionId?: string;
  turnId?: string;
  anchorId?: string;
  anchorPending: boolean;
  anchorLocked: boolean;
  anchorSuppressed: boolean;
  following: boolean;
  scrollIntent?: ScrollIntent;
  lastTouchY?: number;
  lastScrollTop?: number;
  touchActive: boolean;
  pointerDown: boolean;
}

interface TranscriptNavigationOptions {
  sessionId?: string;
  turnStart?: TranscriptTurnStart;
  messages: UiMessage[];
  onAnchorChange(id?: string): void;
}

function resolveTurnMessage(
  messages: UiMessage[],
  turnStart?: TranscriptTurnStart,
): UiMessage | undefined {
  if (!turnStart) return undefined;
  if (turnStart.messageId) {
    const byId = messages.find((message) => message.id === turnStart.messageId);
    if (byId) return byId;
  }
  if (turnStart.text !== undefined) {
    const matching = [...messages].reverse().find((message) => (
      message.role === "user"
      && message.text === turnStart.text
      && (turnStart.timestamp === undefined
        || Math.abs(message.timestamp - turnStart.timestamp) <= 30_000)
    ));
    if (matching) return matching;
    if (turnStart.awaitingMessage) return undefined;
    // Persisted entries can use a different clock or test fixture epoch. The
    // logical turn ID is authoritative, so an exact text match is a safe
    // fallback when no ID survived reconciliation.
    return [...messages].reverse().find((message) => message.role === "user" && message.text === turnStart.text);
  }
  return undefined;
}

function resetNavigation(
  state: TranscriptNavigationState,
  options: TranscriptNavigationOptions,
): void {
  state.sessionId = options.sessionId;
  state.turnId = options.turnStart?.turnId;
  const target = resolveTurnMessage(options.messages, options.turnStart);
  state.anchorPending = Boolean(options.turnStart);
  state.anchorLocked = false;
  state.anchorSuppressed = false;
  state.following = true;
  state.scrollIntent = undefined;
  state.lastTouchY = undefined;
  state.lastScrollTop = undefined;
  state.touchActive = false;
  state.pointerDown = false;
  setAnchor(state, target?.id, options.onAnchorChange);
}

function setAnchor(
  state: TranscriptNavigationState,
  id: string | undefined,
  onAnchorChange: (id?: string) => void,
): void {
  state.anchorId = id;
  onAnchorChange(id);
}

function startTurn(
  state: TranscriptNavigationState,
  options: TranscriptNavigationOptions,
): void {
  state.turnId = options.turnStart?.turnId;
  state.anchorPending = Boolean(options.turnStart);
  state.anchorLocked = false;
  state.anchorSuppressed = false;
  state.following = true;
  state.scrollIntent = undefined;
  setAnchor(
    state,
    resolveTurnMessage(options.messages, options.turnStart)?.id,
    options.onAnchorChange,
  );
}

function followTail(
  state: TranscriptNavigationState,
  onAnchorChange: (id?: string) => void,
): void {
  state.following = true;
  state.anchorPending = false;
  state.anchorLocked = false;
  state.anchorSuppressed = true;
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
  state.anchorSuppressed = true;
  state.scrollIntent = undefined;
  setAnchor(state, undefined, onAnchorChange);
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
    const target = resolveTurnMessage(options.messages, options.turnStart);
    navigationRef.current = {
      sessionId: options.sessionId,
      turnId: options.turnStart?.turnId,
      anchorId: target?.id,
      anchorPending: Boolean(options.turnStart),
      anchorLocked: false,
      anchorSuppressed: false,
      following: true,
      touchActive: false,
      pointerDown: false,
    };
  }
  const [canJumpToLatest, setCanJumpToLatest] = useState(false);
  const frameRef = useRef<number | undefined>(undefined);
  const scheduleRef = useRef<() => void>(() => {});
  const messagesRef = useRef(options.messages);
  messagesRef.current = options.messages;
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
      // The virtualizer may not have mounted an anchor that is far outside
      // the current window yet. Seek to its estimated position first; the
      // resulting scroll event mounts that window and the next frame can use
      // the measured row. The estimate is derived from the real virtualizer
      // height, so it never creates a synthetic spacer for a short transcript.
      const anchorIndex = navigationRef.current!.anchorId
        ? messagesRef.current.findIndex((message) => message.id === navigationRef.current!.anchorId)
        : -1;
      const estimatedRowHeight = messagesRef.current.length > 0
        ? node.scrollHeight / messagesRef.current.length
        : 0;
      if (anchorIndex >= 0 && estimatedRowHeight > 0) {
        const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
        node.scrollTop = Math.min(maxScrollTop, Math.max(0, anchorIndex * estimatedRowHeight - paddingTop(node)));
      } else {
        placeAtTail(node);
      }
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
      const continuingTurn = Boolean(
        options.turnStart?.turnId
        && navigation.turnId === options.turnStart.turnId
        && options.turnStart.sessionId === options.sessionId
        && options.turnStart.preserveAcrossSessionChange === true
        && !navigation.anchorSuppressed,
      );
      if (continuingTurn) {
        // A draft session becomes real after its first send. Keep the same
        // logical turn and its navigation mode while only changing the scope.
        navigation.sessionId = options.sessionId;
        navigation.anchorPending = true;
        navigation.anchorLocked = false;
        setAnchor(
          navigation,
          resolveTurnMessage(options.messages, options.turnStart)?.id,
          onAnchorChangeRef.current,
        );
      } else {
        // A normal thread/workspace switch is a new transcript, regardless of
        // whether the new thread happens to contain a similarly named prompt.
        resetNavigation(navigation, { ...options, turnStart: undefined });
      }
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
      // A seek performed by placeAnchor changes the virtualizer's window. Ask
      // for one precise placement after that window has mounted, while any
      // genuine upward intent above has already disabled following.
      if (navigation.following && navigation.anchorPending && navigation.anchorId) scheduleTail();
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
  }, [options.sessionId, options.turnStart?.turnId, options.turnStart?.sessionId, ref]);

  useEffect(() => {
    const navigation = navigationRef.current!;
    if (navigation.sessionId !== options.sessionId) return;
    const turnStart = options.turnStart;
    if (!turnStart) {
      if (navigation.turnId !== undefined) {
        // Clearing the send signal (for example after a failed send or a
        // workspace switch) also clears its visual marker when the session ID
        // itself did not change.
        followTail(navigation, onAnchorChangeRef.current);
        navigation.turnId = undefined;
        scheduleRef.current();
      }
      return;
    }

    if (
      turnStart.sessionId !== undefined
      && turnStart.sessionId !== options.sessionId
      && !(navigation.turnId === turnStart.turnId && turnStart.preserveAcrossSessionChange === true)
    ) return;

    if (navigation.turnId !== turnStart.turnId) {
      startTurn(navigation, options);
      scheduleRef.current();
      return;
    }

    // The optimistic ID may be replaced by Pi's authoritative ID. Resolve the
    // same logical turn, but never revive following after the user navigated up.
    if (!navigation.following || navigation.anchorSuppressed) return;
    const target = resolveTurnMessage(options.messages, turnStart);
    if (target && navigation.anchorId !== target.id) {
      navigation.anchorPending = true;
      navigation.anchorLocked = false;
      setAnchor(navigation, target.id, onAnchorChangeRef.current);
    }
    scheduleRef.current();
  }, [
    options.turnStart?.turnId,
    options.turnStart?.sessionId,
    options.turnStart?.messageId,
    options.turnStart?.text,
    options.turnStart?.timestamp,
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

export function TranscriptViewport({
  messages,
  scrollRef,
  sessionId,
  turnStart,
  isStreaming,
  activities = [],
  liveStatus,
  onCopyMessage,
  onForkMessage,
  onReachStart,
}: TranscriptViewportProps) {
  const [currentTurnAnchor, setCurrentTurnAnchor] = useState<{ sessionId?: string; id?: string }>(
    () => ({ sessionId, id: resolveTurnMessage(messages, turnStart)?.id }),
  );
  const reportCurrentTurnAnchor = useCallback((id?: string) => {
    setCurrentTurnAnchor((current) => current.sessionId === sessionId && current.id === id
      ? current
      : { sessionId, id });
  }, [sessionId]);
  const navigation = useTranscriptNavigation(
    scrollRef,
    [messages, activities, liveStatus, turnStart],
    {
      sessionId,
      turnStart,
      messages,
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
}
