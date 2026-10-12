import { errorMessage } from "./error-message";
import type { HostBootstrap } from "../shared/contracts";
import type { HostClient } from "./host-client";
import { followShownThread } from "./shown-thread";
import type { WorkbenchSession } from "./workbench-session";

/**
 * Loads the initial snapshot, retrying failed reads and reconnects until it arrives, then
 * follows the shown thread. Replay cannot replace an initial snapshot that
 * never arrived. Disposing releases both subscriptions and ignores late replies.
 * `onLoaded` runs once, after the first snapshot is on screen.
 */
export function followWorkbenchBootstrap(
  client: Pick<HostClient, "bootstrap" | "onConnectionState" | "watchThread" | "limitPushesToWatched">,
  workbench: Pick<WorkbenchSession, "history" | "threads" | "applyBootstrap">,
  onError: (message: string) => void,
  onLoaded?: (bootstrap: HostBootstrap) => void,
): () => void {
  let disposed = false;
  let loaded = false;
  let loading = false;
  let connected = true;
  let retryDelay = 1_000;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stopFollowing = () => {};
  const load = () => {
    if (disposed || loaded || loading) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    loading = true;
    const request = workbench.history.beginBootstrap();
    client.bootstrap().then((bootstrap) => {
      if (disposed) return;
      loaded = true;
      const applied = workbench.applyBootstrap(bootstrap, request);
      stopFollowing();
      stopFollowing = followShownThread(client, workbench.threads);
      if (applied) onLoaded?.(bootstrap);
    }).catch((error) => {
      if (!disposed && workbench.history.isCurrentBootstrap(request)) onError(errorMessage(error));
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
    connected = state === "connected";
    clearTimeout(retryTimer);
    retryTimer = undefined;
    if (connected) { retryDelay = 1_000; load(); }
  });
  load();
  return () => {
    disposed = true;
    clearTimeout(retryTimer);
    stopRecovery();
    stopFollowing();
  };
}
