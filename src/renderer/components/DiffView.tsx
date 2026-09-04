import { useVirtualizer } from "@tanstack/react-virtual";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { UiChangedFile, UiDiffLine, UiFileDiff } from "../../shared/workspace-kit-types";
import { ChevronsUpDown, MessageSquarePlus } from "lucide-react";
import { canonicalHighlightLanguage, highlightSource, loadHighlightLanguage } from "./Markdown";

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

/** Left/right side of a replaced line pair. */
type IntralineSide = 0 | 1;

/** Pairs replaced lines without comparing their text; the comparison is deferred to render. */
function intralinePairs(diff: UiFileDiff): Map<UiDiffLine, { partner: UiDiffLine; side: IntralineSide }> {
  const result = new Map<UiDiffLine, { partner: UiDiffLine; side: IntralineSide }>();
  for (const hunk of diff.hunks) {
    for (let index = 0; index < hunk.lines.length;) {
      if (hunk.lines[index]?.kind !== "removed") { index += 1; continue; }
      const removed: UiDiffLine[] = [];
      const added: UiDiffLine[] = [];
      while (hunk.lines[index]?.kind === "removed") removed.push(hunk.lines[index++]!);
      while (hunk.lines[index]?.kind === "added") added.push(hunk.lines[index++]!);
      for (let pair = 0; pair < Math.min(removed.length, added.length); pair += 1) {
        result.set(removed[pair]!, { partner: added[pair]!, side: 0 });
        result.set(added[pair]!, { partner: removed[pair]!, side: 1 });
      }
    }
  }
  return result;
}

const intralineCache = new WeakMap<UiDiffLine, IntralineParts | null>();

/** Computed for rendered rows only, then cached until the diff object is replaced. */
function cachedIntraline(line: UiDiffLine, partner: UiDiffLine, side: IntralineSide): IntralineParts | undefined {
  const cached = intralineCache.get(line);
  if (cached !== undefined) return cached ?? undefined;
  const pair = side === 0 ? intralineParts(line.text, partner.text) : intralineParts(partner.text, line.text);
  const parts = pair?.[side];
  intralineCache.set(line, parts ?? null);
  return parts;
}

/** Per-line syntax cache. It dies with the diff object instead of evicting the streaming Markdown cache. */
const highlightedSegments = new WeakMap<UiDiffLine, Map<string, string>>();

function cachedHighlight(line: UiDiffLine, segment: string, language: string): string | undefined {
  let perLine = highlightedSegments.get(line);
  if (!perLine) { perLine = new Map(); highlightedSegments.set(line, perLine); }
  const key = `${language}\0${segment}`;
  const cached = perLine.get(key);
  if (cached !== undefined) return cached;
  // Skipped while the grammar chunk is still loading; nothing is cached then.
  const highlighted = highlightSource(segment, language);
  if (highlighted !== undefined) perLine.set(key, highlighted);
  return highlighted;
}

/** Resolves the grammar chunks a diff needs and reports a version so rows re-highlight once. */
function useHighlightLanguages(languages: readonly string[]): number {
  const [version, setVersion] = useState(0);
  const key = useMemo(() => [...new Set(languages)].sort().join(","), [languages]);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void Promise.all(key.split(",").map((language) => loadHighlightLanguage(language)))
      .then(() => { if (!cancelled) setVersion((current) => current + 1); });
    return () => { cancelled = true; };
  }, [key]);
  return version;
}

const HighlightedText = memo(function HighlightedText({ line, text, language, parts }: {
  line: UiDiffLine;
  text: string;
  language?: string;
  /** Bumped when a grammar finishes loading so memoized rows re-highlight. */
  version: number;
  parts?: IntralineParts;
}) {
  const render = (value: string, className?: string): ReactNode => {
    const html = language ? cachedHighlight(line, value, canonicalHighlightLanguage(language)) : undefined;
    return <span className={className} {...(html === undefined ? { children: value } : { dangerouslySetInnerHTML: { __html: html } })} />;
  };
  return parts
    ? <>{render(parts.before)}{render(parts.changed, "diff-inline-change")}{render(parts.after)}</>
    : render(text);
});

const Row = memo(function Row({ line, split, language, version, partner, side }: { line: UiDiffLine; split: boolean; language?: string; version: number; partner?: UiDiffLine; side?: IntralineSide }) {
  const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ";
  const className = `diff-${line.kind}`;
  const parts = partner && side !== undefined ? cachedIntraline(line, partner, side) : undefined;
  const code = <HighlightedText line={line} text={line.text} language={language} version={version} parts={parts} />;
  if (!split) return <><span className={`diff-gutter ${className}`}>{line.newLine ?? line.oldLine ?? ""}</span><span className={`diff-code ${className}`}><i>{sign}</i> {code}</span></>;
  const showLeft = line.kind !== "added";
  const showRight = line.kind !== "removed";
  return <><span className={`diff-gutter ${showLeft ? className : ""}`}>{showLeft ? line.oldLine ?? "" : ""}</span><span className={`diff-code ${showLeft ? className : ""}`}>{showLeft ? code : ""}</span><span className={`diff-gutter ${showRight ? className : ""}`}>{showRight ? line.newLine ?? "" : ""}</span><span className={`diff-code ${showRight ? className : ""}`}>{showRight ? code : ""}</span></>;
});

export type DiffStreamRow =
  | { kind: "file"; key: string; path: string; file: UiChangedFile; diff?: UiFileDiff }
  | { kind: "note"; key: string; path: string; text: string }
  | { kind: "hunk"; key: string; path: string; text: string }
  | { kind: "gap"; key: string; path: string; unchanged: number }
  | { kind: "line"; key: string; path: string; line: UiDiffLine; language?: string; partner?: UiDiffLine; side?: IntralineSide }
  | { kind: "status"; key: string; path: string; title?: string; text: string }
  | { kind: "more"; key: string; path: string }
  /** Gap between two file cards. Its empty path keeps it outside both. */
  | { kind: "separator"; key: string; path: "" };

const LINE_HEIGHT = 26;
/** Rough monospace column count used only until a row is measured. */
const WRAP_COLUMNS = 118;
const FALLBACK_ROWS = 24;

function rowEstimate(row: DiffStreamRow | undefined, split: boolean): number {
  switch (row?.kind) {
    case "file": return 40;
    case "hunk": return 42;
    case "note": return 34;
    case "status": return 76;
    case "more": return 62;
    case "separator": return 14;
    case "line": return LINE_HEIGHT * Math.max(1, Math.ceil(row.line.text.length / (split ? WRAP_COLUMNS / 2 : WRAP_COLUMNS)));
    default: return LINE_HEIGHT;
  }
}

/** Flattens one file's diff into stream rows. Collapsible streams show context gaps instead of hunk headers. */
export function fileDiffRows(path: string, diff: UiFileDiff | undefined, options: { collapsible: boolean; error?: string } = { collapsible: false }): DiffStreamRow[] {
  if (!diff) {
    return [options.error
      ? { kind: "status", key: `${path}\0error`, path, title: "Failed to load diff", text: options.error }
      : { kind: "status", key: `${path}\0loading`, path, text: "Loading diff…" }];
  }
  if (diff.hunks.length === 0) {
    return [{ kind: "status", key: `${path}\0empty`, path, text: diff.note ?? "No changes in this file." }];
  }
  const rows: DiffStreamRow[] = diff.note ? [{ kind: "note", key: `${path}\0note`, path, text: diff.note }] : [];
  const language = diffLanguage(path || diff.path);
  const pairs = intralinePairs(diff);
  let previousLine = 0;
  diff.hunks.forEach((hunk, index) => {
    const firstLine = hunk.lines.find((line) => line.newLine !== undefined || line.oldLine !== undefined);
    const firstLineNumber = firstLine?.newLine ?? firstLine?.oldLine ?? previousLine + 1;
    const unchanged = Math.max(0, firstLineNumber - previousLine - 1);
    if (options.collapsible) {
      if (unchanged > 0) rows.push({ kind: "gap", key: `${path}\0gap-${index}`, path, unchanged });
    } else {
      rows.push({ kind: "hunk", key: `${path}\0header-${index}`, path, text: hunk.header });
    }
    hunk.lines.forEach((line, lineIndex) => {
      const pair = pairs.get(line);
      rows.push({ kind: "line", key: `${path}\0line-${index}-${lineIndex}`, path, line, ...(language ? { language } : {}), ...(pair ?? {}) });
    });
    const lastLine = [...hunk.lines].reverse().find((line) => line.newLine !== undefined || line.oldLine !== undefined);
    previousLine = lastLine?.newLine ?? lastLine?.oldLine ?? previousLine;
  });
  if (diff.truncated) rows.push({ kind: "more", key: `${path}\0more`, path });
  return rows;
}

export interface DiffStreamHandle {
  /** Aligns the first row of a file with the top of the viewport. */
  scrollToPath(path: string): void;
}

export interface DiffStreamProps {
  rows: readonly DiffStreamRow[];
  mode: "unified" | "split";
  /** Scroll element that owns the window; the stream renders inside it. */
  scrollRef: RefObject<HTMLDivElement | null>;
  languages?: readonly string[];
  activePath?: string;
  annotationCount?(path: string, line: number): number;
  onAnnotate?(path: string, line: number): void;
  onExpandContext?(): void;
  onLoadMore?(path: string): void;
  renderFileHeader?(file: UiChangedFile, diff?: UiFileDiff): ReactNode;
  onVisiblePathChange?(path: string): void;
}

const NO_LANGUAGES: readonly string[] = [];

/** One virtualized window over every row of every file in a review. */
export const DiffStream = forwardRef<DiffStreamHandle, DiffStreamProps>(function DiffStream({
  rows,
  mode,
  scrollRef,
  languages = NO_LANGUAGES,
  activePath,
  annotationCount,
  onAnnotate,
  onExpandContext,
  onLoadMore,
  renderFileHeader,
  onVisiblePathChange,
}, ref) {
  const split = mode === "split";
  const version = useHighlightLanguages(languages);
  const estimateSize = useCallback((index: number) => rowEstimate(rows[index], split), [rows, split]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey: (index) => rows[index]?.key ?? index,
    // Bounds the first pass; the real viewport is measured right after mount.
    initialRect: { width: 900, height: 320 },
    overscan: 4,
    useAnimationFrameWithResizeObserver: true,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;

  useImperativeHandle(ref, () => ({
    scrollToPath(path: string) {
      const index = rows.findIndex((row) => row.path === path);
      if (index >= 0) virtualizer.scrollToIndex(index, { align: "start" });
    },
  }), [rows, virtualizer]);

  const rangeStart = virtualizer.range?.startIndex;
  const visiblePath = rangeStart === undefined ? undefined : rows[rangeStart]?.path;
  useEffect(() => {
    if (visiblePath) onVisiblePathChange?.(visiblePath);
  }, [onVisiblePathChange, visiblePath]);

  const measured = virtualizer.getVirtualItems();
  // Before the scroll element is measured, show a small head so the first paint
  // (and every jsdom render) still has content.
  const items = measured.length > 0
    ? measured
    : rows.slice(0, FALLBACK_ROWS).map((row, index) => ({ index, key: row.key, start: index * LINE_HEIGHT }));

  const renderRow = (row: DiffStreamRow): ReactNode => {
    switch (row.kind) {
      case "file":
        return renderFileHeader?.(row.file, row.diff) ?? null;
      case "note":
        return <div className="diff-truncation" role="status">{row.text}</div>;
      case "hunk":
        return <div className="diff-hunk-header">{row.text}</div>;
      case "gap":
        return <button className="diff-context-gap" disabled={!onExpandContext} onClick={onExpandContext}>
          <ChevronsUpDown size={12} /><span>{row.unchanged} unchanged {row.unchanged === 1 ? "line" : "lines"}</span>
        </button>;
      case "status":
        return <div className={`diff-empty ${row.title ? "diff-error" : ""}`}>{row.title ? <strong>{row.title}</strong> : null}<span>{row.text}</span></div>;
      case "more":
        return <button className="diff-load-more" disabled={!onLoadMore} onClick={() => onLoadMore?.(row.path)}>Load more diff hunks</button>;
      case "separator":
        return null;
      case "line": {
        const lineNumber = row.line.newLine ?? row.line.oldLine;
        const count = lineNumber === undefined ? 0 : annotationCount?.(row.path, lineNumber) ?? 0;
        return <div className="diff-row">
          <div className={`diff-grid ${split ? "split" : ""}`}>
            <Row line={row.line} split={split} language={row.language} version={version} partner={row.partner} side={row.side} />
          </div>
          {onAnnotate && lineNumber !== undefined ? <button
            className={`diff-annotate ${count ? "has-comments" : ""}`}
            title="Add line comment"
            aria-label={`Comment on line ${lineNumber}`}
            onClick={() => onAnnotate(row.path, lineNumber)}
          ><MessageSquarePlus size={12} />{count ? <span>{count}</span> : null}</button> : null}
        </div>;
      }
    }
  };

  return <div className="diff-stream" style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
    {items.map((item) => {
      const row = rows[item.index];
      if (!row) return null;
      const previous = rows[item.index - 1];
      const next = rows[item.index + 1];
      return <div
        key={row.key}
        ref={virtualizer.measureElement}
        data-index={item.index}
        data-path={row.path}
        className={[
          "diff-stream-row",
          row.kind === "separator" ? "separator" : "",
          previous?.path === row.path ? "" : "file-start",
          next?.path === row.path ? "" : "file-end",
          row.path === activePath ? "active" : "",
        ].filter(Boolean).join(" ")}
        style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
      >{renderRow(row)}</div>;
    })}
  </div>;
});

/** One file's diff with its own scroll element; review mode uses `DiffStream` directly. */
export function DiffView({ diff, mode, path, onLoadMore, onExpandContext, onAnnotate, annotationCounts }: {
  diff?: UiFileDiff;
  mode: "unified" | "split";
  path?: string;
  onLoadMore?(): void;
  onExpandContext?(): void;
  onAnnotate?(line: number): void;
  annotationCounts?: ReadonlyMap<number, number>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const filePath = path ?? diff?.path ?? "";
  const collapsible = Boolean(onExpandContext);
  const languages = useMemo(() => {
    const language = diffLanguage(filePath);
    return language ? [language] : NO_LANGUAGES;
  }, [filePath]);
  const rows = useMemo(
    () => diff && diff.hunks.length > 0 ? fileDiffRows(filePath, diff, { collapsible }) : [],
    [collapsible, diff, filePath],
  );
  const annotationCount = useCallback((_path: string, line: number) => annotationCounts?.get(line) ?? 0, [annotationCounts]);
  const annotate = useCallback((_path: string, line: number) => onAnnotate?.(line), [onAnnotate]);

  if (!diff) return <div className="diff-empty">Loading diff…</div>;
  if (diff.hunks.length === 0 && diff.note) return <div className="diff-empty">{diff.note}</div>;
  if (diff.hunks.length === 0) return <div className="diff-empty">No changes in this file.</div>;
  return <div className="diff-scroll" ref={scrollRef}>
    <DiffStream
      rows={rows}
      mode={mode}
      scrollRef={scrollRef}
      languages={languages}
      annotationCount={annotationCount}
      {...(onAnnotate ? { onAnnotate: annotate } : {})}
      {...(onExpandContext ? { onExpandContext } : {})}
      {...(onLoadMore ? { onLoadMore } : {})}
    />
  </div>;
}
