import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { DiffLoadOptions, UiEditor, UiFileContent, UiFileDiff } from "../../shared/workspace-kit-types";
import type { StageFileTab, StageView } from "../../workbench/stage";
import type { CommandContribution, WorkbenchActions } from "../extension-system";
import { errorMessage } from "../../workbench/error-message";
import { canonicalHighlightLanguage, highlightSource, loadHighlightLanguage } from "./Markdown";
import { DiffPane } from "./DiffPane";
import { formatBytes } from "../format-bytes";

/** Past this, highlighting a whole file stalls the renderer; plain text still reads fine. */
const HIGHLIGHT_LIMIT_BYTES = 200 * 1024;

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) count += 1;
  return text.endsWith("\n") ? count - 1 : count;
}

/** Where line `line` sits in the code block, from its own padding and line height. */
function lineBox(code: HTMLElement, line: number): { top: number; height: number } {
  const style = getComputedStyle(code);
  const height = Number.parseFloat(style.lineHeight) || 21;
  return { top: (Number.parseFloat(style.paddingTop) || 0) + (line - 1) * height, height };
}

function SourceView({ content, line, reveal }: { content: UiFileContent; line?: number; reveal?: number }) {
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
  const target = line ? Math.min(line, Math.max(lines, 1)) : undefined;
  const scroller = useRef<HTMLDivElement>(null);
  const code = useRef<HTMLPreElement>(null);
  const [mark, setMark] = useState<{ top: number; height: number }>();

  // Highlighting swaps the <pre>, not its geometry, so the text is what moves the line.
  useLayoutEffect(() => {
    if (!target || !scroller.current || !code.current) { setMark(undefined); return; }
    const box = lineBox(code.current, target);
    setMark(box);
    scroller.current.scrollTop = Math.max(0, box.top - scroller.current.clientHeight / 3);
  }, [target, reveal, text]);

  return <div className="source-scroll" ref={scroller}>
    <div className="source-grid">
      {mark && target ? <div className="source-line-mark" data-line={target} aria-hidden style={{ top: mark.top, height: mark.height }} /> : null}
      <pre className="source-gutter" aria-hidden>{gutter}</pre>
      {html !== undefined
        ? <pre ref={code} className="source-code hljs" dangerouslySetInnerHTML={{ __html: html }} />
        : <pre ref={code} className="source-code">{text}</pre>}
    </div>
    {content.truncated ? <div className="source-note" role="status">Showing the first {formatBytes(text.length)} of {formatBytes(content.size)}. Open the file in an editor for the rest.</div> : null}
  </div>;
}

export function FileViewer({ tab, relativePath, changed, editor, commands = [], actions, loadFile, loadDiff, onChangeView, onOpenInEditor }: {
  tab: StageFileTab;
  relativePath: string;
  /** The working tree differs from HEAD for this file, so a diff exists. */
  changed: boolean;
  editor?: UiEditor;
  /** Commands an extension offers on the `file-tab` surface; they read the tab from `actions.activeStageTab()`. */
  commands?: readonly CommandContribution[];
  actions?: WorkbenchActions;
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
      {actions ? commands.map((command) => (
        <button
          key={command.id}
          className="text-button"
          onClick={() => { Promise.resolve(command.run(actions)).catch((reason: unknown) => actions.notify(errorMessage(reason))); }}
        >{command.label}</button>
      )) : null}
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
              : <SourceView content={content} line={tab.line} reveal={tab.reveal} />}
  </div>;
}
