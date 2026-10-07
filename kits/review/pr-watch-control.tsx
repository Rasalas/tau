import { useRef, useState, useSyncExternalStore } from "react";
import { CircleAlert, Eye, EyeOff } from "lucide-react";
import { Popover, errorMessage, tooltipProps, useCommandAllowed } from "tau";
import type { PullRequestWatchFeed } from "./pr-watch-client.js";
import type { StripRequest } from "./pull-request-strip-logic.js";
/** One segment: click starts a watch; while watching, it opens the state and its one stop action. */
export function PullRequestWatchControl({ feed, threadId, request }: { feed: PullRequestWatchFeed; threadId: string; request: StripRequest }) {
  const canManage = useCommandAllowed("tau.review", "watch-start");
  const state = useSyncExternalStore(feed.subscribe, feed.get);
  const watch = state.watches.find((value) => value.threadId === threadId && value.ref.url === request.url);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const anchor = useRef<HTMLButtonElement>(null);
  if (request.service !== "github") return null;
  const running = watch && watch.status !== "ended";
  const canStart = request.state === "open" || request.state === "draft";
  const disabled = busy || !canManage || (!running && !canStart && !watch);
  const label = watch?.status === "unreadable" ? "Can't read GitHub" : running ? `Watching · ${watch.wakes}` : watch ? "Watch ended" : "Watch for changes";
  const change = async (command: "watch-start" | "watch-stop") => {
    setBusy(true); setError(undefined);
    try { await feed.change(command, threadId, request.url); setOpen(false); }
    catch (failure) { setError(errorMessage(failure)); setOpen(true); }
    finally { setBusy(false); }
  };
  const Icon = watch?.status === "unreadable" ? CircleAlert : running ? Eye : watch ? EyeOff : Eye;
  return <><button ref={anchor} type="button" className={`review-pr-watch ${watch?.status ?? "off"}`} aria-label={`${label} for PR #${request.number}`} aria-expanded={open} disabled={disabled} {...tooltipProps(!canManage ? "This device is read-only." : !canStart && !running ? "This PR is closed." : "Wakes after checks finish, comments or reviews, branch conflicts, or closing. Merging stays with you.")} onClick={() => { if (running || watch || error) setOpen(!open); else void change("watch-start"); }}><Icon size={13} />{watch ? <span>{label}</span> : null}</button>
    {open ? <Popover anchor={anchor} label={`Watch PR #${request.number}`} align="end" className="review-pr-watch-popover" onClose={() => setOpen(false)}>
      <h3>Watch PR #{request.number}</h3><p>Wakes after checks finish, new comments or reviews, branch conflicts, or closing. Merging stays with you.</p>
      {watch ? <><p>{watch.wakes} wakes · {watch.commentStreak} of 10 consecutive comment wakes</p><p>Since {new Date(watch.startedAt).toLocaleString()}{watch.lastReadAt ? ` · Last read ${new Date(watch.lastReadAt).toLocaleTimeString()}` : ""}</p>{watch.reason ? <p>{watch.reason}</p> : null}</> : null}
      <p>Checks once a minute. Ends on Stop, Settle, merge or close, ten consecutive comment wakes, or fifteen minutes without a readable host.</p>
      {error || state.error ? <p className="review-pr-watch-error" role="alert">{error ?? state.error}</p> : null}
      <button type="button" disabled={busy || !canManage || (!running && !canStart)} onClick={() => void change(running ? "watch-stop" : "watch-start")}>{busy ? "Working…" : running ? "Stop watching" : "Watch again"}</button>
    </Popover> : null}</>;
}
