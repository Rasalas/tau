import { Eye, FileText, MessageCircleQuestion } from "lucide-react";
import type { UiFileDiff } from "tau";
import type { GuideStop } from "./guide-protocol.js";
import { GuideExcerptView, type ExcerptEnv } from "./guide-excerpt.js";
import { GuideProse } from "./guide-notes.js";
import { ATTENTION_LABELS, type ExcerptMarkers } from "./guide-tour.js";

/** The one call a reader should make here. It is a notice, not a warning: it names no bug. */
export function AttentionNotice({ attention }: { attention: NonNullable<GuideStop["attention"]> }) {
  return (
    <aside className="guide-attention" aria-label="Look closely">
      <Eye size={14} aria-hidden="true" />
      <div>
        <strong>{ATTENTION_LABELS[attention.kind]}</strong>
        <GuideProse>{attention.note}</GuideProse>
      </div>
    </aside>
  );
}

export function StopExcerpts({ stop, markers, env }: { stop: GuideStop; markers: readonly (readonly ExcerptMarkers[])[]; env: ExcerptEnv }) {
  if (stop.excerpts.length === 0) return null;
  return (
    <div className="guide-excerpts">
      {stop.excerpts.map((excerpt, index) => (
        <GuideExcerptView key={`${excerpt.path}:${excerpt.side}:${excerpt.start}-${excerpt.end}`} excerpt={excerpt} markers={markers[index] ?? []} env={env} />
      ))}
    </div>
  );
}

/** Files the stop owns without excerpting them, each opening in the Code tab. */
export function StopFiles({ stop, files, onOpenFile }: { stop: GuideStop; files: ReadonlyMap<string, UiFileDiff>; onOpenFile(path: string): void }) {
  const excerpted = new Set(stop.excerpts.map((excerpt) => excerpt.path));
  const others = stop.files.filter((file) => !excerpted.has(file.path));
  if (others.length === 0) return null;
  return (
    <section className="guide-files" aria-label="Files in this stop">
      <h3>{stop.excerpts.length > 0 ? "Also in this stop" : "Files in this stop"}</h3>
      <ul>
        {others.map((file) => {
          const diff = files.get(file.path);
          return (
            <li key={file.path}>
              <button type="button" aria-label={`Open ${file.path} in Code`} title={file.path} onClick={() => onOpenFile(file.path)}>
                <FileText size={13} aria-hidden="true" />
                <span className="guide-file-path">{file.path}</span>
                {file.note?.trim() ? <span className="guide-file-note">{file.note}</span> : null}
                {diff ? <span className="guide-file-stat"><span className="stat-add">+{diff.added}</span> <span className="stat-del">−{diff.removed}</span></span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Questions about intent become the way into a conversation; "Ask about this stop" is the open one. */
export function StopQuestions({ stop, onAsk }: { stop: GuideStop; onAsk: ((question: string) => void) | null }) {
  if (stop.questions.length === 0 && !onAsk) return null;
  return (
    <section className="guide-questions" aria-label="Questions">
      {stop.questions.length > 0 ? <h3>Questions to consider</h3> : null}
      {stop.questions.map((question) => onAsk ? (
        <button key={question} type="button" className="guide-question" onClick={() => onAsk(question)}>
          <MessageCircleQuestion size={14} aria-hidden="true" />
          <span><span className="pr-sr">Ask an agent: </span>{question}</span>
        </button>
      ) : <p key={question} className="guide-question-plain">{question}</p>)}
      {onAsk ? (
        <button type="button" className="text-button guide-ask" onClick={() => onAsk("")}>
          <MessageCircleQuestion size={13} aria-hidden="true" /> Ask about this stop
        </button>
      ) : null}
    </section>
  );
}
