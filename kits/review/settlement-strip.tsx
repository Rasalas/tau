import { useEffect, useSyncExternalStore } from "react";
import { CircleCheck } from "lucide-react";
import { useHostCapabilities } from "tau";
import type { SettlementSource } from "./settlement.js";
const noSubscribe = () => () => undefined;
const empty = () => undefined;

export function SettlementStrip({ source, threadId }: { source?: SettlementSource; threadId: string }) {
  const service = useSyncExternalStore(source?.subscribe ?? noSubscribe, source?.getSnapshot ?? empty);
  const meta = useSyncExternalStore(service?.subscribe ?? noSubscribe, () => service?.get(threadId));
  const settled = meta?.settledAt !== undefined;
  const { readOnly } = useHostCapabilities();
  useEffect(() => settled ? service?.claimNote(threadId) : undefined, [service, threadId, settled]);
  if (!settled) return null;
  const reason = meta?.settledBy === "pr-merged" ? "merged" : meta?.settledBy === "pr-closed" ? "closed" : undefined;
  const urls = reason ? (meta?.settledForRequest ?? "").split(" ").filter((url) => /^https?:\/\//u.test(url)) : [];
  return <div className="review-pr-strip review-settlement-strip" role="status">
    <CircleCheck size={14} aria-hidden />
    <span>Settled{urls.length ? <> · {urls.map((url, index) => <span key={url}>{index ? ", " : ""}<a href={url} target="_blank" rel="noreferrer noopener">PR #{url.split("/").at(-1)}</a> {reason}</span>)}</> : meta?.settledBy === "inactive" ? " after inactivity" : ""}</span>
    {!readOnly ? <button type="button" className="review-pr-strip-reopen" onClick={() => service?.reopen(threadId)}>Reopen</button> : null}
  </div>;
}
