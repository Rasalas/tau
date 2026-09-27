import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { UiFileContent } from "../../shared/workspace-kit-types";
import { canonicalHighlightLanguage, highlightSource, loadHighlightLanguage } from "./Markdown";
import { formatBytes } from "../format-bytes";

/** Past this, highlighting a whole file stalls the renderer; plain text still reads fine. */
const HIGHLIGHT_LIMIT_BYTES = 200 * 1024;

export function lineCount(text: string): number {
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

/**
 * A text file as the stage's file tab shows it: line numbers, highlighting
 * when the language is known and the file small enough, and `line` marked and
 * scrolled to (`reveal` counts requests for the same line).
 */
export function FileSource({ content, line, reveal }: { content: UiFileContent; line?: number; reveal?: number }) {
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
