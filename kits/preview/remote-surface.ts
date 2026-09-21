import { EMPTY_PREVIEW_STATE, type PreviewState } from "./protocol.js";
import type { PreviewRect, PreviewSurface, PreviewSurfaceOptions } from "./host.js";

/** What every call to the window half answers with, so the host stays in step. */
export interface PreviewSnapshot {
  state: PreviewState;
  viewport: { width: number; height: number };
  zoomFactor: number;
  result?: unknown;
}

const EMPTY_SNAPSHOT: PreviewSnapshot = {
  state: { ...EMPTY_PREVIEW_STATE, available: true },
  viewport: { width: 0, height: 0 },
  zoomFactor: 1,
};

/**
 * The browser view, seen from a host that has no window. Every operation is
 * one call into the kit's window half (ADR 0021); its answer carries the state
 * back, so the synchronous parts of `PreviewSurface` read a fresh cache rather
 * than a promise.
 */
export function createRemotePreviewSurface(
  options: PreviewSurfaceOptions,
  call: (command: string, input?: unknown) => Promise<unknown>,
): PreviewSurface {
  let snapshot = EMPTY_SNAPSHOT;
  const apply = (answer: unknown): PreviewSnapshot => {
    const next = answer as Partial<PreviewSnapshot> | undefined;
    if (next?.state) snapshot = { ...EMPTY_SNAPSHOT, ...next, state: next.state };
    return snapshot;
  };
  const run = async (command: string, input?: unknown): Promise<unknown> => {
    const answer = apply(await call(command, input));
    return answer.result;
  };
  // Fire and forget, for the members of the interface that answer nothing.
  const send = (command: string, input?: unknown): void => {
    void call(command, input)
      .then(apply)
      .then(() => options.onChange())
      .catch((error: unknown) => options.log("preview.remote.failed", `${command}: ${String(error)}`));
  };

  return {
    accept: (next: PreviewSnapshot) => { apply(next); },
    zoomFactor: () => snapshot.zoomFactor,
    place: (rect: PreviewRect, visible: boolean) => send("place", { rect, visible }),
    load: async (url: string, timeoutMs: number) => { await run("load", { url, timeoutMs }); },
    navigate: (action) => send("navigate", { action }),
    state: () => snapshot.state,
    viewport: () => snapshot.viewport,
    evaluate: (expression: string) => run("evaluate", { expression }),
    capture: async (maxWidth: number) => await run("capture", { maxWidth }) as { base64: string; width: number; height: number },
    pressKey: (key: string) => send("press-key", { key }),
    destroy: () => send("destroy"),
  };
}
