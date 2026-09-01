import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { UiMessage } from "../../shared/contracts";
import {
  followTail,
  resetNavigation,
  resolveTurnMessage,
  setAnchor,
  startTurn,
  stopFollowing,
  type ScrollIntent,
  type TranscriptMessageLookup,
  type TranscriptNavigationOptions,
  type TranscriptNavigationState,
} from "./transcript-navigation";

/**
 * DOM adapter for transcript navigation. The state transitions live in
 * `transcript-navigation.ts`; this hook only translates browser events and
 * measured geometry into those transitions.
 */
export function useTranscriptNavigation(
  ref: RefObject<HTMLDivElement | null>,
  updates: readonly unknown[],
  options: TranscriptNavigationOptions,
): {
  canJumpToLatest: boolean;
  jumpToLatest: () => void;
  jumpToMessage: (messageId: string) => void;
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
  const seekFrameRef = useRef<number | undefined>(undefined);
  const seekTargetRef = useRef<{ messageId: string; attempts: number } | undefined>(undefined);
  const scheduleRef = useRef<() => void>(() => {});
  const messagesRef = useRef<UiMessage[]>(options.messages);
  messagesRef.current = options.messages;
  const lookupRef = useRef<TranscriptMessageLookup | undefined>(options.lookup);
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

  const findMessage = (node: HTMLDivElement, id: string): HTMLElement | undefined => [...node.querySelectorAll<HTMLElement>("[data-message-id]")]
    .find((element) => element.dataset.messageId === id);

  const findAnchor = (node: HTMLDivElement): HTMLElement | undefined => {
    const id = navigationRef.current!.anchorId;
    if (!id) return undefined;
    return findMessage(node, id);
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
    const transform = element.style.transform.match(/translateY\(\s*(-?\d+(?:\.\d+)?)px\s*\)/u);
    if (transform?.[1] !== undefined) return Number(transform[1]);
    let top = 0;
    let current: HTMLElement | null = element;
    while (current && current !== node) {
      top += current.offsetTop;
      current = current.offsetParent as HTMLElement | null;
    }
    return top;
  };

  const placeMessage = (node: HTMLDivElement, messageId: string): boolean => {
    const message = findMessage(node, messageId);
    if (!message) {
      // TanStack Virtual may not have mounted a distant row yet. Seeking to
      // its estimated position mounts the relevant window; a later frame then
      // uses the real row geometry without inventing transcript content.
      const messageIndex = lookupRef.current?.positions.get(messageId)
        ?? messagesRef.current.findIndex((candidate) => candidate.id === messageId);
      const estimatedRowHeight = messagesRef.current.length > 0
        ? Math.max(1, node.scrollHeight / messagesRef.current.length)
        : 0;
      if (messageIndex < 0 || estimatedRowHeight <= 0) return false;
      const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
      node.scrollTop = Math.min(
        maxScrollTop,
        Math.max(0, messageIndex * estimatedRowHeight - paddingTop(node)),
      );
      return false;
    }
    const rawTarget = contentTop(node, message) - paddingTop(node);
    const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    node.scrollTop = Math.max(0, Math.min(maxScrollTop, rawTarget));
    return true;
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
    seekTargetRef.current = undefined;
    if (seekFrameRef.current !== undefined) cancelAnimationFrame(seekFrameRef.current);
    seekFrameRef.current = undefined;
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

  const jumpToMessage = useCallback((messageId: string) => {
    const node = ref.current;
    const navigation = navigationRef.current!;
    if (!node || !messagesRef.current.some((message) => message.id === messageId)) return;

    // A turn selection is an explicit reading decision. Release the tail
    // lease before moving so streaming deltas cannot pull the user back down.
    stopFollowing(navigation, onAnchorChangeRef.current);
    seekTargetRef.current = { messageId, attempts: 0 };
    if (seekFrameRef.current !== undefined) cancelAnimationFrame(seekFrameRef.current);
    seekFrameRef.current = undefined;

    const place = () => {
      seekFrameRef.current = undefined;
      const target = seekTargetRef.current;
      const current = ref.current;
      if (!target || !current || !navigationRef.current || navigationRef.current.following) return;
      if (placeMessage(current, target.messageId) || target.attempts >= 8) {
        seekTargetRef.current = undefined;
        updateJumpAvailability(current);
        return;
      }
      target.attempts += 1;
      seekFrameRef.current = requestAnimationFrame(place);
    };

    place();
    updateJumpAvailability(node);
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
      seekTargetRef.current = undefined;
      if (seekFrameRef.current !== undefined) cancelAnimationFrame(seekFrameRef.current);
      seekFrameRef.current = undefined;
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
      seekTargetRef.current = undefined;
      if (seekFrameRef.current !== undefined) cancelAnimationFrame(seekFrameRef.current);
      seekFrameRef.current = undefined;
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
    } else if (!target && navigation.anchorId !== undefined) {
      // A persisted record may keep its entry ID while gaining explicit
      // authoritative identity metadata. Once that metadata mismatches this
      // logical turn, the old idless anchor is no longer eligible; clear the
      // marker immediately while retaining a pending lookup for a later
      // authoritative record.
      navigation.anchorPending = true;
      navigation.anchorLocked = false;
      setAnchor(navigation, undefined, onAnchorChangeRef.current);
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
    options.lookup,
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

  return { canJumpToLatest, jumpToLatest, jumpToMessage };
}
