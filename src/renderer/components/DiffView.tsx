import type { UiDiffLine, UiFileDiff } from "../../shared/contracts";
import { ChevronsUpDown, MessageSquarePlus } from "lucide-react";
import { VirtualList } from "./VirtualList";

function Row({ line, split }: { line: UiDiffLine; split: boolean }) {
  const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ";
  const className = `diff-${line.kind}`;
  if (!split) return <><span className={`diff-gutter ${className}`}>{line.newLine ?? line.oldLine ?? ""}</span><span className={`diff-code ${className}`}><i>{sign}</i> {line.text}</span></>;
  const showLeft = line.kind !== "added";
  const showRight = line.kind !== "removed";
  return <><span className={`diff-gutter ${showLeft ? className : ""}`}>{showLeft ? line.oldLine ?? "" : ""}</span><span className={`diff-code ${showLeft ? className : ""}`}>{showLeft ? line.text : ""}</span><span className={`diff-gutter ${showRight ? className : ""}`}>{showRight ? line.newLine ?? "" : ""}</span><span className={`diff-code ${showRight ? className : ""}`}>{showRight ? line.text : ""}</span></>;
}

export function DiffView({ diff, mode, onLoadMore, onExpandContext, onAnnotate, annotationCounts }: {
  diff?: UiFileDiff;
  mode: "unified" | "split";
  onLoadMore?(): void;
  onExpandContext?(): void;
  onAnnotate?(line: number): void;
  annotationCounts?: ReadonlyMap<number, number>;
}) {
  if (!diff) return <div className="diff-empty">Loading diff…</div>;
  if (diff.hunks.length === 0 && diff.note) return <div className="diff-empty">{diff.note}</div>;
  if (diff.hunks.length === 0) return <div className="diff-empty">No changes in this file.</div>;
  let previousLine = 0;
  const rows = diff.hunks.flatMap((hunk, index) => {
    const firstLine = hunk.lines.find((line) => line.newLine !== undefined || line.oldLine !== undefined);
    const firstLineNumber = firstLine?.newLine ?? firstLine?.oldLine ?? previousLine + 1;
    const unchanged = Math.max(0, firstLineNumber - previousLine - 1);
    const entries = [
      ...(onExpandContext
        ? unchanged > 0 ? [{ key: `gap-${index}`, unchanged } as const] : []
        : [{ key: `header-${index}`, header: hunk.header } as const]),
      ...hunk.lines.map((line, lineIndex) => ({ key: `line-${index}-${lineIndex}`, line } as const)),
    ];
    const lastLine = [...hunk.lines].reverse().find((line) => line.newLine !== undefined || line.oldLine !== undefined);
    previousLine = lastLine?.newLine ?? lastLine?.oldLine ?? previousLine;
    return entries;
  });
  return <div className="diff-scroll">
    {diff.note ? <div className="diff-truncation" role="status">{diff.note}</div> : null}
    <VirtualList items={rows} itemHeight={26} className="diff-virtual-list" renderItem={(entry) => "unchanged" in entry
      ? <button className="diff-context-gap" key={entry.key} disabled={!onExpandContext} onClick={onExpandContext}>
          <ChevronsUpDown size={12} />
          <span>{entry.unchanged} unchanged {entry.unchanged === 1 ? "line" : "lines"}</span>
        </button>
      : "header" in entry
        ? <div className="diff-hunk-header" key={entry.key}>{entry.header}</div>
      : (() => {
        const line = entry.line.newLine ?? entry.line.oldLine;
        const count = line === undefined ? 0 : annotationCounts?.get(line) ?? 0;
        return <div className="diff-row" key={entry.key}>
          <div className={`diff-grid ${mode === "split" ? "split" : ""}`}><Row line={entry.line} split={mode === "split"} /></div>
          {onAnnotate && line !== undefined ? <button className={`diff-annotate ${count ? "has-comments" : ""}`} title="Add line comment" aria-label={`Comment on line ${line}`} onClick={() => onAnnotate(line)}>
            <MessageSquarePlus size={12} />{count ? <span>{count}</span> : null}
          </button> : null}
        </div>;
      })()}
    />
    {diff.truncated ? <button className="diff-load-more" onClick={onLoadMore} disabled={!onLoadMore}>Load more diff hunks</button> : null}
  </div>;
}
