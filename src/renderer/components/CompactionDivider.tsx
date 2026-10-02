import { Shrink } from "lucide-react";
import { useId, useState } from "react";
import type { UiCompaction } from "../../shared/contracts";
import { Markdown } from "./Markdown";

/** 142000 → 142k, 3800 → 3.8k, 950 → 950. */
export function compactTokens(tokens: number): string {
  const value = Math.max(0, Math.round(tokens));
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return String(value);
}

/** "Context compacted · turns 1–3 summarised · 142k → 38k tokens", with what is known. */
export function compactionLabel(compaction: UiCompaction): string {
  const parts = ["Context compacted"];
  const { turns, tokensBefore, tokensAfter } = compaction;
  if (turns) parts.push(turns.first === turns.last ? `turn ${turns.first} summarised` : `turns ${turns.first}–${turns.last} summarised`);
  if (tokensBefore !== undefined && tokensAfter !== undefined) parts.push(`${compactTokens(tokensBefore)} → ${compactTokens(tokensAfter)} tokens`);
  else if (tokensBefore !== undefined) parts.push(`${compactTokens(tokensBefore)} tokens before`);
  return parts.join(" · ");
}

/** A quiet rule across the transcript where the runtime compacted its context; "Show" opens the summary. */
export function CompactionDivider({ compaction }: { compaction: UiCompaction }) {
  const [open, setOpen] = useState(false);
  const summaryId = useId();
  const label = compactionLabel(compaction);
  const summary = compaction.summary?.trim();
  return (
    <div className="compaction-divider">
      <div className="compaction-divider-rule" role="separator" aria-label={label}>
        <span className="compaction-divider-line" aria-hidden="true" />
        <Shrink size={12} aria-hidden="true" />
        <span className="compaction-divider-label">{label}</span>
        {summary ? (
          <button type="button" className="compaction-divider-toggle" aria-expanded={open} aria-controls={summaryId} onClick={() => setOpen((value) => !value)}>
            {open ? "Hide" : "Show"}
          </button>
        ) : null}
        <span className="compaction-divider-line" aria-hidden="true" />
      </div>
      {open && summary ? <div id={summaryId} className="compaction-divider-summary"><Markdown>{summary}</Markdown></div> : null}
    </div>
  );
}
