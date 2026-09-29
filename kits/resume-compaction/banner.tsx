import { useEffect, useState, useSyncExternalStore } from "react";
import { Minimize2, X } from "lucide-react";
import { READ_ONLY_REASON, tooltipProps, useHostCapabilities, useThreadStore, type PreferencesStore, type RegionProps, type UiContextUsage, type WorkbenchActions } from "tau";
import { KEPT_KEY, OFF_KEY, RESUME_COMPACTION_EXTENSION_ID } from "./protocol.js";
import { dismissalKey, formatContextTokens, offerDueAt, offersResumeCompaction, readList, withKept } from "./rule.js";

type Preferences = Pick<PreferencesStore, "subscribe" | "getSnapshot" | "value" | "setValue">;

export interface BannerOptions {
  preferences: Preferences;
  /** The clock; tests pass their own. */
  now?(): number;
}

/** The clock, read again once `dueAt` passes, so the offer appears without a turn. */
function useNow(now: () => number, dueAt: number | undefined): number {
  const [, setTick] = useState(0);
  const current = now();
  useEffect(() => {
    if (dueAt === undefined || current >= dueAt) return undefined;
    const timer = setTimeout(() => setTick((tick) => tick + 1), dueAt - current + 1_000);
    return () => clearTimeout(timer);
  }, [current, dueAt]);
  return current;
}

/**
 * "Resume with less context" above the composer: a thread
 * whose context is large and whose prompt cache has gone cold offers a
 * compaction before the next turn rewrites all of it into the cache.
 */
export function createResumeCompactionBanner({ preferences, now = Date.now }: BannerOptions) {
  return function ResumeCompactionBanner({ snapshot, actions }: RegionProps) {
    useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
    const usage = snapshot?.contextUsage;
    const current = useNow(now, offerDueAt(usage));
    const threadId = snapshot?.threadId ?? snapshot?.sessionId;
    const runtime = snapshot?.backendKind ?? "pi";
    if (!snapshot || !threadId || !usage || snapshot.isStreaming || !offersResumeCompaction(usage, current)) return null;
    if (readList(preferences.value(RESUME_COMPACTION_EXTENSION_ID, OFF_KEY)).includes(runtime)) return null;
    const key = dismissalKey(threadId, usage);
    const kept = readList(preferences.value(RESUME_COMPACTION_EXTENSION_ID, KEPT_KEY));
    if (kept.includes(key)) return null;
    const keep = () => preferences.setValue(RESUME_COMPACTION_EXTENSION_ID, KEPT_KEY, JSON.stringify(withKept(kept, key)));
    return <Offer threadId={threadId} usage={usage} actions={actions} onKeep={keep} />;
  };
}

function Offer({ threadId, usage, actions, onKeep }: { threadId: string; usage: UiContextUsage; actions: WorkbenchActions; onKeep(): void }) {
  const threads = useThreadStore();
  const asking = useSyncExternalStore(threads.subscribe, () => threads.getSnapshot().waitingThreadIds.includes(threadId));
  const { readOnly } = useHostCapabilities();
  const [compacting, setCompacting] = useState(false);
  // A question waits on the thread: the user answers that first.
  if (asking) return null;
  const compactContext = actions.compactContext;
  const disabledReason = readOnly ? READ_ONLY_REASON : !compactContext ? "Compaction is unavailable here." : undefined;
  const compact = () => {
    if (!compactContext || compacting) return;
    setCompacting(true);
    void compactContext().finally(() => setCompacting(false));
  };
  return (
    <div className="resume-compaction" role="region" aria-label="Resume with less context" aria-busy={compacting || undefined}>
      <Minimize2 size={13} aria-hidden="true" />
      <span className="resume-compaction-text">
        <strong>Resume with less context</strong>
        <span className="resume-compaction-description">{formatContextTokens(usage.tokens)} tokens from earlier</span>
      </span>
      <span className="resume-compaction-actions">
        {/* A disabled button takes no pointer events, so its wrapper carries the reason. */}
        <span className="resume-compaction-action" {...(disabledReason ? tooltipProps(disabledReason) : {})}>
          <button type="button" disabled={Boolean(disabledReason) || compacting} onClick={compact}>
            {compacting ? "Compacting…" : "Compact"}
          </button>
        </span>
        <button type="button" className="resume-compaction-close" aria-label="Keep full history" {...tooltipProps("Keep full history")} onClick={onKeep}>
          <X size={13} aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}
