import { useEffect, useMemo, type ReactNode } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { READ_ONLY_REASON, Spinner, useCommandAllowed, type UiFileDiff, type WorkbenchActions } from "tau";
import { askChip } from "./guide-ask.js";
import type { GuideClient } from "./guide-client.js";
import { useGuide } from "./guide-client.js";
import { GuideCompact } from "./guide-compact.js";
import type { ExcerptEnv } from "./guide-excerpt.js";
import { GUIDE_WRITE_COMMAND } from "./guide-protocol.js";
import { GuideTourView } from "./guide-tour-view.js";
import { guideFailure, isGuideStale } from "./guide-tour.js";
import { useCompactProfile } from "./compact-profile.js";
import { REVIEW_HOST_EXTENSION_ID, type PullRequestFiles } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { shortNoun, relativeTime } from "./pull-request-logic.js";
import { usePullRequestContext } from "./pull-request-context.js";
import { usePullRequestLines } from "./pull-request-lines.js";

const NO_DIFFS: readonly UiFileDiff[] = [];

/** What the line seam of the Code tab needs; the guide's excerpts add their comments to the same review. */
export type GuideLineProps = Omit<Parameters<typeof usePullRequestLines>[0], "diffs">;

export interface GuideTabProps {
  lines: GuideLineProps;
  client: PullRequestClient;
  guides: GuideClient;
  actions: WorkbenchActions;
  files?: PullRequestFiles | undefined;
  filesError?: string | undefined;
  loadFiles(fresh: boolean): Promise<void>;
  /** Whether this is the tab on screen, which is when J and K step through the tour. */
  active: boolean;
  /** Shows a file in the Code tab. */
  onOpenFile(path: string): void;
  /** Opens the review composer with the comments held so far; null where the reader cannot review. */
  onFinish: (() => void) | null;
}

function WriteButton({ label, busy, disabled, onClick, small }: { label: string; busy: boolean; disabled: boolean; onClick(): void; small?: boolean }) {
  return (
    <button type="button" className={small ? "text-button" : "mini-button"} disabled={busy || disabled} onClick={onClick}>
      {busy ? <Spinner size="xs" label="Reading the change" /> : <Sparkles size={13} aria-hidden="true" />} {busy ? "Reading the change…" : label}
    </button>
  );
}

/**
 * A maintainer's tour of the request: stops through the diff in reading order with the calls only
 * a person can make. Written on request and stored, so opening the tab costs nothing.
 */
export function GuideTab({ lines, client, guides, actions, files, filesError, loadFiles, active, onOpenFile, onFinish }: GuideTabProps) {
  const { detail } = lines;
  const url = detail.ref.url;
  const { result, loading, error, running, write, refresh } = useGuide(guides, url);
  const canWrite = useCommandAllowed(REVIEW_HOST_EXTENSION_ID, GUIDE_WRITE_COMMAND);
  const compact = useCompactProfile();
  const guide = result?.guide ?? null;
  const currentHead = result?.currentHeadSha ?? detail.headSha ?? null;
  const stale = guide !== null && isGuideStale(guide, currentHead);
  const failure = guideFailure(result, currentHead) ?? error;
  const noun = shortNoun(detail.ref.service);

  // The excerpts need the files; nothing is read for an empty tab.
  useEffect(() => { if (guide && !files && !filesError) void loadFiles(false); }, [files, filesError, guide, loadFiles]);
  const diffs = files?.diffs ?? NO_DIFFS;
  const byPath = useMemo(() => new Map(diffs.map((diff) => [diff.path, diff])), [diffs]);
  const { slotFor } = usePullRequestLines({ ...lines, diffs });
  const context = usePullRequestContext(client, detail, files?.files ?? []);
  const env = useMemo<ExcerptEnv>(() => ({ files: byPath, loading: !files && !filesError, slotFor, context, onOpenFile, wrap: compact }), [byPath, compact, context, files, filesError, onOpenFile, slotFor]);

  const thread = actions.activeThread();
  const start = () => { void write({ ...(thread?.cwd ? { cwd: thread.cwd } : {}), ...(thread?.sessionId ? { threadId: thread.sessionId } : {}) }); };
  const ask = guide ? (index: number, question: string) => {
    const stop = guide.stops[index];
    if (stop) lines.onSend(askChip({ noun, number: detail.ref.number }, stop, index, guide.stops.length, question));
  } : null;

  if (loading && !result) return <div className="guide-tab"><p className="pr-empty pr-pad" role="status">Loading the guide…</p></div>;
  if (!result) {
    return (
      <div className="guide-tab">
        <div className="guide-empty" role="alert">
          <p className="guide-empty-title">Could not read the guide</p>
          <p>{error ?? "The machine did not answer."}</p>
          <button type="button" className="mini-button" onClick={() => void refresh()}>Retry</button>
        </div>
      </div>
    );
  }
  if (!result.enabled) {
    return <div className="guide-tab"><div className="guide-empty"><p className="guide-empty-title">Review guides are off</p><p>Turn them on in Settings, Review.</p></div></div>;
  }

  if (!guide) {
    return (
      <div className="guide-tab">
        <div className="guide-empty">
          <p className="guide-empty-title">{running ? "Writing a review guide" : "No review guide yet"}</p>
          <p role={failure && !running ? "alert" : undefined}>
            {running
              ? "An agent is reading the change. A large one takes a few minutes. You can leave; you will be told when it is ready."
              : failure ?? "A guide is a tour of the change: stops through the code in reading order, with the calls only a maintainer can make."}
          </p>
          {canWrite ? <WriteButton label={failure && !running ? "Try again" : "Write guide"} busy={running} disabled={false} onClick={start} /> : <p className="guide-empty-reason">{READ_ONLY_REASON}</p>}
        </div>
      </div>
    );
  }

  // Only a guide that needs attention says so; a current one is just the tour.
  const banner: ReactNode = running ? (
    <div className="guide-banner" role="status"><Spinner size="xs" label="Rewriting" /><span>Rewriting this guide… You will be told when the new one is ready.</span></div>
  ) : stale || failure ? (
    <div className={`guide-banner${failure ? " failed" : ""}`} role={failure ? "alert" : "status"}>
      <span>{failure ?? "Written before the latest push."}</span>
      {canWrite ? <WriteButton label={failure ? "Try again" : "Rewrite"} busy={false} disabled={false} small onClick={start} /> : null}
    </div>
  ) : (
    <div className="guide-meta">
      <span>Written {relativeTime(guide.generatedAt)}{guide.model ? ` · ${guide.model}` : ""}</span>
      {canWrite ? <button type="button" className="text-button" onClick={start}><RefreshCw size={11} aria-hidden="true" /> Rewrite</button> : null}
    </div>
  );

  return (
    <div className="guide-tab">
      {filesError && !files ? (
        <p className="guide-files-error" role="alert">The diff could not be loaded, so excerpts are missing: {filesError} <button type="button" className="text-button" onClick={() => void loadFiles(true)}>Retry</button></p>
      ) : null}
      {compact
        ? <GuideCompact guide={guide} url={url} banner={banner} stale={stale} env={env} onAsk={ask} onFinish={onFinish} />
        : <GuideTourView guide={guide} url={url} banner={banner} active={active} env={env} onAsk={ask} onFinish={onFinish} />}
    </div>
  );
}
