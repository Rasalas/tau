import { useCallback, useEffect, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from "react";

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
  row: HTMLElement;
  position: ViewportPosition;
}

interface TranscriptVirtualizer {
  measureElement: (element: HTMLElement) => void;
}

interface UseTranscriptViewportAnchorOptions {
  expandedMessageIds: ReadonlySet<string>;
  messageIndexes: MutableRefObject<Map<string, number>>;
  onExpandedChange: (messageId: string, expanded: boolean) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  sessionKey: string;
  virtualizer: TranscriptVirtualizer;
}

const USER_SCROLL_KEYS = new Set(["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "]);

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
    position.container.scrollTop = position.scrollTop + position.anchor.getBoundingClientRect().top - position.anchorTop;
    return;
  }

  // Tail rows have no following anchor. Compute an absolute target from the
  // pre-toggle geometry and clamp it once against the post-layout range.
  if (position.tracked.isConnected && position.trackedTop < position.container.getBoundingClientRect().top) {
    const delta = position.tracked.getBoundingClientRect().height - position.trackedHeight;
    const maxScrollTop = Math.max(0, position.container.scrollHeight - position.container.clientHeight);
    const targetScrollTop = Math.min(maxScrollTop, Math.max(0, position.scrollTop + delta));
    markProgrammaticScroll();
    position.container.scrollTop = targetScrollTop;
  }
}

function registerPendingInteractionListeners(container: HTMLElement, onInteraction: (event: Event) => void): () => void {
  const containerEvents: Array<[string, AddEventListenerOptions]> = [
    ["wheel", { passive: true }],
    ["touchstart", { passive: true }],
    ["pointerdown", { passive: true }],
    ["scroll", { passive: true }],
  ];
  const windowEvents: Array<[string, AddEventListenerOptions | undefined]> = [
    ["wheel", { passive: true }],
    ["touchstart", { passive: true }],
    ["pointerdown", { passive: true }],
    ["keydown", undefined],
  ];
  containerEvents.forEach(([type, options]) => container.addEventListener(type, onInteraction, options));
  windowEvents.forEach(([type, options]) => window.addEventListener(type, onInteraction, options));
  return () => {
    containerEvents.forEach(([type]) => container.removeEventListener(type, onInteraction));
    windowEvents.forEach(([type]) => window.removeEventListener(type, onInteraction));
  };
}

export function useTranscriptViewportAnchor({
  expandedMessageIds,
  messageIndexes,
  onExpandedChange,
  scrollRef,
  sessionKey,
  virtualizer,
}: UseTranscriptViewportAnchorOptions) {
  const scrollRefValue = useRef(scrollRef);
  scrollRefValue.current = scrollRef;
  const virtualizerValue = useRef(virtualizer);
  virtualizerValue.current = virtualizer;
  const onExpandedChangeValue = useRef(onExpandedChange);
  onExpandedChangeValue.current = onExpandedChange;
  const nextToggleToken = useRef(0);
  const pendingToggle = useRef<PendingToggle | undefined>(undefined);
  const targetObserver = useRef<ResizeObserver | undefined>(undefined);
  const pendingInteractionCleanup = useRef<(() => void) | undefined>(undefined);
  const restoreAnimationFrameIds = useRef<[number, number?] | undefined>(undefined);
  const programmaticScrollToken = useRef(0);

  const markProgrammaticScroll = useCallback(() => {
    const token = ++programmaticScrollToken.current;
    window.setTimeout(() => {
      if (programmaticScrollToken.current === token) programmaticScrollToken.current = 0;
    }, 0);
  }, []);

  const cancelRestore = useCallback(() => {
    const [firstRestoreFrameId, secondRestoreFrameId] = restoreAnimationFrameIds.current ?? [];
    if (firstRestoreFrameId !== undefined) window.cancelAnimationFrame(firstRestoreFrameId);
    if (secondRestoreFrameId !== undefined) window.cancelAnimationFrame(secondRestoreFrameId);
    restoreAnimationFrameIds.current = undefined;
  }, []);

  const clearPendingToggle = useCallback((token: number) => {
    if (pendingToggle.current?.token !== token) return;
    targetObserver.current?.disconnect();
    targetObserver.current = undefined;
    pendingInteractionCleanup.current?.();
    pendingInteractionCleanup.current = undefined;
    pendingToggle.current = undefined;
  }, []);

  const queueViewportRestore = useCallback((toggle: PendingToggle) => {
    if (pendingToggle.current?.token !== toggle.token || restoreAnimationFrameIds.current) return;
    let firstRestoreFrameId = 0;
    firstRestoreFrameId = window.requestAnimationFrame(() => {
      const secondRestoreFrameId = window.requestAnimationFrame(() => {
        restoreAnimationFrameIds.current = undefined;
        if (pendingToggle.current?.token !== toggle.token) return;
        restoreViewportPosition(toggle.position, markProgrammaticScroll);
        // Keep the pending record through the scrollTop write so a synchronous
        // browser scroll event can consume the programmatic-write token.
        clearPendingToggle(toggle.token);
      });
      restoreAnimationFrameIds.current = [firstRestoreFrameId, secondRestoreFrameId];
    });
    restoreAnimationFrameIds.current = [firstRestoreFrameId, undefined];
  }, [clearPendingToggle, markProgrammaticScroll]);

  useEffect(() => () => {
    cancelRestore();
    targetObserver.current?.disconnect();
    pendingInteractionCleanup.current?.();
  }, [cancelRestore]);

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
      if (measuredHeight === toggle.position.trackedHeight) clearPendingToggle(toggle.token);
      else queueViewportRestore(toggle);
    });

    targetObserver.current?.disconnect();
    targetObserver.current = observer;
    if (observer) observer.observe(toggle.row, { box: "border-box" });
    else {
      virtualizerValue.current.measureElement(toggle.row);
      if (toggle.row.offsetHeight === toggle.position.trackedHeight) clearPendingToggle(toggle.token);
      else queueViewportRestore(toggle);
    }

    return () => {
      observer?.disconnect();
      if (targetObserver.current === observer) targetObserver.current = undefined;
    };
  }, [clearPendingToggle, expandedMessageIds, queueViewportRestore]);

  useLayoutEffect(() => {
    cancelRestore();
    if (pendingToggle.current) clearPendingToggle(pendingToggle.current.token);
  }, [cancelRestore, clearPendingToggle, sessionKey]);

  return useCallback((messageId: string, _expanded: boolean) => {
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
    const position = capturedPosition && previous?.row === capturedPosition.tracked && previous.position.container === container && previous.position.scrollTop === container.scrollTop
      ? previous.position
      : capturedPosition;
    pendingToggle.current = position ? { token, row: position.tracked, position } : undefined;

    if (position && container) {
      const onPendingInteraction = (event: Event) => {
        const pending = pendingToggle.current;
        if (!pending) return;
        if (event.type === "scroll") {
          if (programmaticScrollToken.current > 0) {
            programmaticScrollToken.current = 0;
            return;
          }
          if (pending.position.scrollHeight !== container.scrollHeight) {
            const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
            const naturalClamp = Math.min(pending.position.scrollTop, maxScrollTop);
            if (container.scrollTop === naturalClamp) return;
          }
        }
        if (event.type === "keydown" && !USER_SCROLL_KEYS.has((event as KeyboardEvent).key)) return;
        cancelRestore();
        clearPendingToggle(pending.token);
      };
      pendingInteractionCleanup.current = registerPendingInteractionListeners(container, onPendingInteraction);
    }
    onExpandedChangeValue.current(messageId, _expanded);
  }, [cancelRestore, clearPendingToggle, messageIndexes]);
}
