import { useCallback, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import type { TranscriptPage } from "../../shared/host-protocol";
import { countUserTurns } from "../../shared/transcript-pager";
import {
  captureTranscriptScrollAnchor,
  restoreTranscriptScrollAnchor,
  type TranscriptHistoryController,
  type TranscriptHistoryRequest,
} from "../transcript-history";
import { TranscriptHistoryControl } from "./TranscriptHistoryControl";

export interface TranscriptHistoryBoundaryProps {
  controller: TranscriptHistoryController;
  scrollRef: RefObject<HTMLDivElement | null>;
  showControl: boolean;
  loadPage: (sessionId: string, cursor: string) => Promise<TranscriptPage>;
  applyPage: (page: TranscriptPage, request: TranscriptHistoryRequest) => boolean;
  children: (anchorRef: TranscriptHistoryController["anchorRef"]) => ReactNode;
}

function restoreUntilStable(
  controller: TranscriptHistoryController,
  request: TranscriptHistoryRequest,
  scrollRef: RefObject<HTMLDivElement | null>,
  loadedTurns: number,
): void {
  let frame = 0;
  let stableFrames = 0;
  const tick = () => {
    if (!controller.isCurrent(request)) return;
    const node = scrollRef.current;
    const anchor = controller.anchorRef.current;
    if (!node || !anchor) {
      controller.completeSuccess(request, loadedTurns);
      return;
    }
    const result = restoreTranscriptScrollAnchor(node, anchor);
    if (result.found && Math.abs(result.delta) <= 0.5) stableFrames += 1;
    else stableFrames = 0;
    frame += 1;
    if (stableFrames >= 2 || frame >= 60) {
      controller.completeSuccess(request, loadedTurns);
      return;
    }
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
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
    const node = scrollRef.current;
    const anchor = node ? captureTranscriptScrollAnchor(node) : undefined;
    const request = controller.beginLoad(anchor);
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
      restoreUntilStable(controller, request, scrollRef, countUserTurns(page.messages));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      controller.completeError(request, `Could not load older turns: ${message}`);
    }
  }, [applyPage, controller, loadPage, scrollRef]);

  return <>
    {showControl ? <TranscriptHistoryControl
      olderCursor={state.olderCursor}
      loading={state.loading}
      status={state.status}
      onLoad={() => void loadOlder()}
    /> : null}
    {children(controller.anchorRef)}
  </>;
}
