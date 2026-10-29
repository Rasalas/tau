import { useCallback, useRef, useSyncExternalStore, type ReactNode } from "react";
import { errorMessage } from "../../workbench/error-message";
import type { TranscriptPage } from "../../shared/host-protocol";
import type { HostTranscriptCursor } from "../../shared/transcript-cursor";
import { countUserTurns } from "../../shared/transcript-pager";
import type { TranscriptHistoryController, TranscriptHistoryRequest, TranscriptScrollAnchor } from "../../workbench/transcript-history";
import { requestLatest } from "./transcript-reveal";
import { TranscriptHistoryControl } from "./TranscriptHistoryControl";

export interface TranscriptHistoryBoundaryProps {
  controller: TranscriptHistoryController;
  showControl: boolean;
  captureAnchor?: () => TranscriptScrollAnchor | undefined;
  loadPage: (sessionId: string, cursor: HostTranscriptCursor) => Promise<TranscriptPage>;
  applyPage: (page: TranscriptPage, request: TranscriptHistoryRequest) => boolean;
  /**
   * Gets the callback for the transcript's `onReachStart` (loads older turns on
   * the reader's way up), the line for its `history`, above the first loaded row,
   * and `loadThrough`, which loads older turns until a message is among them.
   */
  children: (loadOlderOnReach: () => void, history: ReactNode, loadThrough: (messageId: string) => Promise<boolean>, gap?: { beforeMessageId?: string; content: ReactNode }) => ReactNode;
}

/** Pages one `loadThrough` fetches at most; a thread this long is read from the start by scrolling. */
const LOAD_THROUGH_PAGES = 500;
/** How long `loadThrough` waits for a page someone else is loading. */
const PAGE_WAIT_MS = 15_000;

export function TranscriptHistoryBoundary({
  controller,
  showControl,
  captureAnchor,
  loadPage,
  applyPage,
  children,
}: TranscriptHistoryBoundaryProps) {
  const searchGeneration = useRef(0);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  const loadOlder = useCallback(async (anchor?: TranscriptScrollAnchor) => {
    const request = controller.beginLoad(anchor);
    if (!request) return;
    try {
      const page = await loadPage(request.sessionId, request.cursor);
      if (!controller.isCurrent(request)) return;
      if (page.sessionId !== request.sessionId) {
        controller.completeError(request, "Could not load older turns: received a page for another thread.");
        return;
      }
      // A reader who moved away during the fetch keeps their current rows.
      // Leave the cursor in place so returning to the start re-reads this page.
      if (anchor && !controller.canLoadAtAnchor(captureAnchor?.() ?? anchor)) {
        controller.abortRequest(request);
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
  }, [applyPage, captureAnchor, controller, loadPage]);

  const loadOlderOnReach = useCallback(() => {
    const current = controller.getSnapshot();
    // A failed page waits for Retry instead of coming back on every scroll.
    if (!current.olderCursor || current.loading || current.status?.state === "error" || current.historyCompleteness === "unknown") return;
    void loadOlder(captureAnchor?.());
  }, [captureAnchor, controller, loadOlder]);

  const restoreLatest = useCallback((event?: { currentTarget: HTMLElement }) => {
    const restart = controller.beginRestoreLatest();
    if (!restart || !applyPage(restart.page, restart.request)) return false;
    controller.completeSuccess(restart.request, 0);
    if (event) requestLatest(event.currentTarget.closest(".transcript"));
    return true;
  }, [applyPage, controller]);

  const loadThrough = useCallback(async (messageId: string): Promise<boolean> => {
    const initialSessionId = controller.getSnapshot().sessionId;
    const navigationVersion = controller.navigationVersion;
    const generation = ++searchGeneration.current;
    const currentSearch = () => generation === searchGeneration.current && navigationVersion === controller.navigationVersion
      && controller.acceptsExternalPage(initialSessionId ?? "");
    const loaded = () => {
      const sessionId = controller.getSnapshot().sessionId;
      return Boolean(sessionId && controller.getDetail(sessionId)?.messages.some((message) => message.id === messageId));
    };
    if (!loaded() && controller.getSnapshot().historyWindowEvicted) restoreLatest();
    for (let pages = 0; pages < LOAD_THROUGH_PAGES; pages += 1) {
      if (!currentSearch()) return false;
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
    return currentSearch() && loaded();
  }, [controller, loadOlder, restoreLatest]);

  const gap = state.historyWindowEvicted ? {
    beforeMessageId: state.gapBeforeMessageId,
    content: <div className="transcript-history-row transcript-window-gap" data-transcript-gap="true">
      <span>Some turns between here and the latest are not loaded.</span>
      <button type="button" onClick={restoreLatest}>Reload from latest</button>
    </div>,
  } : undefined;
  const history = showControl ? <>
    {gap ? <div className="transcript-history-row transcript-window-gap"><button type="button" onClick={restoreLatest}>Back to latest turns</button></div> : null}
    <TranscriptHistoryControl
      olderCursor={state.olderCursor}
      historyCompleteness={state.historyCompleteness}
      loading={state.loading}
      status={state.status}
      onRetry={() => void loadOlder(captureAnchor?.())}
    /></> : null;
  return <>{children(loadOlderOnReach, history, loadThrough, gap)}</>;
}
