import { useMemo } from "react";
import { ArrowUpRight } from "lucide-react";
import { DiffView, tooltipProps, type DiffContext, type DiffLineSlot, type UiFileDiff } from "tau";
import type { GuideExcerpt as Excerpt } from "./guide-protocol.js";
import { GuideNoteMarker } from "./guide-notes.js";
import { excerptDiff, expandExcerpt, type ExcerptMarkers } from "./guide-tour.js";

/** What every excerpt of a tour draws against: the loaded diffs, the line seam and the unchanged lines. */
export interface ExcerptEnv {
  files: ReadonlyMap<string, UiFileDiff>;
  /** The diffs are still on their way. */
  loading: boolean;
  slotFor(path: string): DiffLineSlot;
  context: DiffContext;
  onOpenFile(path: string): void;
  /** Long lines wrap; the desktop scrolls them sideways so an excerpt keeps its height. */
  wrap: boolean;
}

/** The line seam of the Code tab, with the note markers drawn under the lines they sit on. */
function withMarkers(slot: DiffLineSlot, side: Excerpt["side"], markers: readonly ExcerptMarkers[]): DiffLineSlot {
  if (markers.length === 0) return slot;
  const byLine = new Map(markers.map((entry) => [entry.line, entry.markers]));
  return {
    ...slot,
    render: (context) => {
      const here = byLine.get((side === "new" ? context.line.newLine : context.line.oldLine) ?? -1);
      const rest = slot.render?.(context);
      if (!here && !rest) return null;
      return (
        <>
          {here ? (
            <div className="guide-line-notes">
              {here.map((entry) => <span key={entry.marker}><GuideNoteMarker marker={entry.marker} /> {entry.title}</span>)}
            </div>
          ) : null}
          {rest}
        </>
      );
    },
  };
}

/**
 * The lines of one excerpt, drawn by the Code tab's diff view from the file's diff cut down to
 * the excerpt, so numbers, colours and the comment seam are the same; the bars above and
 * below load the code around it from the file.
 */
export function GuideExcerptView({ excerpt, markers, env }: { excerpt: Excerpt; markers: readonly ExcerptMarkers[]; env: ExcerptEnv }) {
  const file = env.files.get(excerpt.path);
  const view = useMemo(() => file ? excerptDiff(file, excerpt) : undefined, [excerpt, file]);
  const { context } = env;
  const expandable = Boolean(view?.collapsible) && context.can(excerpt.path);
  const drawn = useMemo(() => {
    if (!view) return undefined;
    if (!expandable) return { diff: view.diff, totalLines: undefined };
    let totalLines: number | undefined;
    const diff = expandExcerpt(view, (cut) => { const applied = context.apply(cut); totalLines = applied.totalLines; return applied.diff; });
    return { diff, totalLines };
  }, [context, expandable, view]);
  const slot = useMemo(() => withMarkers(env.slotFor(excerpt.path), excerpt.side, markers), [env, excerpt.path, excerpt.side, markers]);
  const place = `${excerpt.path} · ${excerpt.side === "old" ? "removed code, " : ""}lines ${excerpt.start}–${excerpt.end}`;

  return (
    <figure className="guide-excerpt">
      {excerpt.caption.trim() ? <figcaption>{excerpt.caption}</figcaption> : null}
      <div className="guide-excerpt-frame">
        <header>
          <span className="guide-excerpt-path" title={place}>{place}</span>
          {view ? <span className="guide-excerpt-count">showing {view.shown} of {view.total} diff lines</span> : null}
          <button type="button" className="icon-button compact" aria-label={`Open ${excerpt.path} in Code`} {...tooltipProps("Open in Code")} onClick={() => env.onOpenFile(excerpt.path)}><ArrowUpRight size={13} /></button>
        </header>
        {drawn ? (
          <div className="guide-excerpt-diff">
            <DiffView diff={drawn.diff} mode="unified" wrap={env.wrap} path={excerpt.path} lines={slot}
              {...(expandable ? { onExpandGap: context.expand, contextState: context.state(excerpt.path), ...(drawn.totalLines !== undefined ? { totalLines: drawn.totalLines } : {}) } : {})} />
          </div>
        ) : env.loading ? (
          <p className="guide-excerpt-note" role="status">Loading {excerpt.path}…</p>
        ) : (
          <p className="guide-excerpt-note">Lines {excerpt.start}–{excerpt.end} of <code>{excerpt.path}</code> are not in the loaded diff. <button type="button" className="text-button" onClick={() => env.onOpenFile(excerpt.path)}>Open in Code</button></p>
        )}
      </div>
    </figure>
  );
}
