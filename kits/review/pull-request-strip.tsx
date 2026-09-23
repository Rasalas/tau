import { useEffect, useSyncExternalStore } from "react";
import { CircleCheck, CircleDashed, CircleX, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, X } from "lucide-react";
import { MiddleTruncate, getClientStorage, tooltipProps, type DesktopExtensionContext, type RegionProps } from "tau";
import { REVIEW_HOST_EXTENSION_ID, providerInfo } from "./protocol.js";
import { openPullRequest } from "./pull-request-open.js";
import { STRIP_OPTION, StripDismissals, stripRequests, type StripRequest, type StripState } from "./pull-request-strip-logic.js";
import { checksLabel, checksTone, type RowRequests } from "./requests.js";
import { ServiceIcon } from "./service-icon.js";
import type { ThreadLinkRows } from "./thread-links-store.js";

export interface StripParts {
  rows: RowRequests;
  links: ThreadLinkRows;
  preferences: DesktopExtensionContext["preferences"];
  dismissals?: StripDismissals;
}

const STATE_WORDS: Record<StripState, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };
const shared = { dismissals: undefined as StripDismissals | undefined };

function Glyph({ state }: { state: StripState }) {
  const props = { size: 14, "aria-hidden": true, className: "review-pr-strip-glyph" } as const;
  if (state === "merged") return <GitMerge {...props} />;
  if (state === "closed") return <GitPullRequestClosed {...props} />;
  if (state === "draft") return <GitPullRequestDraft {...props} />;
  return <GitPullRequest {...props} />;
}

function ChecksIcon({ tone }: { tone: "passed" | "failed" | "pending" }) {
  const props = { size: 13, "aria-hidden": true } as const;
  if (tone === "passed") return <CircleCheck {...props} />;
  if (tone === "failed") return <CircleX {...props} />;
  return <CircleDashed {...props} />;
}

const otherLine = (request: StripRequest) => [`#${request.number}`, request.title ?? request.repo, "·", STATE_WORDS[request.state].toLowerCase()].filter(Boolean).join(" ");

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
  useEffect(() => { if (tracked && cwd) rows.ensure(cwd); }, [tracked, cwd, snapshot?.projectLabel]);
  useEffect(() => { if (threadId) links.ensure(threadId); }, [threadId]);
  const branch = useSyncExternalStore(rows.subscribe, () => (tracked && cwd ? rows.get(cwd) : undefined));
  const linked = useSyncExternalStore(links.subscribe, () => links.get(threadId));

  if (preferences.optionValue(REVIEW_HOST_EXTENSION_ID, STRIP_OPTION, true) === false) return null;
  if (!threadId || thread?.draftPending || (!snapshot?.isStreaming && (snapshot?.messages?.length ?? 0) === 0)) return null;
  const found = stripRequests(branch, linked);
  if (!found || dismissals.isHidden(threadId, found.primary)) return null;
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
  return (
    <div className={`review-pr-strip state-${primary.state}`}>
      <button type="button" className="review-pr-strip-open" aria-label={label}
        onClick={() => openPullRequest(actions, { url: primary.url, number: primary.number, provider: primary.service }, cwd)}>
        <Glyph state={primary.state} />
        <span className="review-pr-strip-number" {...tooltipProps(primary.title)}>#{primary.number}</span>
        <span className="review-pr-strip-service" {...tooltipProps(where ? `${info.name} · ${where}` : info.name)}><ServiceIcon service={primary.service} /></span>
        {primary.repo ? <span className="review-pr-strip-repo">{primary.repo.split("/").at(-1)}</span> : null}
        {primary.headRef ? <MiddleTruncate className="review-pr-strip-branch" value={primary.headRef} {...tooltipProps(primary.headRef, { variant: "code" })} /> : null}
        <span className="review-pr-strip-fill" />
        {others.length > 0 ? <span className="review-pr-strip-more" {...tooltipProps(others.map(otherLine).join("\n"), { variant: "lines" })}>+{others.length}</span> : null}
        {tone ? <span className={`review-pr-strip-checks ${tone}`} {...tooltipProps(`Checks: ${checks}`)}><ChecksIcon tone={tone} /></span> : null}
        <span className="review-pr-strip-state">{state}</span>
      </button>
      <button type="button" className="review-pr-strip-hide" aria-label={`Hide ${info.short} #${primary.number} for this thread`} {...tooltipProps("Hide for this thread")}
        onClick={() => dismissals.hide(threadId, primary)}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
