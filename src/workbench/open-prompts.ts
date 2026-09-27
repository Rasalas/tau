import type { HostClient } from "./host-client";
import type { HostConnectionState } from "./host-connection";
import type { ThreadViewStore } from "./thread-view-store";

/**
 * Keeps this client's questions on the host's open set, at start and each time
 * the link comes back: a question answered on another device while this one
 * was away left no event here. Only questions held before the call can be
 * dropped, so one asked while the answer travels stays.
 */
export function followOpenPrompts(
  client: Pick<HostClient, "syncExtensionUi" | "onConnectionState" | "getConnectionState">,
  view: Pick<ThreadViewStore, "getUiPrompts" | "retainOpenPrompts">,
): () => void {
  let stopped = false;
  const sync = () => {
    const known = new Set(view.getUiPrompts().map((prompt) => prompt.id));
    client.syncExtensionUi().then((open) => {
      // A host from before the open set answers nothing; its events still hold.
      if (!stopped && Array.isArray(open)) view.retainOpenPrompts(open, known);
    }).catch(() => undefined);
  };
  let previous: HostConnectionState = client.getConnectionState();
  const stop = client.onConnectionState((state) => {
    if (state === "connected" && previous !== "connected") sync();
    previous = state;
  });
  sync();
  return () => {
    stopped = true;
    stop();
  };
}
