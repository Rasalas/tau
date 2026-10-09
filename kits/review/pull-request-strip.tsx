import { SettlementStrip } from "./settlement-strip.js";
import type { SettlementSource } from "./settlement.js";
import { PublicationStrip } from "./publication-strip.js";
import { PullRequestWatchControl } from "./pr-watch-control.js";
import type { PullRequestWatchFeed } from "./pr-watch-client.js";
import type { WatchState } from "./pr-watch-protocol.js";
import { useEffect, useState, useSyncExternalStore } from "react";
import { CircleCheck, CircleDashed, CircleX, X } from "lucide-react";
import { getClientStorage, tooltipProps, type DesktopExtensionContext, type RegionProps } from "tau";
import { REVIEW_HOST_EXTENSION_ID, providerInfo, type PullRequestCheck } from "./protocol.js";
import { checksPipelines } from "./pipeline.js";
import { PipelineMini, usePipelineFacts } from "./pipeline-view.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { checksRollup, checksSummary, checksUnfinished } from "./pull-request-logic.js";
import { RequestStateIcon } from "./request-state-icon.js";
import { openPullRequest } from "./pull-request-open.js";
import { STRIP_OPTION, StripDismissals, stripRequests, type StripRequest, type StripState } from "./pull-request-strip-logic.js";
import { useRequestLifecycle } from "./request-lifecycle.js";
import { checksLabel, checksTone, type RowRequests } from "./requests.js";
import { ServiceIcon } from "./service-icon.js";
import type { ThreadLinkRows } from "./thread-links-store.js";

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


function ChecksIcon({ tone }: { tone: "passed" | "failed" | "pending" }) {
  const props = { size: 13, "aria-hidden": true } as const;
  if (tone === "passed") return <CircleCheck {...props} />;
  if (tone === "failed") return <CircleX {...props} />;
  return <CircleDashed {...props} />;
}

/** Reads a finished pipeline is shown from, so switching threads asks nothing new. */
const FINISHED_MS = 5 * 60_000;
const seen = new WeakMap<PullRequestClient, Map<string, { at: number; revision: string; checks: PullRequestCheck[] }>>();

/** The request's checks: read once, then while the last answer still had some running and the window is visible. */
function useLiveChecks(client: PullRequestClient | undefined, request: StripRequest): PullRequestCheck[] | undefined {
  const { url, checks: counted } = request;
  const pending = Boolean(counted?.pending);
  const revision = JSON.stringify([request.state, counted?.passed, counted?.failed, counted?.pending, counted?.total]);
  const [read, setRead] = useState<{ client: PullRequestClient; url: string; revision: string; checks: PullRequestCheck[] }>();
  useEffect(() => {
    if (!client) return;
    let cache = seen.get(client);
    if (!cache) { cache = new Map(); seen.set(client, cache); }
    const known = cache.get(url);
    if (known?.revision === revision) setRead({ client, url, revision, checks: known.checks });
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
        setRead({ client, url, revision, checks });
        if (!checksUnfinished(checks)) window.clearInterval(timer);
      }, () => undefined).finally(() => { reading = false; });
    };
    ask();
    timer = window.setInterval(() => { if (document.visibilityState === "visible") ask(); }, LIVE_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [client, url, pending, revision]);
  return read && read.client === client && read.url === url && read.revision === revision ? read.checks : undefined;
}

const TONES = { failing: "failed", pending: "pending", passing: "passed" } as const;

function StripChecks({ request, client, open }: { request: StripRequest; client: PullRequestClient | undefined; open(): void }) {
  const counted = checksTone(request.checks);
  const live = useLiveChecks(client, request);
  const facts = usePipelineFacts(client, request.url, live ?? []);
  const rollup = live ? checksRollup(live) : undefined;
  const tone = rollup ? TONES[rollup] : counted;
  if (live?.length) return <span className="review-pr-strip-checks"><PipelineMini pipelines={checksPipelines(live, facts)} size={16} nested onOpen={open} /></span>;
  if (!tone) return null;
  return <span className={`review-pr-strip-checks ${tone}`} {...tooltipProps(`Checks: ${live ? checksSummary(live) : checksLabel(request.checks)}`)}><ChecksIcon tone={tone} /></span>;
}

const otherLine = (request: StripRequest, watched: boolean) => [`#${request.number}`, request.title ?? request.repo, "·", STATE_WORDS[request.state].toLowerCase(), watched ? "· watching" : ""].filter(Boolean).join(" ");
const NO_WATCHES: WatchState = { watches: [] };
const noWatches = () => () => undefined;

/**
 * The thread's pull or merge request over the composer: number, repository,
 * branch and state, tinted by the state. Reads what the rail row already
 * asked for (the branch's request, the thread's links); a click opens its tab.
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
  const watchState = useSyncExternalStore(parts.watches?.subscribe ?? noWatches, parts.watches?.get ?? (() => NO_WATCHES));
  const eligible = preferences.optionValue(REVIEW_HOST_EXTENSION_ID, STRIP_OPTION, true) !== false
    && Boolean(threadId && !thread?.draftPending && (snapshot?.isStreaming || (snapshot?.messages?.length ?? 0) > 0));
  const found = stripRequests(linked.some((entry) => entry.url === branch?.url) ? branch : undefined, linked);
  const dismissed = Boolean(found && threadId && dismissals.isHidden(threadId, found.primary));
  const watching = eligible && !dismissed;
  useRequestLifecycle(rows, links, watching && tracked ? cwd : undefined, watching ? threadId : undefined);
  useEffect(() => { if (watching && tracked && cwd) rows.ensure(cwd); }, [watching, tracked, cwd, snapshot?.projectLabel]);
  useEffect(() => { if (watching && threadId) links.ensure(threadId); }, [watching, threadId]);

  const settledNote = threadId ? <SettlementStrip source={parts.settlement} threadId={threadId} /> : null;
  if (!watching || !threadId) return settledNote;
  if (!found) return <div className="review-thread-outcome"><PublicationStrip host={parts.host} threadId={threadId} streaming={Boolean(snapshot?.isStreaming)} />{settledNote}</div>;
  const { primary, others } = found;
  const info = providerInfo(primary.service);
  const state = STATE_WORDS[primary.state];
  const tone = primary.state === "open" ? checksTone(primary.checks) : undefined;
  const checks = tone ? checksLabel(primary.checks) : undefined;
  const where = primary.repo ? `${primary.host ? `${primary.host}/` : ""}${primary.repo}` : undefined;
  const label = [
    `Open ${info.noun} #${primary.number}${primary.repo ? ` in ${primary.repo}` : ""} on ${info.name}, ${state.toLowerCase()}`,
    checks ? `checks ${checks}` : "",
    others.length > 0 ? `${others.length} more linked` : "",
    primary.title ?? "",
  ].filter(Boolean).join(", ");
  const open = (focus?: "checks") => openPullRequest(actions, { url: primary.url, number: primary.number, provider: primary.service }, cwd, focus);
  return (
    <div className="review-thread-outcome"><div className={`review-pr-strip state-${primary.state}`}>
      <button type="button" className="review-pr-strip-open" aria-label={label} onClick={() => open()}>
        <RequestStateIcon state={primary.state} size={14} className="review-pr-strip-glyph" />
        <span className="review-pr-strip-number" {...tooltipProps(primary.title)}>#{primary.number}</span>
        <span className="review-pr-strip-service" {...tooltipProps(where ? `${info.name} · ${where}` : info.name)}><ServiceIcon service={primary.service} /></span>
        <span className="review-pr-strip-title">{primary.title ?? primary.repo}</span>
        <span className="review-pr-strip-state">{state}</span>
        <span className="review-pr-strip-fill" />
        {others.length > 0 ? <span className="review-pr-strip-more" {...tooltipProps(others.map((other) => otherLine(other, watchState.watches.some((watch) => watch.threadId === threadId && watch.ref.url === other.url && watch.status !== "ended"))).join("\n"), { variant: "lines" })}>+{others.length}</span> : null}
        {primary.state === "open" ? <StripChecks request={primary} client={parts.client} open={() => open("checks")} /> : null}
      </button>
      {parts.watches ? <PullRequestWatchControl feed={parts.watches} threadId={threadId} request={primary} others={others} /> : null}
      <button type="button" className="review-pr-strip-hide" aria-label={`Hide ${info.short} #${primary.number} for this thread`} {...tooltipProps("Hide for this thread")}
        onClick={() => dismissals.hide(threadId, primary)}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>{settledNote}</div>
  );
}
