import { useEffect, useState } from "react";
import { ChevronUp, FileDiff, TriangleAlert } from "lucide-react";
import { useWorkbench, type HostExtensionClient, type RegionProps } from "tau";
import type { CompactReviewStore } from "./compact-store.js";
import { REVIEW_COMPACT_PANEL, WORKSPACE_CHECKPOINT_EVENT, type ReviewTurn } from "./protocol.js";

/** The latest recorded turn that changed something; a partial capture may have missed changes, so it counts. */
export function latestChangedTurn(turns: readonly ReviewTurn[]): ReviewTurn | undefined {
  return [...turns]
    .sort((left, right) => left.endedAt - right.endedAt)
    .filter((turn) => turn.completeness === "partial" || (turn.fileCount ?? turn.files.length) > 0)
    .at(-1);
}

export function filesLabel(turn: ReviewTurn): string {
  const count = turn.fileCount ?? turn.files.length;
  const partial = turn.completeness === "partial";
  return `${count}${partial ? "+" : ""} ${count === 1 && !partial ? "file" : "files"}`;
}

/**
 * The phone's pill over the composer: what the latest turn changed. A tap
 * opens the Review sheet on that turn's files. While a turn runs it steps
 * aside; the running turn's own changes arrive with its checkpoint.
 */
export function createCompactTurnPill({ workspace, store }: { workspace: HostExtensionClient; store: CompactReviewStore }) {
  return function CompactTurnPill({ actions }: RegionProps) {
    const sessionId = actions.activeThread()?.sessionId;
    const { snapshot } = useWorkbench();
    const streaming = Boolean(snapshot?.isStreaming);
    const [generation, setGeneration] = useState(0);
    const [loaded, setLoaded] = useState<{ sessionId: string; turn?: ReviewTurn }>();

    useEffect(() => workspace.onEvent(WORKSPACE_CHECKPOINT_EVENT, (payload) => {
      const event = payload as { type?: string; sessionId?: string } | undefined;
      if (event?.type === "turn-checkpoint" && event.sessionId === sessionId) setGeneration((value) => value + 1);
    }), [sessionId]);

    useEffect(() => {
      if (!sessionId) return undefined;
      let cancelled = false;
      workspace.invoke("checkpoints", { sessionId }).then(
        (list) => { if (!cancelled) setLoaded({ sessionId, turn: latestChangedTurn((list as { checkpoints?: ReviewTurn[] } | undefined)?.checkpoints ?? []) }); },
        // No pill is the honest answer when the list cannot be read; the Review sheet says why.
        () => { if (!cancelled) setLoaded({ sessionId }); },
      );
      return () => { cancelled = true; };
    }, [sessionId, generation]);

    const turn = loaded?.sessionId === sessionId ? loaded?.turn : undefined;
    if (!sessionId || !turn || streaming) return null;
    const partial = turn.completeness === "partial";
    return (
      <div className="review-turn-pill-bar">
        <button
          type="button"
          className="control-pill review-turn-pill"
          aria-haspopup="dialog"
          aria-label={`Turn changes: ${filesLabel(turn)}, ${turn.added} lines added, ${turn.removed} removed`}
          onClick={() => {
            store.update({ sessionId, source: { kind: "turn", id: turn.id }, page: "files", path: undefined });
            actions.openPanel(REVIEW_COMPACT_PANEL);
          }}
        >
          <FileDiff aria-hidden="true" />
          <span>{filesLabel(turn)}</span>
          {partial ? <TriangleAlert className="review-turn-pill-partial" aria-hidden="true" /> : null}
          <span className="stat-add">+{turn.added}</span>
          <span className="stat-del">−{turn.removed}</span>
          <ChevronUp aria-hidden="true" />
        </button>
      </div>
    );
  };
}
