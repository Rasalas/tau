import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, type HostExtensionClient } from "tau";
import { GUIDE_EVENT, GUIDE_GET_COMMAND, GUIDE_WRITE_COMMAND, type GuideEvent, type GuideResult, type GuideWriteResult } from "./guide-protocol.js";

export interface GuideWriteInput {
  /** The checkout and thread the request comes from; the run's agent starts from them. */
  cwd?: string;
  threadId?: string;
}

/** Review Kit's host commands for guides, typed. */
export interface GuideClient {
  get(url: string): Promise<GuideResult>;
  write(url: string, input?: GuideWriteInput): Promise<GuideWriteResult>;
  /** Told when a guide or its run changes, for any request. */
  onChanged(listener: (event: GuideEvent) => void): () => void;
}

/** The event's payload when it names a request and a kind; anything else is not ours. */
export function guideEvent(payload: unknown): GuideEvent | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const { url, number, kind } = payload as Partial<GuideEvent>;
  if (typeof url !== "string" || typeof number !== "number") return undefined;
  if (kind !== "running" && kind !== "ready" && kind !== "failed") return undefined;
  return payload as GuideEvent;
}

export function guideClient(host: Pick<HostExtensionClient, "invoke" | "onEvent">): GuideClient {
  return {
    get: (url) => host.invoke(GUIDE_GET_COMMAND, { url }) as Promise<GuideResult>,
    write: (url, input = {}) => host.invoke(GUIDE_WRITE_COMMAND, { url, ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.threadId ? { threadId: input.threadId } : {}) }) as Promise<GuideWriteResult>,
    onChanged: (listener) => host.onEvent(GUIDE_EVENT, (payload) => {
      const event = guideEvent(payload);
      if (event) listener(event);
    }),
  };
}

export interface GuideState {
  result: GuideResult | undefined;
  /** True until the first answer. */
  loading: boolean;
  error: string | undefined;
  /** A run is going, or the request to start one is on its way. */
  running: boolean;
  write(input?: GuideWriteInput): Promise<GuideWriteResult | undefined>;
  /** Reads again, for a read that failed. */
  refresh(): Promise<void>;
}

/**
 * A request's guide: read when the view opens and again whenever the host says the
 * guide or its run changed (a run ends minutes after it started, so nothing polls).
 */
export function useGuide(client: GuideClient | undefined, url: string): GuideState {
  const [result, setResult] = useState<GuideResult>();
  const [loading, setLoading] = useState(Boolean(client));
  const [error, setError] = useState<string>();
  const [writing, setWriting] = useState(false);
  // Only the newest answer counts, and none after the view is gone.
  const revision = useRef(0);

  const read = useCallback(async () => {
    if (!client) return;
    const mine = ++revision.current;
    try {
      const next = await client.get(url);
      if (mine !== revision.current) return;
      setResult(next);
      setError(undefined);
    } catch (reason) {
      if (mine === revision.current) setError(errorMessage(reason));
    } finally {
      if (mine === revision.current) setLoading(false);
    }
  }, [client, url]);

  useEffect(() => {
    if (!client) { setLoading(false); return; }
    setLoading(true);
    void read();
    const off = client.onChanged((event) => { if (event.url === url) void read(); });
    return () => { off(); revision.current += 1; };
  }, [client, read, url]);

  const write = useCallback(async (input?: GuideWriteInput) => {
    if (!client) return undefined;
    setWriting(true);
    setError(undefined);
    try {
      const answer = await client.write(url, input);
      revision.current += 1;
      setResult(answer);
      if (answer.outcome === "failed") setError(answer.detail ?? "The guide could not be written.");
      return answer;
    } catch (reason) {
      setError(errorMessage(reason));
      return undefined;
    } finally {
      setWriting(false);
    }
  }, [client, url]);

  return { result, loading, error, running: writing || result?.run?.state === "running", write, refresh: read };
}
