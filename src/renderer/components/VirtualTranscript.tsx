import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { UiMessage } from "../../shared/contracts";
import { Message } from "./Message";

export interface VirtualTranscriptProps {
  messages: UiMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  isStreaming: boolean;
  sessionKey?: string;
  activity?: ReactNode;
  activityAfterMessageId?: string;
  activities?: Array<{ id: string; afterMessageId?: string; content: ReactNode }>;
  onCopyMessage?: (message: UiMessage) => void;
  onForkMessage?: (message: UiMessage) => void;
}

interface ViewportPosition {
  container: HTMLElement;
  scrollTop: number;
  scrollHeight: number;
  anchor?: HTMLElement;
  anchorTop?: number;
  tracked: HTMLElement;
  trackedHeight: number;
  trackedTop: number;
}

interface PendingToggle {
  token: number;
  messageId: string;
  row: HTMLElement;
  position: ViewportPosition;
}

const EMPTY_MESSAGE_IDS: ReadonlySet<string> = new Set();
const USER_SCROLL_KEYS = new Set(["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "]);
const MAX_EXPANDED_MESSAGE_IDS = 64;

function captureViewportPosition(container: HTMLElement, messageIndex: number): ViewportPosition | undefined {
  const rows = [...container.querySelectorAll<HTMLElement>(".virtual-transcript-row")];
  const tracked = rows.find((row) => row.dataset.index === String(messageIndex));
  if (!tracked) return undefined;

  const containerTop = container.getBoundingClientRect().top;
  const trackedRect = tracked.getBoundingClientRect();
  const trackedIndex = rows.indexOf(tracked);
  const anchor = rows
    .slice(trackedIndex)
    .find((row) => row.getBoundingClientRect().top >= containerTop);
  const anchorRect = anchor?.getBoundingClientRect();
  return {
    container,
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    anchor,
    anchorTop: anchorRect?.top,
    tracked,
    trackedHeight: trackedRect.height,
    trackedTop: trackedRect.top,
  };
}

function restoreViewportPosition(position: ViewportPosition, markProgrammaticScroll: () => void): void {
  if (position.anchor && position.anchorTop !== undefined && position.anchor.isConnected) {
    markProgrammaticScroll();
    position.container.scrollTop += position.anchor.getBoundingClientRect().top - position.anchorTop;
    return;
  }

  // A tail row has no following anchor. Compute an absolute target from the
  // pre-toggle offset and clamp it against the post-layout maximum. Browsers
  // may already clamp scrollTop when the transcript shrinks.
  if (position.tracked.isConnected && position.trackedTop < position.container.getBoundingClientRect().top) {
    const delta = position.tracked.getBoundingClientRect().height - position.trackedHeight;
    const maxScrollTop = Math.max(0, position.container.scrollHeight - position.container.clientHeight);
    const targetScrollTop = Math.min(maxScrollTop, Math.max(0, position.scrollTop + delta));
    markProgrammaticScroll();
    position.container.scrollTop = targetScrollTop;
  }
}

/** Variable-height transcript window. Activities live inside stable message rows so indexes never shift mid-run. */
export function VirtualTranscript({
  messages,
  scrollRef,
  isStreaming,
  sessionKey = "default",
  activity,
  activityAfterMessageId,
  activities = [],
  onCopyMessage,
  onForkMessage,
}: VirtualTranscriptProps) {
  const pendingActivities = [
    ...activities,
    ...(activity ? [{ id: "turn-activity", afterMessageId: activityAfterMessageId, content: activity }] : []),
  ];
  const messageIds = new Set(messages.map((message) => message.id));
  const tailMessageId = messages.at(-1)?.id;
  const activitiesByMessage = new Map<string, typeof pendingActivities>();
  for (const entry of pendingActivities) {
    const anchor = entry.afterMessageId
      ? (messageIds.has(entry.afterMessageId) ? entry.afterMessageId : entry.id === "turn-activity" ? tailMessageId : undefined)
      : tailMessageId;
    if (!anchor) continue;
    const anchored = activitiesByMessage.get(anchor) ?? [];
    anchored.push(entry);
    activitiesByMessage.set(anchor, anchored);
  }

  const unanchoredLiveActivity = messages.length === 0
    ? pendingActivities.filter((entry) => entry.id === "turn-activity")
    : [];

  const [expandedState, setExpandedState] = useState<{ sessionKey: string; ids: ReadonlySet<string> }>(() => ({ sessionKey, ids: new Set() }));
  const expandedMessageIds = expandedState.sessionKey === sessionKey ? expandedState.ids : EMPTY_MESSAGE_IDS;
  const messageIndexes = useRef(new Map<string, number>());
  messageIndexes.current = new Map(messages.map((message, index) => [message.id, index]));
  const scrollRefValue = useRef(scrollRef);
  scrollRefValue.current = scrollRef;
  const sessionKeyValue = useRef(sessionKey);
  sessionKeyValue.current = sessionKey;
  const nextToggleToken = useRef(0);
  const pendingToggle = useRef<PendingToggle | undefined>(undefined);
  const targetObserver = useRef<ResizeObserver | undefined>(undefined);
  const pendingInteractionCleanup = useRef<(() => void) | undefined>(undefined);
  const restoreFrames = useRef<[number, number?] | undefined>(undefined);
  const programmaticScrollToken = useRef(0);

  const markProgrammaticScroll = () => {
    const token = ++programmaticScrollToken.current;
    window.setTimeout(() => {
      if (programmaticScrollToken.current === token) programmaticScrollToken.current = 0;
    }, 0);
  };

  const cancelRestore = () => {
    if (!restoreFrames.current) return;
    window.cancelAnimationFrame(restoreFrames.current[0]);
    if (restoreFrames.current[1] !== undefined) window.cancelAnimationFrame(restoreFrames.current[1]);
    restoreFrames.current = undefined;
  };

  const clearPendingToggle = (token: number) => {
    if (pendingToggle.current?.token !== token) return;
    targetObserver.current?.disconnect();
    targetObserver.current = undefined;
    pendingInteractionCleanup.current?.();
    pendingInteractionCleanup.current = undefined;
    pendingToggle.current = undefined;
  };

  const queueViewportRestore = (toggle: PendingToggle) => {
    if (pendingToggle.current?.token !== toggle.token || restoreFrames.current) return;
    let first = 0;
    first = window.requestAnimationFrame(() => {
      const second = window.requestAnimationFrame(() => {
        restoreFrames.current = undefined;
        if (pendingToggle.current?.token !== toggle.token) return;
        restoreViewportPosition(toggle.position, markProgrammaticScroll);
        // Keep the pending record alive through the actual scrollTop write so
        // a synchronous browser scroll event can consume the short
        // programmatic-write token. Then clear it deterministically.
        clearPendingToggle(toggle.token);
      });
      restoreFrames.current = [first, second];
    });
    restoreFrames.current = [first, 0];
  };

  useEffect(() => () => {
    cancelRestore();
    targetObserver.current?.disconnect();
    pendingInteractionCleanup.current?.();
  }, []);

  useLayoutEffect(() => {
    if (expandedState.sessionKey === sessionKey) return;
    cancelRestore();
    if (pendingToggle.current) clearPendingToggle(pendingToggle.current.token);
    setExpandedState({ sessionKey, ids: new Set() });
  }, [expandedState.sessionKey, sessionKey]);

  const onMessageToggleExpanded = useCallback((messageId: string, expanded: boolean) => {
    const token = ++nextToggleToken.current;
    const container = scrollRefValue.current.current;
    programmaticScrollToken.current = 0;
    cancelRestore();
    const previous = pendingToggle.current;
    if (previous) clearPendingToggle(previous.token);
    const messageIndex = messageIndexes.current.get(messageId);
    const capturedPosition = container && messageIndex !== undefined
      ? captureViewportPosition(container, messageIndex)
      : undefined;
    const position = capturedPosition && previous?.messageId === messageId && previous.position.container === container && previous.position.scrollTop === container.scrollTop
      ? previous.position
      : capturedPosition;
    pendingToggle.current = position ? { token, messageId, row: position.tracked, position } : undefined;
    if (position && container) {
      const cancelForUserMovement = (event: Event) => {
        const pending = pendingToggle.current;
        if (!pending) return;
        if (event.type === "scroll") {
          if (programmaticScrollToken.current > 0) {
            programmaticScrollToken.current = 0;
            return;
          }
          if (pending.position.scrollHeight !== container.scrollHeight) {
            // A shrinking scroll range can emit a browser-generated scroll
            // event before ResizeObserver delivers the row measurement. Only
            // accept that exact clamp; every other scrollTop change is user
            // intent and must cancel the delayed restore.
            const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
            const naturalClamp = Math.min(pending.position.scrollTop, maxScrollTop);
            if (container.scrollTop === naturalClamp) return;
          }
        }
        if (event.type === "keydown" && !USER_SCROLL_KEYS.has((event as KeyboardEvent).key)) return;
        cancelRestore();
        clearPendingToggle(pending.token);
      };
      container.addEventListener("wheel", cancelForUserMovement, { passive: true });
      container.addEventListener("touchstart", cancelForUserMovement, { passive: true });
      container.addEventListener("pointerdown", cancelForUserMovement, { passive: true });
      container.addEventListener("scroll", cancelForUserMovement, { passive: true });
      window.addEventListener("wheel", cancelForUserMovement, { passive: true });
      window.addEventListener("touchstart", cancelForUserMovement, { passive: true });
      window.addEventListener("pointerdown", cancelForUserMovement, { passive: true });
      window.addEventListener("keydown", cancelForUserMovement);
      pendingInteractionCleanup.current = () => {
        container.removeEventListener("wheel", cancelForUserMovement);
        container.removeEventListener("touchstart", cancelForUserMovement);
        container.removeEventListener("pointerdown", cancelForUserMovement);
        container.removeEventListener("scroll", cancelForUserMovement);
        window.removeEventListener("wheel", cancelForUserMovement);
        window.removeEventListener("touchstart", cancelForUserMovement);
        window.removeEventListener("pointerdown", cancelForUserMovement);
        window.removeEventListener("keydown", cancelForUserMovement);
      };
    }
    setExpandedState((current) => {
      const next = new Set(current.sessionKey === sessionKeyValue.current ? current.ids : EMPTY_MESSAGE_IDS);
      if (expanded) {
        // Re-inserting makes this a small LRU: frequently used expanded rows
        // stay available while abandoned IDs cannot grow without bound.
        next.delete(messageId);
        next.add(messageId);
      } else next.delete(messageId);
      while (next.size > MAX_EXPANDED_MESSAGE_IDS) next.delete(next.values().next().value!);
      return { sessionKey: sessionKeyValue.current, ids: next };
    });
  }, []);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 180,
    getItemKey: (index) => messages[index]?.id ?? index,
    initialRect: { width: 780, height: 600 },
    overscan: 6,
    useAnimationFrameWithResizeObserver: true,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;

  useLayoutEffect(() => {
    const toggle = pendingToggle.current;
    if (!toggle || !toggle.row.isConnected) {
      if (toggle) clearPendingToggle(toggle.token);
      return;
    }

    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === toggle.row);
      if (!entry || pendingToggle.current?.token !== toggle.token) return;
      const box = entry.borderBoxSize[0];
      const measuredHeight = box?.blockSize ?? toggle.row.offsetHeight;
      if (measuredHeight === toggle.position.trackedHeight) {
        clearPendingToggle(toggle.token);
      } else {
        queueViewportRestore(toggle);
      }
    });

    targetObserver.current?.disconnect();
    targetObserver.current = observer;
    if (observer) {
      observer.observe(toggle.row, { box: "border-box" });
    } else {
      virtualizer.measureElement(toggle.row);
      if (toggle.row.offsetHeight === toggle.position.trackedHeight) clearPendingToggle(toggle.token);
      else queueViewportRestore(toggle);
    }

    return () => {
      observer?.disconnect();
      if (targetObserver.current === observer) targetObserver.current = undefined;
    };
  }, [expandedMessageIds, virtualizer]);

  const measuredRows = virtualizer.getVirtualItems();
  const rows = measuredRows.length > 0
    ? measuredRows
    : messages.slice(0, 12).map((message, index) => ({ index, key: message.id, start: index * 180 }));

  if (messages.length === 0 && unanchoredLiveActivity.length > 0) {
    return <div className="virtual-transcript static-activity-transcript">
      {unanchoredLiveActivity.map((entry) => <div className="inline-transcript-activity" key={entry.id}>{entry.content}</div>)}
    </div>;
  }

  return <div
    className="virtual-transcript"
    style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
  >
    {rows.map((row) => {
      const message = messages[row.index];
      const anchoredActivities = activitiesByMessage.get(message.id) ?? [];
      return <div
        key={message.id}
        ref={virtualizer.measureElement}
        data-index={row.index}
        className="virtual-transcript-row"
        style={{
          position: "absolute",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          transform: `translateY(${row.start}px)`,
        }}
      >
        <Message
          message={message}
          streaming={Boolean(isStreaming && message === messages.at(-1) && message.role === "assistant")}
          onCopy={onCopyMessage}
          onFork={onForkMessage}
          onToggleExpanded={onMessageToggleExpanded}
          expanded={expandedMessageIds.has(message.id)}
        />
        {anchoredActivities.map((entry) => <div className="inline-transcript-activity" key={entry.id}>{entry.content}</div>)}
      </div>;
    })}
  </div>;
}
