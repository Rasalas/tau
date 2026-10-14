import { useSyncExternalStore } from "react";
import type { PullRequestClient } from "./pull-request-client.js";
import { OFFLINE_REASON } from "./pull-request-cache.js";

const noopSubscribe = () => () => undefined;
const online = () => true;

export function useRequestConnection(client?: PullRequestClient): boolean {
  return useSyncExternalStore(client?.cache?.subscribe ?? noopSubscribe, client?.cache?.isConnected ?? online);
}

export function RequestCacheNotice({ client, at }: { client: PullRequestClient; at?: number }) {
  const connected = useRequestConnection(client);
  if (connected && !at) return null;
  return <p className="pr-cache-notice" role="status">
    {at ? <>As of <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleString()}</time>. </> : null}
    {connected ? "Saved on this device." : OFFLINE_REASON}
  </p>;
}
