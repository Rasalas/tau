import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import { errorMessage } from "../../workbench/error-message";
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
   * the reader's way up), the line for its `history`, above the first loaded row,
   * and `loadThrough`, which loads older turns until a message is among them.
   */
  children: (loadOlderOnReach: () => void, history: ReactNode, loadThrough: (messageId: string) => Promise<boolean>) => ReactNode;
}

/** Pages one `loadThrough` fetches at most; a thread this long is read from the start by scrolling. */
const LOAD_THROUGH_PAGES = 500;
/** How long `loadThrough` waits for a page someone else is loading. */
const PAGE_WAIT_MS = 15_000;

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
      const message = errorMessage(error);
      controller.completeError(request, `Could not load older turns: ${message}`);
    }
  }, [applyPage, controller, loadPage]);

  const loadOlderOnReach = useCallback(() => {
    const current = controller.getSnapshot();
    // A failed page waits for Retry instead of coming back on every scroll.
    if (!current.olderCursor || current.loading || current.status?.state === "error" || current.historyCompleteness === "unknown") return;
    void loadOlder();
  }, [controller, loadOlder]);

  const loadThrough = useCallback(async (messageId: string): Promise<boolean> => {
    const loaded = () => {
      const sessionId = controller.getSnapshot().sessionId;
      return Boolean(sessionId && controller.getDetail(sessionId)?.messages.some((message) => message.id === messageId));
    };
    for (let pages = 0; pages < LOAD_THROUGH_PAGES; pages += 1) {
      if (loaded()) return true;
      const current = controller.getSnapshot();
      if (!current.olderCursor || current.status?.state === "error" || current.historyCompleteness === "unknown") return false;
      if (current.loading) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { stop(); resolve(); }, PAGE_WAIT_MS);
          const stop = controller.subscribe(() => { clearTimeout(timer); stop(); resolve(); });
        });
      } else await loadOlder();
    }
    return loaded();
  }, [controller, loadOlder]);

  const history = showControl ? <TranscriptHistoryControl
    olderCursor={state.olderCursor}
    historyCompleteness={state.historyCompleteness}
    loading={state.loading}
    status={state.status}
    onRetry={() => void loadOlder()}
  /> : null;
  return <>{children(loadOlderOnReach, history, loadThrough)}</>;
}
