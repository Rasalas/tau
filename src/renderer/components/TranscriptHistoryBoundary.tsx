import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import type { TranscriptPage } from "../../shared/host-protocol";
import type { HostTranscriptCursor } from "../../shared/transcript-cursor";
import { countUserTurns } from "../../shared/transcript-pager";
import type { TranscriptHistoryController, TranscriptHistoryRequest } from "../../workbench/transcript-history";
import { TranscriptHistoryControl } from "./TranscriptHistoryControl";

export interface TranscriptHistoryBoundaryProps {
  controller: TranscriptHistoryController;
  scrollRef: RefObject<HTMLDivElement | null>;
  showControl: boolean;
  loadPage: (sessionId: string, cursor: HostTranscriptCursor) => Promise<TranscriptPage>;
  applyPage: (page: TranscriptPage, request: TranscriptHistoryRequest) => boolean;
  /** Gets the callback for the transcript's `onReachStart`: loads older turns on the reader's way up. */
  children: (loadOlderOnReach: () => void) => ReactNode;
}

export function TranscriptHistoryBoundary({
  controller,
  scrollRef,
  showControl,
  loadPage,
  applyPage,
  children,
}: TranscriptHistoryBoundaryProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  const loadOlder = useCallback(async () => {
    const request = controller.beginLoad();
    if (!request) return;
    try {
      const page = await loadPage(request.sessionId, request.cursor);
      if (!controller.isCurrent(request)) return;
      if (page.sessionId !== request.sessionId) {
        controller.completeError(request, "Could not load older turns: received a page for another thread.");
        return;
      }
      if (!applyPage(page, request)) {
        controller.abortRequest(request);
        return;
      }
      // The rows are in; the transcript holds its leading row itself (useLeadingRowAnchor).
      controller.completeSuccess(request, countUserTurns(page.messages));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      controller.completeError(request, `Could not load older turns: ${message}`);
    }
  }, [applyPage, controller, loadPage]);

  const loadOlderOnReach = useCallback(() => {
    const current = controller.getSnapshot();
    // What the button offers, without retrying a failed page on every scroll.
    if (!current.olderCursor || current.loading || current.status?.state === "error" || current.historyCompleteness === "unknown") return;
    void loadOlder();
  }, [controller, loadOlder]);

  // The history line sits above the scroller. When it comes or goes (the last
  // older page landed), move the rows by as much, so the reader sees no shift.
  const controlRef = useRef<HTMLElement>(null);
  const controlLayout = useRef<{ sessionId?: string; px: number }>({ px: 0 });
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const control = controlRef.current;
    const px = control ? node.getBoundingClientRect().top - control.getBoundingClientRect().top : 0;
    const previous = controlLayout.current;
    controlLayout.current = { sessionId: state.sessionId, px };
    if (previous.sessionId === state.sessionId && px !== previous.px) node.scrollTop += px - previous.px;
  }, [scrollRef, showControl, state]);

  return <>
    {showControl ? <TranscriptHistoryControl
      ref={controlRef}
      olderCursor={state.olderCursor}
      historyCompleteness={state.historyCompleteness}
      loading={state.loading}
      status={state.status}
      onLoad={() => void loadOlder()}
    /> : null}
    {children(loadOlderOnReach)}
  </>;
}
