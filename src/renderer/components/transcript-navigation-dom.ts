import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { UiMessage } from "../../shared/contracts";
import {
  followTail,
  resetNavigation,
  resolveTurnMessage,
  setAnchor,
  startTurn,
  type TranscriptMessageLookup,
  type TranscriptNavigationOptions,
  type TranscriptNavigationState,
} from "../../workbench/transcript-navigation";
import { TranscriptScrollController } from "./transcript-scroll-controller";

export interface TranscriptNavigation {
  canJumpToLatest: boolean;
  jumpToLatest: () => void;
  jumpToMessage: (messageId: string) => void;
  /** False once the reader scrolled away from the tail or jumped to a turn. */
  isFollowing: () => boolean;
  /** Reuse the controller's single scroll listener and ResizeObserver. */
  subscribeScroll: (listener: () => void) => () => void;
  subscribeResize: (listener: () => void) => () => void;
}

function initialNavigationState(options: TranscriptNavigationOptions): TranscriptNavigationState {
  return {
    sessionId: options.sessionId,
    scopeKey: options.scopeKey,
    scope: options.turnStart?.scope,
    turnId: options.turnStart?.turnId,
    anchorId: resolveTurnMessage(options.messages, options.turnStart, options.lookup)?.id,
    anchorPending: Boolean(options.turnStart),
    anchorLocked: false,
    anchorSuppressed: false,
    following: true,
    touchActive: false,
    pointerDown: false,
  };
}

/**
 * React adapter for transcript navigation. Transitions live in
 * `transcript-navigation.ts`, every DOM read and scroll write in
 * `transcript-scroll-controller.ts`; this hook only wires them to props.
 */
export function useTranscriptNavigation(
  ref: RefObject<HTMLDivElement | null>,
  updates: readonly unknown[],
  options: TranscriptNavigationOptions,
): TranscriptNavigation {
  const [canJumpToLatest, setCanJumpToLatest] = useState(false);
  const latest = useRef<{
    messages: readonly UiMessage[];
    lookup: TranscriptMessageLookup | undefined;
    onAnchorChange: (id?: string) => void;
  }>({ messages: options.messages, lookup: options.lookup, onAnchorChange: options.onAnchorChange });
  const [{ navigation, controller }] = useState(() => {
    const state = initialNavigationState(options);
    return {
      navigation: state,
      controller: new TranscriptScrollController(state, {
        getNode: () => ref.current,
        getMessages: () => latest.current.messages,
        getLookup: () => latest.current.lookup,
        onAnchorChange: (id) => latest.current.onAnchorChange(id),
        onJumpAvailabilityChange: (canJump) => setCanJumpToLatest((current) => current === canJump ? current : canJump),
      }),
    };
  });

  useLayoutEffect(() => {
    latest.current = { messages: options.messages, lookup: options.lookup, onAnchorChange: options.onAnchorChange };
  });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    controller.attach(node);
    return () => controller.detach();
  }, [controller, ref]);

  const jumpToLatest = useCallback(() => controller.jumpToLatest(), [controller]);
  const jumpToMessage = useCallback((messageId: string) => controller.jumpToMessage(messageId), [controller]);
  const isFollowing = useCallback(() => controller.mode !== "free", [controller]);
  const subscribeScroll = useCallback((listener: () => void) => controller.subscribeScroll(listener), [controller]);
  const subscribeResize = useCallback((listener: () => void) => controller.subscribeResize(listener), [controller]);

  useEffect(() => {
    if (!ref.current) return;
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
          options.onAnchorChange,
        );
      } else {
        // A normal thread/workspace switch is a new transcript, regardless of
        // whether the new thread happens to contain a similarly named prompt.
        resetNavigation(navigation, { ...options, turnStart: undefined });
      }
      controller.resetIntent();
      controller.hideJump();
    }
    controller.resetScrollBaseline();
    controller.sync();
  }, [controller, navigation, options.scopeKey, options.sessionId, options.scope, options.turnStart?.turnId, options.turnStart?.sessionId, ref]);

  useEffect(() => {
    if (navigation.sessionId !== options.sessionId || navigation.scopeKey !== options.scopeKey) return;
    const turnStart = options.turnStart;
    if (!turnStart) {
      if (navigation.turnId !== undefined) {
        // Clearing the send signal (for example after a failed send or a
        // workspace switch) also clears its visual marker when the session ID
        // itself did not change.
        followTail(navigation, options.onAnchorChange);
        navigation.turnId = undefined;
        controller.sync();
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
      controller.sync();
      return;
    }

    // The optimistic ID may be replaced by Pi's authoritative ID. Resolve the
    // same logical turn, but never revive following after the user navigated up.
    if (!navigation.following || navigation.anchorSuppressed) return;
    const target = resolveTurnMessage(options.messages, turnStart, options.lookup);
    if (target && navigation.anchorId !== target.id) {
      navigation.anchorPending = true;
      navigation.anchorLocked = false;
      setAnchor(navigation, target.id, options.onAnchorChange);
    } else if (!target && navigation.anchorId !== undefined) {
      // A persisted record may keep its entry ID while gaining explicit
      // authoritative identity metadata. Once that metadata mismatches this
      // logical turn, the old idless anchor is no longer eligible; clear the
      // marker immediately while retaining a pending lookup for a later
      // authoritative record.
      navigation.anchorPending = true;
      navigation.anchorLocked = false;
      setAnchor(navigation, undefined, options.onAnchorChange);
    }
    controller.sync();
  }, [
    controller,
    navigation,
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
    controller.refreshJumpAvailability();
    controller.sync();
  // The array identity is intentionally controlled by the caller's visible records.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, updates);

  return { canJumpToLatest, jumpToLatest, jumpToMessage, isFollowing, subscribeScroll, subscribeResize };
}
