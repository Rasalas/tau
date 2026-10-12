import { RequestMarkdown } from "./request-markdown.js";
import type { LetteredNote } from "./guide-tour.js";
import { baseName } from "./review-lines.js";

/** The guide's words are markdown, drawn the way the request's description is. */
export function GuideProse({ children, className }: { children: string; className?: string }) {
  if (!children.trim()) return null;
  return <div className={`guide-prose pr-comment-body${className ? ` ${className}` : ""}`}><RequestMarkdown>{children}</RequestMarkdown></div>;
}

/** The letter that ties a note to its line in an excerpt. */
export function GuideNoteMarker({ marker }: { marker: string }) {
  return <span className="guide-marker" aria-hidden="true">{marker}</span>;
}

/** A stop's notes, lettered in the order the guide lists them. */
export function GuideNotes({ notes, className }: { notes: readonly LetteredNote[]; className?: string }) {
  if (notes.length === 0) return null;
  return (
    <section className={`guide-notes${className ? ` ${className}` : ""}`} aria-label="Notes on this stop">
      <h4>Notes on this stop <small>{notes.length === 1 ? "1 note" : `${notes.length} notes`}</small></h4>
      <ol>
        {notes.map(({ marker, note }) => (
          <li key={marker}>
            <GuideNoteMarker marker={marker} />
            <div className="guide-note-text">
              <p><strong>{note.title}</strong> <code title={`${note.path}:${note.line}`}>{baseName(note.path)}:{note.line}</code></p>
              <GuideProse>{note.body}</GuideProse>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
