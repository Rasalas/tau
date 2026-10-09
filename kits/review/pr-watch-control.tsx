import { useRef, useState, useSyncExternalStore } from "react";
import { CircleAlert, Eye, EyeOff } from "lucide-react";
import { Popover, errorMessage, tooltipProps, useCommandAllowed } from "tau";
import type { PullRequestWatchFeed } from "./pr-watch-client.js";
import { watchStanding, type PullRequestWatch } from "./pr-watch-protocol.js";
import type { StripRequest } from "./pull-request-strip-logic.js";

const TRIGGERS = "Wakes when all checks finish or one fails, on new comments or reviews, branch conflicts, or closing. One wake names every watched PR that changed. The watch never merges.";
const startable = (request: StripRequest | undefined) => request?.state === "open" || request?.state === "draft";

interface Row { url: string; number: number; title?: string; request?: StripRequest; watch?: PullRequestWatch }

/** The thread's PRs the popover lists: the strip's open ones, then any other PR the thread watches. */
function watchRows(threadId: string, watches: readonly PullRequestWatch[], requests: readonly StripRequest[]): Row[] {
  const own = watches.filter((watch) => watch.threadId === threadId);
  const rows: Row[] = requests.flatMap((request, index) => {
    const watch = own.find((value) => value.ref.url === request.url);
    if (index > 0 && !startable(request) && (!watch || watch.status === "ended")) return [];
    return [{ url: request.url, number: request.number, request, ...(request.title ? { title: request.title } : {}), ...(watch ? { watch } : {}) }];
  });
  for (const watch of own) if (watch.status !== "ended" && !rows.some((row) => row.url === watch.ref.url)) rows.push({ url: watch.ref.url, number: watch.ref.number, watch });
  return rows;
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const rowState = (watch: PullRequestWatch | undefined) => !watch ? "Not watched" : watch.status === "unreadable" ? "Can't read GitHub" : watch.status === "watching" ? `Watching · ${watchStanding(watch.baseline)}` : "Watch ended";

/** One segment for every PR the thread watches: the first click watches the strip's PR; then it opens the list with a stop per PR. */
export function PullRequestWatchControl({ feed, threadId, request, others = [] }: { feed: PullRequestWatchFeed; threadId: string; request: StripRequest; others?: readonly StripRequest[] }) {
  const canManage = useCommandAllowed("tau.review", "watch-start");
  const state = useSyncExternalStore(feed.subscribe, feed.get);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState<string>(), [error, setError] = useState<string>();
  const anchor = useRef<HTMLButtonElement>(null);
  if (request.service !== "github") return null;
  const rows = watchRows(threadId, state.watches, [request, ...others.filter((other) => other.service === "github")]);
  const running = rows.filter((row) => row.watch && row.watch.status !== "ended");
  const watch = rows[0]?.watch;
  const unreadable = running.some((row) => row.watch?.status === "unreadable");
  const label = running.length > 1 ? `Watching ${running.length}` : unreadable ? "Can't read GitHub" : running[0] ? (running[0].url === request.url ? "Watching" : `Watching #${running[0].number}`) : watch ? "Watch ended" : "Watch for changes";
  const disabled = Boolean(busy) || !canManage || (!running.length && !startable(request) && !watch);
  const change = async (command: "watch-start" | "watch-stop", url: string) => {
    setBusy(url); setError(undefined);
    try { await feed.change(command, threadId, url); if (rows.length === 1) setOpen(false); }
    catch (failure) { setError(errorMessage(failure)); setOpen(true); }
    finally { setBusy(undefined); }
  };
  const Icon = unreadable ? CircleAlert : running.length ? Eye : watch ? EyeOff : Eye;
  const tooltip = !canManage ? "This device is read-only." : running.length ? running.map((row) => `#${row.number} · ${rowState(row.watch)}`).join("\n") : !startable(request) ? "This PR is closed." : TRIGGERS;
  return <><button ref={anchor} type="button" className={`review-pr-watch ${unreadable ? "unreadable" : running.length ? "watching" : watch?.status ?? "off"}`} aria-label={`${label} for PR #${request.number}`} aria-expanded={open} disabled={disabled} {...tooltipProps(tooltip, running.length > 1 ? { variant: "lines" } : undefined)} onClick={() => { if (running.length || watch || error) setOpen(!open); else void change("watch-start", request.url); }}><Icon size={13} />{running.length || watch ? <span>{label}</span> : null}</button>
    {open ? <Popover anchor={anchor} label={rows.length > 1 ? "Watched pull requests" : `Watch PR #${request.number}`} align="end" className="review-pr-watch-popover" onClose={() => setOpen(false)}>
      <h3>{rows.length > 1 ? "Watched pull requests" : `Watch PR #${request.number}`}</h3><p>{TRIGGERS}</p>
      <ul className="review-pr-watch-list">{rows.map((row) => {
        const live = row.watch && row.watch.status !== "ended";
        const canStart = row.request ? startable(row.request) : false;
        return <li key={row.url}>
          <div className="review-pr-watch-row-text"><strong>#{row.number}</strong>{row.title ? <span className="review-pr-watch-row-title">{row.title}</span> : null}
            <span>{rowState(row.watch)}</span>
            {row.watch ? <span>{[`${row.watch.wakes} ${row.watch.wakes === 1 ? "wake" : "wakes"}`, ...(row.watch.commentStreak ? [`${row.watch.commentStreak} of 10 comment wakes in a row`] : []), `since ${clock(row.watch.startedAt)}`, ...(row.watch.lastReadAt ? [`read ${clock(row.watch.lastReadAt)}`] : [])].join(" · ")}</span> : null}
            {row.watch?.reason ? <span>{row.watch.reason}</span> : null}</div>
          <button type="button" aria-label={live ? `Stop watching PR #${row.number}` : `Watch PR #${row.number}`} disabled={Boolean(busy) || !canManage || (!live && !canStart)} onClick={() => void change(live ? "watch-stop" : "watch-start", row.url)}>{busy === row.url ? "Working…" : live ? "Stop watching" : row.watch ? "Watch again" : "Watch"}</button>
        </li>;
      })}</ul>
      <p>Checks once a minute. Ends on Stop, Settle, merge or close, ten consecutive comment wakes, or fifteen minutes without a readable host.</p>
      {error || state.error ? <p className="review-pr-watch-error" role="alert">{error ?? state.error}</p> : null}
    </Popover> : null}</>;
}
