import { useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronRight, Eye, List, MessageSquare } from "lucide-react";
import type { PullRequestGuide } from "./guide-protocol.js";
import type { ExcerptEnv } from "./guide-excerpt.js";
import { GuideNotes, GuideProse } from "./guide-notes.js";
import { AttentionNotice, StopExcerpts, StopFiles, StopQuestions } from "./guide-stop-parts.js";
import { ATTENTION_LABELS, clampPosition, guideProgress, guideProgressKey, letterStopNotes, stopSubline } from "./guide-tour.js";

/**
 * The guide on a phone: an outline of the stops, then one screen per stop with a bar at the foot.
 * A guide older than the request's head shows titles and summaries but no code, which no longer
 * lines up with what the reader would open.
 */
export function GuideCompact({ guide, url, banner, stale, env, onAsk, onFinish }: {
  guide: PullRequestGuide;
  url: string;
  banner: ReactNode;
  stale: boolean;
  env: ExcerptEnv;
  onAsk: ((index: number, question: string) => void) | null;
  onFinish: (() => void) | null;
}) {
  const key = guideProgressKey(url, guide.headSha);
  const progress = useSyncExternalStore(guideProgress.subscribe, () => guideProgress.get(key));
  const [screen, setScreen] = useState<"outline" | "stop">("outline");
  const count = guide.stops.length;
  const position = clampPosition(progress.position, count);
  const stop = guide.stops[position];
  const notes = useMemo(() => stop ? letterStopNotes(stop) : undefined, [stop]);
  const root = useRef<HTMLDivElement>(null);

  // Every screen starts at its top, wherever the panel around the guide scrolls.
  const show = (next: "outline" | "stop") => { setScreen(next); root.current?.scrollIntoView?.({ block: "start" }); };
  const open = (index: number) => { guideProgress.go(key, index); show("stop"); };

  if (screen === "outline" || !stop || !notes) {
    const started = progress.seen.size > 0 || position > 0;
    return (
      <div className="guide-compact" ref={root}>
        <div className="guide-compact-body">
          {banner}
          <header className="guide-outline-head">
            <h2>Review guide</h2>
            <p>{count === 1 ? "1 stop" : `${count} stops`}, in reading order.</p>
          </header>
          <ol className="guide-outline">
            {guide.stops.map((entry, index) => {
              const seen = progress.seen.has(index);
              return (
                <li key={index}>
                  <button type="button" onClick={() => open(index)}>
                    <span className={`guide-rail-mark${seen ? " seen" : ""}`} aria-hidden="true">{seen ? <Check size={12} /> : index + 1}</span>
                    <span className="guide-rail-text">
                      <span className="guide-rail-title">{entry.title}</span>
                      <small>{stopSubline(entry)}</small>
                    </span>
                    {seen ? <span className="pr-sr">Seen</span> : null}
                    {entry.attention ? <Eye size={14} className="guide-rail-attention" aria-label={ATTENTION_LABELS[entry.attention.kind]} /> : null}
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
        <nav className="guide-bar" aria-label="Guide">
          <button type="button" className="guide-bar-main" disabled={count === 0} onClick={() => open(position)}>{started ? `Continue at stop ${position + 1}` : "Start"}<ArrowRight size={16} aria-hidden="true" /></button>
        </nav>
      </div>
    );
  }

  const last = position === count - 1;
  return (
    <div className="guide-compact" ref={root}>
      <div className="guide-compact-body">
        {banner}
        <header className="guide-stop-head">
          <button type="button" className="text-button" onClick={() => show("outline")}><List size={14} aria-hidden="true" /> All stops</button>
          <span className="spacer" />
          <p className="guide-position">Stop {position + 1} of {count}</p>
        </header>
        <div className="guide-stop-title">
          <h2>{stop.title}</h2>
          <GuideProse>{stop.summary}</GuideProse>
        </div>
        {stop.attention ? <AttentionNotice attention={stop.attention} /> : null}
        {stale ? (
          stop.excerpts.length > 0 ? <p className="guide-stale-code" role="status">The code is hidden until this guide is rewritten for the latest push.</p> : null
        ) : (
          <>
            <StopExcerpts stop={stop} markers={notes.byExcerpt} env={env} />
            <GuideNotes notes={notes.lettered} />
          </>
        )}
        <StopFiles stop={stop} files={env.files} onOpenFile={env.onOpenFile} />
        <StopQuestions stop={stop} onAsk={onAsk ? (question) => onAsk(position, question) : null} />
      </div>
      <nav className="guide-bar" aria-label="Stops">
        <button type="button" className="guide-bar-back" onClick={() => position === 0 ? show("outline") : open(position - 1)}><ArrowLeft size={16} aria-hidden="true" /> Back</button>
        {!last ? (
          <button type="button" className="guide-bar-main" onClick={() => open(position + 1)}>Next stop<ArrowRight size={16} aria-hidden="true" /></button>
        ) : onFinish ? (
          <button type="button" className="guide-bar-main" onClick={() => { guideProgress.markSeen(key, position); onFinish(); }}><MessageSquare size={16} aria-hidden="true" /> Finish review</button>
        ) : null}
      </nav>
    </div>
  );
}
