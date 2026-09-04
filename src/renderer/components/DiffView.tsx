import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import type { UiDiffLine, UiFileDiff } from "../../shared/workspace-kit-types";
import { ChevronsUpDown, MessageSquarePlus } from "lucide-react";
import { canonicalHighlightLanguage, highlightedCode, loadHighlightLanguage } from "./Markdown";

interface IntralineParts { before: string; changed: string; after: string; }

const EXTENSIONS: Record<string, string> = {
  bash: "bash", css: "css", go: "go", html: "xml", htm: "xml", js: "javascript", jsx: "javascript",
  json: "json", md: "markdown", mjs: "javascript", py: "python", rs: "rust", sh: "shell", sql: "sql",
  ts: "typescript", tsx: "typescript", xml: "xml", yaml: "yaml", yml: "yaml", zsh: "shell",
};

export function diffLanguage(path: string): string | undefined {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return extension ? EXTENSIONS[extension] : undefined;
}

export function intralineParts(left: string, right: string): [IntralineParts, IntralineParts] | undefined {
  let prefix = 0;
  const limit = Math.min(left.length, right.length);
  while (prefix < limit && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < limit - prefix && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix += 1;
  if (prefix === 0 && suffix === 0) return undefined;
  return [
    { before: left.slice(0, prefix), changed: left.slice(prefix, left.length - suffix), after: left.slice(left.length - suffix) },
    { before: right.slice(0, prefix), changed: right.slice(prefix, right.length - suffix), after: right.slice(right.length - suffix) },
  ];
}

function intralineMap(diff: UiFileDiff): Map<UiDiffLine, IntralineParts> {
  const result = new Map<UiDiffLine, IntralineParts>();
  for (const hunk of diff.hunks) {
    for (let index = 0; index < hunk.lines.length;) {
      if (hunk.lines[index]?.kind !== "removed") { index += 1; continue; }
      const removed: UiDiffLine[] = [];
      const added: UiDiffLine[] = [];
      while (hunk.lines[index]?.kind === "removed") removed.push(hunk.lines[index++]!);
      while (hunk.lines[index]?.kind === "added") added.push(hunk.lines[index++]!);
      for (let pair = 0; pair < Math.min(removed.length, added.length); pair += 1) {
        const parts = intralineParts(removed[pair]!.text, added[pair]!.text);
        if (parts) { result.set(removed[pair]!, parts[0]); result.set(added[pair]!, parts[1]); }
      }
    }
  }
  return result;
}

const HighlightedText = memo(function HighlightedText({ text, language, ready, parts }: { text: string; language?: string; ready: boolean; parts?: IntralineParts }) {
  const render = (value: string, className?: string): ReactNode => {
    const html = ready && language ? highlightedCode(value, canonicalHighlightLanguage(language)) : undefined;
    return <span className={className} {...(html === undefined ? { children: value } : { dangerouslySetInnerHTML: { __html: html } })} />;
  };
  return parts
    ? <>{render(parts.before)}{render(parts.changed, "diff-inline-change")}{render(parts.after)}</>
    : render(text);
});

const Row = memo(function Row({ line, split, language, ready, parts }: { line: UiDiffLine; split: boolean; language?: string; ready: boolean; parts?: IntralineParts }) {
  const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ";
  const className = `diff-${line.kind}`;
  const code = <HighlightedText text={line.text} language={language} ready={ready} parts={parts} />;
  if (!split) return <><span className={`diff-gutter ${className}`}>{line.newLine ?? line.oldLine ?? ""}</span><span className={`diff-code ${className}`}><i>{sign}</i> {code}</span></>;
  const showLeft = line.kind !== "added";
  const showRight = line.kind !== "removed";
  return <><span className={`diff-gutter ${showLeft ? className : ""}`}>{showLeft ? line.oldLine ?? "" : ""}</span><span className={`diff-code ${showLeft ? className : ""}`}>{showLeft ? code : ""}</span><span className={`diff-gutter ${showRight ? className : ""}`}>{showRight ? line.newLine ?? "" : ""}</span><span className={`diff-code ${showRight ? className : ""}`}>{showRight ? code : ""}</span></>;
});

export function DiffView({ diff, mode, path, embedded = false, onLoadMore, onExpandContext, onAnnotate, annotationCounts }: {
  diff?: UiFileDiff;
  mode: "unified" | "split";
  path?: string;
  embedded?: boolean;
  onLoadMore?(): void;
  onExpandContext?(): void;
  onAnnotate?(line: number): void;
  annotationCounts?: ReadonlyMap<number, number>;
}) {
  const language = diffLanguage(path ?? diff?.path ?? "");
  const [languageReady, setLanguageReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLanguageReady(false);
    if (!language) return;
    void loadHighlightLanguage(language).then(() => { if (!cancelled) setLanguageReady(true); });
    return () => { cancelled = true; };
  }, [language]);
  const inline = useMemo(() => diff ? intralineMap(diff) : new Map<UiDiffLine, IntralineParts>(), [diff]);

  if (!diff) return <div className="diff-empty">Loading diff…</div>;
  if (diff.hunks.length === 0 && diff.note) return <div className="diff-empty">{diff.note}</div>;
  if (diff.hunks.length === 0) return <div className="diff-empty">No changes in this file.</div>;
  let previousLine = 0;
  const rows = diff.hunks.flatMap((hunk, index) => {
    const firstLine = hunk.lines.find((line) => line.newLine !== undefined || line.oldLine !== undefined);
    const firstLineNumber = firstLine?.newLine ?? firstLine?.oldLine ?? previousLine + 1;
    const unchanged = Math.max(0, firstLineNumber - previousLine - 1);
    const entries = [
      ...(onExpandContext ? unchanged > 0 ? [{ key: `gap-${index}`, unchanged } as const] : [] : [{ key: `header-${index}`, header: hunk.header } as const]),
      ...hunk.lines.map((line, lineIndex) => ({ key: `line-${index}-${lineIndex}`, line } as const)),
    ];
    const lastLine = [...hunk.lines].reverse().find((line) => line.newLine !== undefined || line.oldLine !== undefined);
    previousLine = lastLine?.newLine ?? lastLine?.oldLine ?? previousLine;
    return entries;
  });
  return <div className={`diff-scroll ${embedded ? "embedded" : ""}`}>
    {diff.note ? <div className="diff-truncation" role="status">{diff.note}</div> : null}
    <div className="diff-rows">{rows.map((entry) => "unchanged" in entry
      ? <button className="diff-context-gap" key={entry.key} disabled={!onExpandContext} onClick={onExpandContext}>
          <ChevronsUpDown size={12} /><span>{entry.unchanged} unchanged {entry.unchanged === 1 ? "line" : "lines"}</span>
        </button>
      : "header" in entry
        ? <div className="diff-hunk-header" key={entry.key}>{entry.header}</div>
        : (() => {
          const lineNumber = entry.line.newLine ?? entry.line.oldLine;
          const count = lineNumber === undefined ? 0 : annotationCounts?.get(lineNumber) ?? 0;
          return <div className="diff-row" key={entry.key}>
            <div className={`diff-grid ${mode === "split" ? "split" : ""}`}><Row line={entry.line} split={mode === "split"} language={language} ready={languageReady} parts={inline.get(entry.line)} /></div>
            {onAnnotate && lineNumber !== undefined ? <button className={`diff-annotate ${count ? "has-comments" : ""}`} title="Add line comment" aria-label={`Comment on line ${lineNumber}`} onClick={() => onAnnotate(lineNumber)}><MessageSquarePlus size={12} />{count ? <span>{count}</span> : null}</button> : null}
          </div>;
        })())}</div>
    {diff.truncated ? <button className="diff-load-more" onClick={onLoadMore} disabled={!onLoadMore}>Load more diff hunks</button> : null}
  </div>;
}
