import { useCallback, useEffect, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import type { TranscriptPage } from "../../shared/host-protocol";
import type { HostTranscriptCursor } from "../../shared/transcript-cursor";
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
  loadPage: (sessionId: string, cursor: HostTranscriptCursor) => Promise<TranscriptPage>;
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

  // A successful page load is not the end of layout work: images, fonts,
  // markdown blocks, and deferred virtualizer measurements can still change a
  // row above the anchor. Keep observing the actual anchor and virtual list
  // until the user, a thread switch, or another paging lifecycle releases it.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !controller.anchorRef.current || typeof ResizeObserver === "undefined") return;
    let frame: number | undefined;
    const restore = () => {
      frame = undefined;
      const anchor = controller.anchorRef.current;
      if (!anchor || !controller.preserveScrollRef.current) return;
      restoreTranscriptScrollAnchor(node, anchor);
    };
    const schedule = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(restore);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(node.querySelector<HTMLElement>(".virtual-transcript") ?? node);
    const anchorRow = Array.from(node.querySelectorAll<HTMLElement>("[data-message-id]"))
      .find((row) => row.dataset.messageId === controller.anchorRef.current?.messageId);
    if (anchorRow) observer.observe(anchorRow);
    // Correct once after attaching as well: a deferred measurement may have
    // landed between the request's final RAF and this observer lifecycle.
    schedule();
    return () => {
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [controller, scrollRef, state.loading, state.olderCursor, state.status]);

  // Scroll events cannot reliably distinguish a programmatic correction from
  // user intent. Explicit input events can, and terminate the pinning lease.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !controller.anchorRef.current) return;
    const release = () => controller.releaseAnchor();
    node.addEventListener("pointerdown", release, { passive: true });
    node.addEventListener("wheel", release, { passive: true });
    node.addEventListener("touchstart", release, { passive: true });
    node.addEventListener("keydown", release);
    return () => {
      node.removeEventListener("pointerdown", release);
      node.removeEventListener("wheel", release);
      node.removeEventListener("touchstart", release);
      node.removeEventListener("keydown", release);
    };
  }, [controller, scrollRef, state.loading, state.olderCursor, state.status]);

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
      historyCompleteness={state.historyCompleteness}
      loading={state.loading}
      status={state.status}
      onLoad={() => void loadOlder()}
    /> : null}
    {children(controller.anchorRef)}
  </>;
}
