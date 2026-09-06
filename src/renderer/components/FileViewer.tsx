import { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { DiffLoadOptions, UiEditor, UiFileContent, UiFileDiff } from "../../shared/workspace-kit-types";
import type { StageFileTab, StageView } from "../stage";
import { canonicalHighlightLanguage, highlightSource, loadHighlightLanguage } from "./Markdown";
import { DiffPane } from "./DiffPane";

/** Past this, highlighting a whole file stalls the renderer; plain text still reads fine. */
const HIGHLIGHT_LIMIT_BYTES = 200 * 1024;

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) count += 1;
  return text.endsWith("\n") ? count - 1 : count;
}

function SourceView({ content }: { content: UiFileContent }) {
  const text = content.text ?? "";
  const language = content.language ? canonicalHighlightLanguage(content.language) : undefined;
  const [html, setHtml] = useState<string>();

  useEffect(() => {
    setHtml(undefined);
    if (!language || text.length > HIGHLIGHT_LIMIT_BYTES) return;
    let cancelled = false;
    void loadHighlightLanguage(language).then(() => {
      if (!cancelled) setHtml(highlightSource(text, language));
    });
    return () => { cancelled = true; };
  }, [language, text]);

  const lines = useMemo(() => lineCount(text), [text]);
  const gutter = useMemo(() => Array.from({ length: Math.max(lines, 1) }, (_, index) => index + 1).join("\n"), [lines]);

  return <div className="source-scroll">
    <div className="source-grid">
      <pre className="source-gutter" aria-hidden>{gutter}</pre>
      {html !== undefined
        ? <pre className="source-code hljs" dangerouslySetInnerHTML={{ __html: html }} />
        : <pre className="source-code">{text}</pre>}
    </div>
    {content.truncated ? <div className="source-note" role="status">Showing the first {formatBytes(text.length)} of {formatBytes(content.size)}. Open the file in an editor for the rest.</div> : null}
  </div>;
}

export function FileViewer({ tab, relativePath, changed, editor, loadFile, loadDiff, onChangeView, onOpenInEditor }: {
  tab: StageFileTab;
  relativePath: string;
  /** The working tree differs from HEAD for this file, so a diff exists. */
  changed: boolean;
  editor?: UiEditor;
  loadFile(path: string): Promise<UiFileContent>;
  loadDiff(path: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  onChangeView(view: StageView): void;
  onOpenInEditor(path: string): void;
}) {
  const [content, setContent] = useState<UiFileContent>();
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const view: StageView = tab.view === "diff" && !changed ? "source" : tab.view;

  useEffect(() => {
    let cancelled = false;
    setContent(undefined);
    setError(undefined);
    loadFile(tab.path).then(
      (next) => { if (!cancelled) setContent(next); },
      (reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { cancelled = true; };
  }, [loadFile, tab.path]);

  const meta = content?.kind === "text"
    ? `${formatBytes(content.size)} · ${lineCount(content.text ?? "")} ${lineCount(content.text ?? "") === 1 ? "line" : "lines"}`
    : content ? formatBytes(content.size) : undefined;

  return <div className="stage-pane" data-view={view}>
    <header className="stage-pane-header">
      <strong title={tab.path}>{relativePath}</strong>
      {meta ? <small>{meta}</small> : null}
      <span className="spacer" />
      {changed ? (
        <div className="toggle-group" role="tablist" aria-label="View">
          <button className={view === "source" ? "active" : ""} onClick={() => onChangeView("source")}>Source</button>
          <button className={view === "diff" ? "active" : ""} onClick={() => onChangeView("diff")}>Diff</button>
        </div>
      ) : null}
      {view === "diff" ? (
        <div className="toggle-group" aria-label="Diff layout">
          <button className={mode === "unified" ? "active" : ""} onClick={() => setMode("unified")}>Unified</button>
          <button className={mode === "split" ? "active" : ""} onClick={() => setMode("split")}>Split</button>
        </div>
      ) : null}
      {editor ? (
        <button className="text-button" title={`Open in ${editor.name}`} onClick={() => onOpenInEditor(tab.path)}>
          <span>Open in {editor.name}</span> <ExternalLink size={11} />
        </button>
      ) : null}
    </header>
    {view === "diff"
      ? <DiffPane path={relativePath} mode={mode} loadDiff={loadDiff} />
      : error
        ? <div className="stage-empty">{error}</div>
        : !content
          ? <div className="stage-empty">Loading…</div>
          : content.kind === "image"
            ? <div className="stage-image"><img src={content.dataUrl} alt={content.name} /></div>
            : content.kind === "binary"
              ? <div className="stage-empty">Binary file ({formatBytes(content.size)}) — nothing to show here.</div>
              : <SourceView content={content} />}
  </div>;
}
