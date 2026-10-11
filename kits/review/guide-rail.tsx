import { Check, Eye } from "lucide-react";
import type { GuideStop } from "./guide-protocol.js";
import { ATTENTION_LABELS, stopSubline } from "./guide-tour.js";

/** The tour's stops in reading order; the reader's place and the stops already behind them are marked. */
export function GuideRail({ stops, position, seen, onSelect }: { stops: readonly GuideStop[]; position: number; seen: ReadonlySet<number>; onSelect(index: number): void }) {
  return (
    <nav className="guide-rail" aria-label="Stops of the guide">
      <ol>
        {stops.map((stop, index) => (
          <li key={index}>
            <button type="button" className={index === position ? "active" : ""} aria-current={index === position ? "step" : undefined} onClick={() => onSelect(index)}>
              <span className={`guide-rail-mark${seen.has(index) && index !== position ? " seen" : ""}`} aria-hidden="true">
                {seen.has(index) && index !== position ? <Check size={11} /> : index + 1}
              </span>
              <span className="guide-rail-text">
                <span className="guide-rail-title">{stop.title}</span>
                <small>{stopSubline(stop)}</small>
              </span>
              {seen.has(index) && index !== position ? <span className="pr-sr">Seen</span> : null}
              {stop.attention ? <Eye size={12} className="guide-rail-attention" aria-label={ATTENTION_LABELS[stop.attention.kind]} /> : null}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
