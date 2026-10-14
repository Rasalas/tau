import { SettlementStrip } from "./settlement-strip.js";
import type { SettlementSource } from "./settlement.js";
import { PublicationStrip } from "./publication-strip.js";
import { PullRequestWatchControl } from "./pr-watch-control.js";
import type { PullRequestWatchFeed } from "./pr-watch-client.js";
import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { CircleAlert, CircleCheck, CircleDashed, CircleX, X } from "lucide-react";
import { getClientStorage, tooltipProps, type DesktopExtensionContext, type RegionProps, type WorkbenchActions } from "tau";
import { REVIEW_HOST_EXTENSION_ID, providerInfo, type PullRequestCheck, type ThreadPullRequestLink } from "./protocol.js";
import { checksPipelines } from "./pipeline.js";
import { PipelineMini, usePipelineFacts } from "./pipeline-view.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { checksRollup, checksSummary, checksUnfinished } from "./pull-request-logic.js";
import { RequestStateIcon } from "./request-state-icon.js";
import { openPullRequest, openThreadPullRequests } from "./pull-request-open.js";
import { STRIP_OPTION, StripDismissals, checksPulse, stripRequests, watchTally, watchedRequests, type StripRequest, type StripState, type WatchTone } from "./pull-request-strip-logic.js";
import type { PullRequestWatch } from "./pr-watch-protocol.js";
import { useChangeCount, usePresence, type Presence } from "./strip-motion.js";
import { useRequestLifecycle } from "./request-lifecycle.js";
import { checksLabel, checksTone, type RowRequests } from "./requests.js";
import { ServiceIcon } from "./service-icon.js";
import type { ThreadLinkRows } from "./thread-links-store.js";
import { useRequestPopover } from "./request-popover.js";

export interface StripParts {
  settlement?: SettlementSource;
  watches?: PullRequestWatchFeed;
  rows: RowRequests;
  links: ThreadLinkRows;
  preferences: DesktopExtensionContext["preferences"];
  dismissals?: StripDismissals;
  /** Reads the checks for the mini pipeline; without it the chip shows the row's counts. */
  client?: PullRequestClient;
  host?: DesktopExtensionContext["host"];
}

/** As often as the open request's view asks while checks run. */
const LIVE_MS = 20_000;

const STATE_WORDS: Record<StripState, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };
const shared = { dismissals: undefined as StripDismissals | undefined };
const noFeed = () => () => undefined;
const NO_WATCHES = { watches: [] as PullRequestWatch[], loaded: true };
const noWatches = () => NO_WATCHES;


function ChecksIcon({ tone }: { tone: "passed" | "failed" | "pending" }) {
  const props = { size: 13, "aria-hidden": true } as const;
  if (tone === "passed") return <CircleCheck {...props} />;
  if (tone === "failed") return <CircleX {...props} />;
  return <CircleDashed {...props} />;
}

/** Reads a finished pipeline is shown from, so switching threads asks nothing new. */
const FINISHED_MS = 5 * 60_000;
const seen = new WeakMap<PullRequestClient, Map<string, { at: number; revision: string; checks: PullRequestCheck[] }>>();

/**
 * The request's checks: read once, then while the last answer still had some
 * running and the window is visible, and again whenever its pulse changes (a
 * push, new counts, its watch's last read). The previous answer stays on the
 * chip while the next one loads.
 */
function useLiveChecks(client: PullRequestClient | undefined, request: StripRequest, revision: string): PullRequestCheck[] | undefined {
  const { url, checks: counted } = request;
  const pending = Boolean(counted?.pending);
  const [read, setRead] = useState<{ client: PullRequestClient; url: string; checks: PullRequestCheck[] }>();
  useEffect(() => {
    if (!client) return;
    let cache = seen.get(client);
    if (!cache) { cache = new Map(); seen.set(client, cache); }
    const known = cache.get(url);
    if (known?.revision === revision) setRead({ client, url, checks: known.checks });
    if (known?.revision === revision && !pending && !checksUnfinished(known.checks) && Date.now() - known.at < FINISHED_MS) return;
    let live = true;
    let reading = false;
    let timer = 0;
    const ask = () => {
      if (reading) return;
      reading = true;
      client.checks(url).then((checks) => {
        if (!live) return;
        cache.set(url, { at: Date.now(), revision, checks });
        setRead({ client, url, checks });
        if (!checksUnfinished(checks)) window.clearInterval(timer);
      }, () => undefined).finally(() => { reading = false; });
    };
    ask();
    timer = window.setInterval(() => { if (document.visibilityState === "visible") ask(); }, LIVE_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [client, url, pending, revision]);
  return read && read.client === client && read.url === url ? read.checks : undefined;
}

const TONES = { failing: "failed", pending: "pending", passing: "passed" } as const;

function StripChecks({ request, watch, client, open }: { request: StripRequest; watch?: PullRequestWatch; client: PullRequestClient | undefined; open(): void }) {
  const counted = checksTone(request.checks);
  const live = useLiveChecks(client, request, checksPulse(request, watch));
  const facts = usePipelineFacts(client, request.url, live ?? []);
  const rollup = live ? checksRollup(live) : undefined;
  const tone = rollup ? TONES[rollup] : counted;
  // A changed outcome pops the chip once, ringed in its new colour.
  const settles = useChangeCount(tone);
  const motion = settles ? { key: settles, "data-tone": tone } : {};
  if (live?.length) return <span className={`review-pr-strip-checks${settles ? " settled" : ""}`} {...motion}><PipelineMini pipelines={checksPipelines(live, facts)} size={16} nested onOpen={open} /></span>;
  if (!tone) return null;
  return <span className={`review-pr-strip-checks ${tone}${settles ? " settled" : ""}`} {...motion} {...tooltipProps(`Checks: ${live ? checksSummary(live) : checksLabel(request.checks)}`)}><ChecksIcon tone={tone} /></span>;
}

function MoreLinkedRequests({ linked, primary, shown, threadId, workspace, actions }: {
  linked: readonly ThreadPullRequestLink[];
  primary: StripRequest;
  /** Links already drawn as watched rows; +N counts the rest. */
  shown: number;
  threadId: string;
  workspace?: string;
  actions: WorkbenchActions;
}) {
  const entries = linked.map((entry) => entry.url === primary.url ? { ...entry, state: primary.state, title: primary.title ?? entry.title, headRef: primary.headRef ?? entry.headRef } : entry);
  const { anchor, close, triggerProps, popover } = useRequestPopover<HTMLButtonElement>(entries, { threadId, workspace, side: "top", align: "end" });
  return <><button type="button" ref={anchor} className="review-pr-strip-more" aria-label={`View all ${entries.length} linked requests`} {...triggerProps}
    onClick={() => { close(); openThreadPullRequests(actions, threadId, workspace); }}>+{entries.length - 1 - shown}</button>{popover}</>;
}

/** Watched rows shown under the first before the rest fold into "N more watched". */
const SHOWN_WATCHED = 3;
/** How long a row takes to fold away; `--motion` in the stylesheet. */
const LEAVE_MS = 180;
const TALLY_WORDS: Record<WatchTone, string> = { failed: "failed", unreadable: "unreadable", pending: "running", passed: "passed" };

/** "4 more watched" and where the folded ones stand, so a failure under the fold still shows. */
function FoldedWatches({ watches, onOpen }: { watches: readonly PullRequestWatch[]; onOpen(): void }) {
  const tally = watchTally(watches);
  const words = tally.map(({ tone, count }) => `${count} ${TALLY_WORDS[tone]}`).join(", ");
  return <button type="button" className={`review-pr-strips-fold${tally[0]?.tone === "failed" ? " failed" : ""}`} aria-expanded={false}
    aria-label={`${watches.length} more watched${words ? `: ${words}` : ""}`} onClick={onOpen}>
    <span>{watches.length} more watched</span>
    {tally.map(({ tone, count }) => <span key={tone} className={`review-pr-strips-tally ${tone}`}>
      {tone === "unreadable" ? <CircleAlert size={12} aria-hidden="true" /> : <ChecksIcon tone={tone} />}{count}
    </span>)}
  </button>;
}

/** One request's line: state, number, title and live checks; a click opens its tab, the chip its checks. */
function StripRow({ request, watch, client, actions, cwd, label, motion, children }: {
  request: StripRequest;
  /** A watched row that just came or is folding away. */
  motion?: Pick<Presence<unknown>, "state" | "order">;
  watch?: PullRequestWatch;
  client?: PullRequestClient;
  actions: WorkbenchActions;
  cwd?: string;
  label: string;
  children?: ReactNode;
}) {
  const info = providerInfo(request.service);
  const where = request.repo ? `${request.host ? `${request.host}/` : ""}${request.repo}` : undefined;
  const open = (focus?: "checks") => openPullRequest(actions, { url: request.url, number: request.number, provider: request.service }, cwd, focus);
  const leaving = motion?.state === "leaving";
  return <div className={`review-pr-strip state-${request.state}${motion && motion.state !== "settled" ? ` ${motion.state}` : ""}`}
    {...(motion?.state === "arriving" ? { style: { "--arrive": motion.order } as CSSProperties } : {})} {...(leaving ? { inert: true, "aria-hidden": true } : {})}>
    <button type="button" className="review-pr-strip-open" aria-label={label} onClick={() => open()}>
      <RequestStateIcon state={request.state} size={14} className="review-pr-strip-glyph" />
      <span className="review-pr-strip-number" {...tooltipProps(request.title)}>{info.sign}{request.number}</span>
      <span className="review-pr-strip-service" {...tooltipProps(where ? `${info.name} · ${where}` : info.name)}><ServiceIcon service={request.service} /></span>
      <span className="review-pr-strip-title">{request.title ?? request.repo}</span>
      <span className="review-pr-strip-state">{STATE_WORDS[request.state]}</span>
      <span className="review-pr-strip-fill" />
      {request.state === "open" || request.state === "draft" ? <StripChecks request={request} watch={watch} client={client} open={() => open("checks")} /> : null}
    </button>
    {children}
  </div>;
}

/** What a screen reader hears for a row's open button. */
function rowLabel(request: StripRequest, more: number): string {
  const info = providerInfo(request.service);
  const checks = request.state === "open" && checksTone(request.checks) ? checksLabel(request.checks) : undefined;
  return [
    `Open ${info.noun} ${info.sign}${request.number}${request.repo ? ` in ${request.repo}` : ""} on ${info.name}, ${STATE_WORDS[request.state].toLowerCase()}`,
    checks ? `checks ${checks}` : "",
    more > 0 ? `${more} more linked` : "",
    request.title ?? "",
  ].filter(Boolean).join(", ");
}

/**
 * The thread's pull or merge request over the composer: number, repository,
 * branch and state, tinted by the state, and under it a row for every other
 * request the thread watches. Reads what the rail row already asked for (the
 * branch's request, the thread's links); a click opens its tab.
 */
export default function PullRequestStrip({ snapshot, actions, parts }: RegionProps & { parts: StripParts }) {
  const { rows, links, preferences } = parts;
  const dismissals = parts.dismissals ?? (shared.dismissals ??= new StripDismissals(getClientStorage));
  useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  useSyncExternalStore(dismissals.subscribe, dismissals.getVersion);
  const thread = actions.activeThread();
  // A new thread's draft names no thread; its checkout's request is not its own yet.
  const threadId = thread?.sessionId;
  const cwd = thread?.cwd ?? snapshot?.cwd;
  // Without a branch label the checkout is no Git branch; the rail row skips it too.
  const tracked = Boolean(snapshot?.projectLabel && cwd);
  const branch = useSyncExternalStore(rows.subscribe, () => (tracked && cwd ? rows.get(cwd) : undefined));
  const linked = useSyncExternalStore(links.subscribe, () => links.get(threadId));
  const watchState = useSyncExternalStore(parts.watches?.subscribe ?? noFeed, parts.watches?.get ?? noWatches);
  // Folded again on another thread.
  const [unfoldedFor, setUnfoldedFor] = useState<string>();
  const eligible = preferences.optionValue(REVIEW_HOST_EXTENSION_ID, STRIP_OPTION, true) !== false
    && Boolean(threadId && !thread?.draftPending && (snapshot?.isStreaming || (snapshot?.messages?.length ?? 0) > 0));
  const found = stripRequests(linked.some((entry) => entry.url === branch?.url) ? branch : undefined, linked);
  const dismissed = Boolean(found && threadId && dismissals.isHidden(threadId, found.primary));
  const watching = eligible && !dismissed;
  useRequestLifecycle(rows, links, watching && tracked ? cwd : undefined, watching ? threadId : undefined);
  useEffect(() => { if (watching && tracked && cwd) rows.ensure(cwd); }, [watching, tracked, cwd, snapshot?.projectLabel]);
  useEffect(() => { if (watching && threadId) links.ensure(threadId); }, [watching, threadId]);
  const watched = found && threadId ? watchedRequests(found.primary, found.others, watchState.watches, threadId) : [];
  const unfolded = unfoldedFor === threadId;
  const shown = unfolded ? watched : watched.slice(0, SHOWN_WATCHED);
  // Rows count as arriving only once the thread's links and watches were read; before, they are loading.
  const ready = Boolean(threadId && links.has(threadId) && watchState.loaded);
  const present = usePresence(shown, (entry) => entry.request.url, ready ? threadId! : "", LEAVE_MS);

  const settledNote = threadId ? <SettlementStrip source={parts.settlement} threadId={threadId} /> : null;
  if (!watching || !threadId) return settledNote;
  if (!found) return <div className="review-thread-outcome"><PublicationStrip host={parts.host} threadId={threadId} streaming={Boolean(snapshot?.isStreaming)} />{settledNote}</div>;
  const { primary, others } = found;
  const info = providerInfo(primary.service);
  const own = watchState.watches.find((watch) => watch.threadId === threadId && watch.ref.url === primary.url);
  const drawn = shown.filter(({ request }) => others.includes(request)).length;
  const row = ({ item: { request, watch }, key, state, order }: Presence<(typeof watched)[number]>) => <StripRow key={key} request={request} watch={watch} client={parts.client} actions={actions} cwd={cwd} label={rowLabel(request, 0)} motion={{ state, order }}>
    {parts.watches ? <PullRequestWatchControl feed={parts.watches} threadId={threadId} request={request} /> : null}
    {/* Keeps the watch under the first row's, which has × after it. */}
    <span className="review-pr-strip-hide" aria-hidden="true" />
  </StripRow>;
  return (
    <div className="review-thread-outcome"><div className="review-pr-strips" role="group" aria-label={watched.length ? `${watched.length + 1} pull requests` : undefined}>
      <StripRow request={primary} watch={own} client={parts.client} actions={actions} cwd={cwd} label={rowLabel(primary, others.length - drawn)}>
        {others.length > drawn ? <MoreLinkedRequests key={threadId} linked={linked} primary={primary} shown={drawn} threadId={threadId} workspace={cwd} actions={actions} /> : null}
        {parts.watches ? <PullRequestWatchControl feed={parts.watches} threadId={threadId} request={primary} others={others} /> : null}
        <button type="button" className="review-pr-strip-hide" aria-label={`Hide ${info.short} ${info.sign}${primary.number} for this thread`} {...tooltipProps("Hide for this thread")}
          onClick={() => dismissals.hide(threadId, primary)}>
          <X size={14} aria-hidden="true" />
        </button>
      </StripRow>
      {present.filter(({ slot }) => slot < SHOWN_WATCHED).map(row)}
      {/* Unfolded, the rest scrolls past five rows instead of pushing the conversation up. */}
      {present.some(({ slot }) => slot >= SHOWN_WATCHED) ? <div className="review-pr-strips-scroll">{present.filter(({ slot }) => slot >= SHOWN_WATCHED).map(row)}</div> : null}
      {watched.length > SHOWN_WATCHED ? unfolded
        ? <button type="button" className="review-pr-strips-fold" aria-expanded={true} onClick={() => setUnfoldedFor(undefined)}>Show fewer</button>
        : <FoldedWatches watches={watched.slice(SHOWN_WATCHED).map(({ watch }) => watch)} onOpen={() => setUnfoldedFor(threadId)} /> : null}
    </div>{settledNote}</div>
  );
}
