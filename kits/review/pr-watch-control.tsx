import { useRef, useState, useSyncExternalStore } from "react";
import { CircleAlert, Eye, EyeOff } from "lucide-react";
import { Popover, errorMessage, tooltipProps, useCommandAllowed } from "tau";
import type { PullRequestWatchFeed } from "./pr-watch-client.js";
import { useChangeCount } from "./strip-motion.js";
import { watchStanding, type PullRequestWatch } from "./pr-watch-protocol.js";
import type { StripRequest } from "./pull-request-strip-logic.js";

const TRIGGERS = "Wakes when all checks finish or one fails, on new comments or reviews, branch conflicts, or closing. One wake names every watched PR that changed. The watch never merges.";
const startable = (request: StripRequest | undefined) => request?.state === "open" || request?.state === "draft";

interface Row { url: string; number: number; title?: string; request?: StripRequest; watch?: PullRequestWatch }

/** The PRs the popover lists: this one; with `others`, the thread's other open ones and any other PR it watches. */
function watchRows(threadId: string, watches: readonly PullRequestWatch[], request: StripRequest, others: readonly StripRequest[] | undefined): Row[] {
  const own = watches.filter((watch) => watch.threadId === threadId);
  const rows: Row[] = [request, ...others ?? []].flatMap((entry, index) => {
    const watch = own.find((value) => value.ref.url === entry.url);
    if (index > 0 && !startable(entry) && (!watch || watch.status === "ended")) return [];
    return [{ url: entry.url, number: entry.number, request: entry, ...(entry.title ? { title: entry.title } : {}), ...(watch ? { watch } : {}) }];
  });
  if (others) for (const watch of own) if (watch.status !== "ended" && !rows.some((row) => row.url === watch.ref.url)) rows.push({ url: watch.ref.url, number: watch.ref.number, watch });
  return rows;
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const rowState = (watch: PullRequestWatch | undefined) => !watch ? "Not watched" : watch.status === "unreadable" ? "Can't read GitHub" : watch.status === "watching" ? `Watching · ${watchStanding(watch.baseline)}` : "Watch ended";

/**
 * The watch of one PR on its strip row: the first click watches it; then it opens
 * its state with a stop. With `others`, that list also offers the thread's other open PRs.
 */
export function PullRequestWatchControl({ feed, threadId, request, others }: { feed: PullRequestWatchFeed; threadId: string; request: StripRequest; others?: readonly StripRequest[] }) {
  const canManage = useCommandAllowed("tau.review", "watch-start");
  const state = useSyncExternalStore(feed.subscribe, feed.get);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState<string>(), [error, setError] = useState<string>();
  const anchor = useRef<HTMLButtonElement>(null);
  const mine = state.watches.find((value) => value.threadId === threadId && value.ref.url === request.url);
  // The eye blinks when the watch starts and each time it reads the PR.
  const blinks = useChangeCount(mine && mine.status !== "ended" ? mine.lastReadAt ?? mine.startedAt : "off");
  if (request.service !== "github") return null;
  const rows = watchRows(threadId, state.watches, request, others?.filter((other) => other.service === "github"));
  const watch = rows[0]?.watch;
  const live = Boolean(watch && watch.status !== "ended");
  const unreadable = watch?.status === "unreadable";
  const label = unreadable ? "Can't read GitHub" : live ? "Watching" : watch ? "Watch ended" : "Watch for changes";
  const disabled = Boolean(busy) || !canManage || (!live && !startable(request) && !watch);
  const change = async (command: "watch-start" | "watch-stop", url: string) => {
    setBusy(url); setError(undefined);
    try { await feed.change(command, threadId, url); if (rows.length === 1) setOpen(false); }
    catch (failure) { setError(errorMessage(failure)); setOpen(true); }
    finally { setBusy(undefined); }
  };
  const Icon = unreadable ? CircleAlert : live ? Eye : watch ? EyeOff : Eye;
  const tooltip = !canManage ? "This device is read-only." : live ? `#${request.number} · ${rowState(watch)}` : !startable(request) ? "This PR is closed." : TRIGGERS;
  return <><button ref={anchor} type="button" className={`review-pr-watch ${unreadable ? "unreadable" : live ? "watching" : watch?.status ?? "off"}`} aria-label={`${label} for PR #${request.number}`} aria-expanded={open} disabled={disabled} {...tooltipProps(tooltip)} onClick={() => { if (watch || error) setOpen(!open); else void change("watch-start", request.url); }}><Icon key={blinks} size={13} {...(blinks ? { className: "blink" } : {})} />{watch ? <span>{label}</span> : null}</button>
    {open ? <Popover anchor={anchor} label={rows.length > 1 ? "Watched pull requests" : `Watch PR #${request.number}`} align="end" className="review-pr-watch-popover" onClose={() => setOpen(false)}>
      <h3>{rows.length > 1 ? "Watched pull requests" : `Watch PR #${request.number}`}</h3><p>{TRIGGERS}</p>
      <ul className="review-pr-watch-list">{rows.map((row) => {
        const running = row.watch && row.watch.status !== "ended";
        const canStart = row.request ? startable(row.request) : false;
        return <li key={row.url}>
          <div className="review-pr-watch-row-text"><strong>#{row.number}</strong>{row.title ? <span className="review-pr-watch-row-title">{row.title}</span> : null}
            <span>{rowState(row.watch)}</span>
            {row.watch ? <span>{[`${row.watch.wakes} ${row.watch.wakes === 1 ? "wake" : "wakes"}`, ...(row.watch.commentStreak ? [`${row.watch.commentStreak} of 10 comment wakes in a row`] : []), `since ${clock(row.watch.startedAt)}`, ...(row.watch.lastReadAt ? [`read ${clock(row.watch.lastReadAt)}`] : [])].join(" · ")}</span> : null}
            {row.watch?.reason ? <span>{row.watch.reason}</span> : null}</div>
          <button type="button" aria-label={running ? `Stop watching PR #${row.number}` : `Watch PR #${row.number}`} disabled={Boolean(busy) || !canManage || (!running && !canStart)} onClick={() => void change(running ? "watch-stop" : "watch-start", row.url)}>{busy === row.url ? "Working…" : running ? "Stop watching" : row.watch ? "Watch again" : "Watch"}</button>
        </li>;
      })}</ul>
      <p>Checks once a minute. Ends on Stop, Settle, merge or close, ten consecutive comment wakes, or fifteen minutes without a readable host.</p>
      {error || state.error ? <p className="review-pr-watch-error" role="alert">{error ?? state.error}</p> : null}
    </Popover> : null}</>;
}
