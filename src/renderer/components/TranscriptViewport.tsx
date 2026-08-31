import { memo, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import type { UiMessage } from "../../shared/contracts";
import type { TranscriptActivity } from "./transcript-activity";
import { VirtualTranscript } from "./VirtualTranscript";

/** The logical send that owns an anchored, streaming turn. */
export type TranscriptNavigationScope =
  | { kind: "session"; projectPath?: string; sessionId: string }
  | { kind: "draft"; projectPath: string; draftId: string };

export interface TranscriptTurnStart {
  /** Stable ID for the logical send, independent of any persisted message ID. */
  turnId: string;
  /** Discriminated semantic scope; draft IDs are never represented as sessions. */
  scope?: TranscriptNavigationScope;
  sessionId?: string;
  messageId?: string;
  /** Stable client ID used when Pi expands the submitted text. */
  clientMessageId?: string;
  text?: string;
  timestamp?: number;
  awaitingMessage?: boolean;
  preserveAcrossSessionChange?: boolean;
  /** App-owned semantic transcript scope; navigation ignores stale scopes. */
  scopeKey?: string;
}

export interface TranscriptViewportProps {
  messages: UiMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  sessionId?: string;
  /** Semantic project/thread/draft scope used to invalidate navigation state. */
  scopeKey?: string;
  scope?: TranscriptNavigationScope;
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
  scopeKey?: string;
  scope?: TranscriptNavigationScope;
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
  scopeKey?: string;
  scope?: TranscriptNavigationScope;
  turnStart?: TranscriptTurnStart;
  messages: UiMessage[];
  lookup?: TranscriptMessageLookup;
  onAnchorChange(id?: string): void;
}

interface TranscriptMessageLookup {
  byId: ReadonlyMap<string, UiMessage>;
  byClientIdentity: ReadonlyMap<string, UiMessage>;
  byText: ReadonlyMap<string, readonly UiMessage[]>;
  positions: ReadonlyMap<string, number>;
}

function clientIdentityKey(turnId: string, messageId: string): string {
  return `${turnId}\u0000${messageId}`;
}

function hasExplicitIdentity(message: UiMessage): boolean {
  return message.clientTurnId !== undefined || message.clientMessageId !== undefined;
}

function matchesClientIdentity(message: UiMessage, turnStart: TranscriptTurnStart): boolean {
  return message.role === "user"
    && message.clientTurnId === turnStart.turnId
    && message.clientMessageId !== undefined
    && turnStart.clientMessageId !== undefined
    && message.clientMessageId === turnStart.clientMessageId;
}

function resolveTurnMessage(
  messages: readonly UiMessage[],
  turnStart?: TranscriptTurnStart,
  lookup?: TranscriptMessageLookup,
): UiMessage | undefined {
  if (!turnStart) return undefined;
  if (turnStart.clientMessageId) {
    const byClientIdentity = lookup?.byClientIdentity.get(clientIdentityKey(turnStart.turnId, turnStart.clientMessageId))
      ?? messages.find((message) => message.role === "user"
        && message.clientTurnId === turnStart.turnId
        && message.clientMessageId === turnStart.clientMessageId);
    if (byClientIdentity) return byClientIdentity;
  }
  if (turnStart.messageId) {
    const byId = lookup?.byId.get(turnStart.messageId)
      ?? messages.find((message) => message.id === turnStart.messageId);
    // An authoritative explicit identity is never demoted to a legacy ID or
    // text match. This prevents an out-of-order message from stealing the
    // optimistic anchor.
    if (byId && (!hasExplicitIdentity(byId) || matchesClientIdentity(byId, turnStart))) return byId;
  }
  if (turnStart.text !== undefined) {
    const candidates = lookup?.byText.get(turnStart.text);
    const matching = (candidates ? [...candidates].reverse() : [...messages].reverse()).find((message) => (
      message.role === "user"
      && !hasExplicitIdentity(message)
      && message.text === turnStart.text
      && (turnStart.timestamp === undefined
        || Math.abs(message.timestamp - turnStart.timestamp) <= 30_000)
    ));
    if (matching) return matching;
    if (turnStart.awaitingMessage) return undefined;
    // Persisted entries can use a different clock or test fixture epoch. The
    // logical turn ID is authoritative, so an exact text match is a safe
    // fallback when no ID survived reconciliation.
    return (candidates ? [...candidates].reverse() : [...messages].reverse())
      .find((message) => message.role === "user" && !hasExplicitIdentity(message) && message.text === turnStart.text);
  }
  return undefined;
}

function resetNavigation(
  state: TranscriptNavigationState,
  options: TranscriptNavigationOptions,
): void {
  state.sessionId = options.sessionId;
  state.scopeKey = options.scopeKey;
  state.scope = options.scope;
  state.turnId = options.turnStart?.turnId;
  const target = resolveTurnMessage(options.messages, options.turnStart, options.lookup);
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
  state.scopeKey = options.scopeKey;
  state.scope = options.turnStart?.scope;
  state.anchorPending = Boolean(options.turnStart);
  state.anchorLocked = false;
  state.anchorSuppressed = false;
  state.following = true;
  state.scrollIntent = undefined;
  setAnchor(
    state,
    resolveTurnMessage(options.messages, options.turnStart, options.lookup)?.id,
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
    const target = resolveTurnMessage(options.messages, options.turnStart, options.lookup);
    navigationRef.current = {
      sessionId: options.sessionId,
      scopeKey: options.scopeKey,
      scope: options.turnStart?.scope,
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
  const lookupRef = useRef(options.lookup);
  lookupRef.current = options.lookup;
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
        ? lookupRef.current?.positions.get(navigationRef.current!.anchorId) ?? messagesRef.current.findIndex((message) => message.id === navigationRef.current!.anchorId)
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
    if (navigation.sessionId !== options.sessionId || navigation.scopeKey !== options.scopeKey) {
      const continuingTurn = Boolean(
        options.turnStart?.turnId
        && navigation.turnId === options.turnStart.turnId
        && options.turnStart.preserveAcrossSessionChange === true
        // A draft may cross into exactly the session reported by the send
        // path. A stale draft signal must not survive a quick switch to some
        // unrelated session merely because it still has a draft scope.
        && options.turnStart.sessionId === options.sessionId
        && !navigation.anchorSuppressed,
      );
      if (continuingTurn) {
        // A draft session becomes real after its first send. Keep the same
        // logical turn and its navigation mode while only changing the scope.
        navigation.sessionId = options.sessionId;
        navigation.scopeKey = options.scopeKey;
        navigation.scope = options.turnStart?.scope;
        navigation.anchorPending = true;
        navigation.anchorLocked = false;
        setAnchor(
          navigation,
          resolveTurnMessage(options.messages, options.turnStart, options.lookup)?.id,
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
    let intentGeneration = 0;
    const nearTail = () => node.scrollHeight - node.scrollTop - node.clientHeight < 32;
    const clearScrollIntent = () => {
      if (intentTimer !== undefined) window.clearTimeout(intentTimer);
      navigation.scrollIntent = undefined;
      intentTimer = undefined;
      intentGeneration += 1;
    };
    const armScrollIntent = (intent: ScrollIntent) => {
      clearScrollIntent();
      const generation = intentGeneration;
      navigation.scrollIntent = intent;
      intentTimer = window.setTimeout(() => {
        intentTimer = undefined;
        if (intentGeneration === generation && navigation.scrollIntent === intent) navigation.scrollIntent = undefined;
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
      // A direction observed in the actual scroll event outranks a stale wheel
      // hint. This prevents a delayed downward timer from reviving following
      // after the user has already moved upward.
      const olderIntent = direction === "older"
        || (direction === undefined && navigation.scrollIntent === "older");
      const newerIntent = direction === "newer"
        || (direction === undefined && navigation.scrollIntent === "newer");
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
    const onWindowKeyDown = (event: KeyboardEvent) => {
      // Composer and window focus still count as an intentional navigation
      // choice. Do not cancel the browser's default textarea behavior here.
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
        stopFollowing(navigation, onAnchorChangeRef.current);
        updateJumpAvailability(node);
      } else if (["ArrowDown", "PageDown"].includes(event.key)) {
        armScrollIntent("newer");
        updateJumpAvailability(node);
      } else if (event.key === "End") {
        followTail(navigation, onAnchorChangeRef.current);
        scheduleTail();
        updateJumpAvailability(node);
      }
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
    window.addEventListener("keydown", onWindowKeyDown);
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
      window.removeEventListener("keydown", onWindowKeyDown);
      observer?.disconnect();
      clearScrollIntent();
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
    };
  }, [options.scopeKey, options.sessionId, options.scope, options.turnStart?.turnId, options.turnStart?.sessionId, ref]);

  useEffect(() => {
    const navigation = navigationRef.current!;
    if (navigation.sessionId !== options.sessionId || navigation.scopeKey !== options.scopeKey) return;
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
    if (
      turnStart.scopeKey !== undefined
      && turnStart.scopeKey !== options.scopeKey
      && !(turnStart.preserveAcrossSessionChange === true && turnStart.sessionId === options.sessionId)
    ) return;

    if (navigation.turnId !== turnStart.turnId) {
      startTurn(navigation, options);
      scheduleRef.current();
      return;
    }

    // The optimistic ID may be replaced by Pi's authoritative ID. Resolve the
    // same logical turn, but never revive following after the user navigated up.
    if (!navigation.following || navigation.anchorSuppressed) return;
    const target = resolveTurnMessage(options.messages, turnStart, options.lookup);
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
    options.turnStart?.clientMessageId,
    options.turnStart?.text,
    options.turnStart?.timestamp,
    options.messages,
    options.scopeKey,
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

export const TranscriptViewport = memo(function TranscriptViewport({
  messages,
  scrollRef,
  sessionId,
  turnStart,
  isStreaming,
  activities = [],
  scope,
  scopeKey,
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
    lookup: TranscriptMessageLookup;
  } | undefined>(undefined);
  const firstId = messages[0]?.id;
  const lastId = messages.at(-1)?.id;
  const previousLookup = lookupRef.current;
  if (!previousLookup
    || previousLookup.scopeKey !== messageScopeKey
    || previousLookup.length !== messages.length
    || previousLookup.firstId !== firstId
    || previousLookup.lastId !== lastId) {
    const byId = new Map<string, UiMessage>();
    const byClientIdentity = new Map<string, UiMessage>();
    const byText = new Map<string, UiMessage[]>();
    const positions = new Map<string, number>();
    messages.forEach((message, index) => {
      byId.set(message.id, message);
      positions.set(message.id, index);
      const textMessages = byText.get(message.text) ?? [];
      textMessages.push(message);
      byText.set(message.text, textMessages);
      if (message.role === "user" && message.clientTurnId && message.clientMessageId) {
        byClientIdentity.set(clientIdentityKey(message.clientTurnId, message.clientMessageId), message);
      }
    });
    lookupRef.current = {
      scopeKey: messageScopeKey,
      length: messages.length,
      firstId,
      lastId,
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
    [messages, activities, liveStatus, turnStart],
    {
      sessionId,
      scopeKey: messageScopeKey,
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
