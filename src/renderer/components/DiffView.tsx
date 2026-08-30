import type { UiDiffLine, UiFileDiff } from "../../shared/contracts";

function Row({ line, split }: { line: UiDiffLine; split: boolean }) {
  const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ";
  const className = `diff-${line.kind}`;

  if (!split) {
    return (
      <>
        <span className={`diff-gutter ${className}`}>{line.newLine ?? line.oldLine ?? ""}</span>
        <span className={`diff-code ${className}`}><i>{sign}</i> {line.text}</span>
      </>
    );
  }

  const showLeft = line.kind !== "added";
  const showRight = line.kind !== "removed";
  return (
    <>
      <span className={`diff-gutter ${showLeft ? className : ""}`}>{showLeft ? line.oldLine ?? "" : ""}</span>
      <span className={`diff-code ${showLeft ? className : ""}`}>{showLeft ? line.text : ""}</span>
      <span className={`diff-gutter ${showRight ? className : ""}`}>{showRight ? line.newLine ?? "" : ""}</span>
      <span className={`diff-code ${showRight ? className : ""}`}>{showRight ? line.text : ""}</span>
    </>
  );
}

export function DiffView({ diff, mode }: { diff?: UiFileDiff; mode: "unified" | "split" }) {
  if (!diff) return <div className="diff-empty">Loading diff…</div>;
  if (diff.note) return <div className="diff-empty">{diff.note}</div>;
  if (diff.hunks.length === 0) return <div className="diff-empty">No changes in this file.</div>;

  return (
    <div className="diff-scroll">
      {diff.hunks.map((hunk, index) => (
        <div key={`${hunk.header}-${index}`}>
          <div className="diff-hunk-header">{hunk.header}</div>
          <div className={`diff-grid ${mode === "split" ? "split" : ""}`}>
            {hunk.lines.map((line, lineIndex) => (
              <Row key={lineIndex} line={line} split={mode === "split"} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
