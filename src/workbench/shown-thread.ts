import type { HostClient } from "./host-client";
import type { ThreadStore } from "./thread-store";

/**
 * Keeps the host sending this client the stream of the thread on screen and
 * no other thread's. Start it once the bootstrap is applied: until then every
 * push arrives, so nothing between the snapshot and the subscription is lost.
 */
export function followShownThread(
  client: Pick<HostClient, "watchThread" | "limitPushesToWatched">,
  threads: Pick<ThreadStore, "getSnapshot" | "subscribe">,
): () => void {
  let shown: string | undefined;
  let release: (() => void) | undefined;
  const sync = () => {
    const active = threads.getSnapshot().activeThreadId;
    // No thread (a new draft on screen) keeps the last one: it may still stream there.
    if (!active || active === shown) return;
    const previous = release;
    release = client.watchThread(active);
    shown = active;
    previous?.();
    client.limitPushesToWatched();
  };
  sync();
  const stop = threads.subscribe(sync);
  return () => {
    stop();
    release?.();
  };
}
