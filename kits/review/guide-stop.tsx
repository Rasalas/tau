import { useMemo, type ReactNode } from "react";
import { ArrowRight, ChevronDown, ChevronUp, MessageSquare } from "lucide-react";
import type { GuideStop as Stop } from "./guide-protocol.js";
import type { ExcerptEnv } from "./guide-excerpt.js";
import { GuideNotes, GuideProse } from "./guide-notes.js";
import { AttentionNotice, StopExcerpts, StopFiles, StopQuestions } from "./guide-stop-parts.js";
import { letterStopNotes } from "./guide-tour.js";

/**
 * One stop of the tour: what it is about, where to look, and the two things a reader does with it,
 * comment on its lines for the review or ask an agent about it.
 */
export function GuideStop({ stop, index, count, narrow, notesColumn, railOpen, onRailOpenChange, stopList, nextTitle, env, onStep, onAsk, onFinish }: {
  stop: Stop;
  index: number;
  count: number;
  /** The rail has no room beside the stop: the header carries the position and folds the stop list open. */
  narrow: boolean;
  /** Room enough for the notes in a column of their own beside the stop. */
  notesColumn: boolean;
  railOpen: boolean;
  onRailOpenChange(open: boolean): void;
  stopList: ReactNode;
  nextTitle: string | null;
  env: ExcerptEnv;
  onStep(delta: 1 | -1): void;
  onAsk: ((question: string) => void) | null;
  /** Opens the review composer on the last stop; null where the reader cannot review. */
  onFinish: (() => void) | null;
}) {
  const { lettered, byExcerpt } = useMemo(() => letterStopNotes(stop), [stop]);
  return (
    <div className={`guide-stop${lettered.length > 0 && notesColumn ? " with-column" : ""}`}>
      <article>
        <header className="guide-stop-head">
          {narrow ? (
            <button type="button" className="text-button guide-fold" aria-expanded={railOpen} onClick={() => onRailOpenChange(!railOpen)}>
              Stop {index + 1} of {count} <ChevronDown size={12} aria-hidden="true" />
            </button>
          ) : <p className="guide-position">Stop {index + 1} of {count}</p>}
          <span className="spacer" />
          <button type="button" className="icon-button compact" aria-label="Previous stop" disabled={index === 0} onClick={() => onStep(-1)}><ChevronUp size={14} /></button>
          <button type="button" className="icon-button compact" aria-label="Next stop" disabled={index === count - 1} onClick={() => onStep(1)}><ChevronDown size={14} /></button>
          <span className="guide-keys" aria-hidden="true"><kbd>J</kbd><kbd>K</kbd></span>
        </header>
        {narrow && railOpen ? <div className="guide-fold-panel">{stopList}</div> : null}
        <div className="guide-stop-title">
          <h2>{stop.title}</h2>
          <GuideProse>{stop.summary}</GuideProse>
        </div>
        {stop.attention ? <AttentionNotice attention={stop.attention} /> : null}
        <StopExcerpts stop={stop} markers={byExcerpt} env={env} />
        {notesColumn ? null : <GuideNotes notes={lettered} />}
        <StopFiles stop={stop} files={env.files} onOpenFile={env.onOpenFile} />
        <StopQuestions stop={stop} onAsk={onAsk} />
        <footer className="guide-stop-foot">
          {nextTitle !== null ? (
            <button type="button" className="mini-button primary guide-next" onClick={() => onStep(1)}><span>Next: {nextTitle}</span><ArrowRight size={13} aria-hidden="true" /></button>
          ) : onFinish ? (
            <button type="button" className="mini-button primary guide-next" onClick={onFinish}><MessageSquare size={13} aria-hidden="true" /> Finish review</button>
          ) : null}
        </footer>
      </article>
      {lettered.length > 0 && notesColumn ? <aside className="guide-notes-column"><GuideNotes notes={lettered} /></aside> : null}
    </div>
  );
}
