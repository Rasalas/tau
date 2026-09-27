import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import type { TranscriptPage } from "../../shared/host-protocol";
import type { HostTranscriptCursor } from "../../shared/transcript-cursor";
import { countUserTurns } from "../../shared/transcript-pager";
import type { TranscriptHistoryController, TranscriptHistoryRequest } from "../../workbench/transcript-history";
import { TranscriptHistoryControl } from "./TranscriptHistoryControl";

export interface TranscriptHistoryBoundaryProps {
  controller: TranscriptHistoryController;
  showControl: boolean;
  loadPage: (sessionId: string, cursor: HostTranscriptCursor) => Promise<TranscriptPage>;
  applyPage: (page: TranscriptPage, request: TranscriptHistoryRequest) => boolean;
  /**
   * Gets the callback for the transcript's `onReachStart` (loads older turns on
   * the reader's way up) and the line for its `history`, above the first loaded row.
   */
  children: (loadOlderOnReach: () => void, history: ReactNode) => ReactNode;
}

export function TranscriptHistoryBoundary({
  controller,
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
    // A failed page waits for Retry instead of coming back on every scroll.
    if (!current.olderCursor || current.loading || current.status?.state === "error" || current.historyCompleteness === "unknown") return;
    void loadOlder();
  }, [controller, loadOlder]);

  const history = showControl ? <TranscriptHistoryControl
    olderCursor={state.olderCursor}
    historyCompleteness={state.historyCompleteness}
    loading={state.loading}
    status={state.status}
    onRetry={() => void loadOlder()}
  /> : null;
  return <>{children(loadOlderOnReach, history)}</>;
}
