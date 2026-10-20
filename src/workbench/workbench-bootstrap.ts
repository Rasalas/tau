import { errorMessage } from "./error-message";
import type { HostBootstrap } from "../shared/contracts";
import { HOST_PROTOCOL_VERSION } from "../shared/host-protocol";
import { HOST_ERROR } from "../shared/host-transport";
import { threadDetailFromPage } from "./app-state";
import { isConnectionDropped } from "../shared/connection-dropped-error";
import type { HostClient } from "./host-client";
import { followShownThread } from "./shown-thread";
import type { WorkbenchSession } from "./workbench-session";

/**
 * Loads the initial snapshot, retrying failed reads and reconnects until it arrives, then
 * follows the shown thread. Replay cannot replace an initial snapshot that
 * never arrived. Disposing releases both subscriptions and ignores late replies.
 * A snapshot that loses to a navigation is read again. After the first one, the
 * host's thread (shared by every client) no longer replaces the window's own:
 * the bootstrap brings the index and the window reads its thread's latest page.
 * `onLoaded` runs after an accepted initial or reconnect snapshot is on screen.
 */
export function followWorkbenchBootstrap(
  client: Pick<HostClient, "bootstrap" | "loadTranscript" | "onConnectionState" | "watchThread" | "limitPushesToWatched">,
  workbench: Pick<WorkbenchSession, "history" | "threads" | "applyBootstrap" | "applyThreadIndex" | "applyActionResult">,
  onError: (message: string) => void,
  onLoaded?: (bootstrap: HostBootstrap) => void,
): () => void {
  let disposed = false;
  let loaded = false;
  let settled = false;
  let loading = false;
  let connected = true;
  let connectionGeneration = 0;
  let retryDelay = 1_000;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stopFollowing = () => {};
  const load = () => {
    if (disposed || loaded || loading) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    loading = true;
    const generation = connectionGeneration;
    const request = workbench.history.beginBootstrap();
    const stale = () => disposed || !connected || generation !== connectionGeneration;
    client.bootstrap().then(async (bootstrap) => {
      if (stale()) return;
      const active = settled ? workbench.threads.getSnapshot().activeThreadId : "";
      const shown = active && active !== bootstrap.detail.sessionId ? active : "";
      if (shown) workbench.applyThreadIndex(bootstrap.threadIndex);
      const thread = shown ? workbench.threads.getThread(shown) : undefined;
      let applied: boolean;
      if (thread) {
        // Read, never switched to: the host's active thread is every client's. A navigation under way brings its own detail.
        const page = workbench.history.acceptsDetail(shown) ? await client.loadTranscript(shown) : undefined;
        if (stale()) return;
        const detail = page && { ...threadDetailFromPage(page, thread), isStreaming: Boolean(bootstrap.threadIndex.runs?.[shown]) };
        applied = Boolean(detail && workbench.history.acceptsDetail(shown)
          && workbench.applyActionResult({ version: HOST_PROTOCOL_VERSION, updates: [{ version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail }] }));
      } else {
        applied = workbench.applyBootstrap(bootstrap, request);
        settled = true;
        if (!applied) return;
      }
      loaded = true;
      stopFollowing();
      stopFollowing = followShownThread(client, workbench.threads);
      if (applied) onLoaded?.(bootstrap);
    }).catch((error) => {
      // This read retries by itself. Timeouts and an old connection's late
      // failures belong to recovery, rather than the user's notification stack.
      const timeout = error instanceof Error && "code" in error && error.code === HOST_ERROR.timeout;
      if (!disposed && connected && generation === connectionGeneration && !timeout && !isConnectionDropped(error)
        && workbench.history.isCurrentBootstrap(request)) onError(errorMessage(error));
    }).finally(() => {
      loading = false;
      // A timeout does not close a healthy connection, and reconnect can
      // arrive before the old request rejects. Both need another initial read.
      if (disposed || loaded || !connected) return;
      retryTimer = setTimeout(load, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 10_000);
    });
  };
  const stopRecovery = client.onConnectionState((state) => {
    if (state === "connected" && connected) return;
    connectionGeneration += 1;
    connected = state === "connected";
    clearTimeout(retryTimer);
    retryTimer = undefined;
    if (connected) { retryDelay = 1_000; load(); }
    else loaded = false;
  });
  load();
  return () => {
    disposed = true;
    clearTimeout(retryTimer);
    stopRecovery();
    stopFollowing();
  };
}
