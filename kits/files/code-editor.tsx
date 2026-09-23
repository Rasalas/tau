import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { canonicalHighlightLanguage, highlightSource, loadHighlightLanguage } from "tau";
import { editorKeyOutcome, indentUnit, lineIndent, shiftLines } from "./keys.js";

/** Past this, highlighting on every keystroke would lag; the text stays plain. */
export const LIVE_HIGHLIGHT_LIMIT = 100 * 1024;

const isMac = () => typeof navigator !== "undefined" && /mac|iphone|ipad/iu.test(navigator.platform);

function countLines(text: string): number {
  let count = 1;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) count += 1;
  return count;
}

/** Types through the browser's own editing, so the text field's undo keeps every step. */
function insertText(field: HTMLTextAreaElement, text: string): void {
  if (!document.execCommand?.("insertText", false, text)) field.setRangeText(text, field.selectionStart, field.selectionEnd, "end");
}

/**
 * A text field over core's highlighter: the `<pre>` draws the colours, the
 * transparent `<textarea>` on top of it takes the keys, the caret and the
 * selection, and both share one font and one box so every character sits in
 * the same place. Big files stay plain text. CodeMirror 6 would not fit the
 * workbench's bundle budget; this costs nothing core does not already load.
 */
export function CodeEditor({ text, language, label, readOnly, line, reveal, onChange, onCaretLine }: {
  text: string;
  language?: string;
  /** What a screen reader calls the field. */
  label: string;
  readOnly: boolean;
  /** 1-based line to put the caret on; `reveal` counts requests so the same line can be asked for again. */
  line?: number;
  reveal?: number;
  onChange(text: string): void;
  onCaretLine?(line: number): void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const canonical = language ? canonicalHighlightLanguage(language) : undefined;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    if (!canonical) return;
    let cancelled = false;
    void loadHighlightLanguage(canonical).then(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [canonical]);

  const html = useMemo(
    () => ready && canonical && text.length <= LIVE_HIGHLIGHT_LIMIT ? highlightSource(text, canonical) : undefined,
    [canonical, ready, text],
  );
  const lines = useMemo(() => countLines(text), [text]);
  const gutter = useMemo(() => Array.from({ length: lines }, (_, index) => index + 1).join("\n"), [lines]);
  // A trailing newline starts a line the <pre> would not draw; the space gives it height.
  const tail = text.endsWith("\n") || text.length === 0 ? " " : "";

  useLayoutEffect(() => {
    const target = field.current;
    const box = scroller.current;
    if (!line || !target || !box) return;
    const lineHeight = Number.parseFloat(getComputedStyle(target).lineHeight) || 20;
    let offset = 0;
    for (let current = 1; current < line; current += 1) {
      const next = text.indexOf("\n", offset);
      if (next < 0) break;
      offset = next + 1;
    }
    target.focus({ preventScroll: true });
    target.setSelectionRange(offset, offset);
    box.scrollTop = Math.max(0, (line - 1) * lineHeight - box.clientHeight / 3);
    // Only a new request moves the caret; typing must not.
  }, [line, reveal]);

  const reportCaret = () => {
    const target = field.current;
    if (target && onCaretLine) onCaretLine(countLines(target.value.slice(0, target.selectionStart)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const target = event.currentTarget;
    const outcome = editorKeyOutcome(event, isMac(), readOnly);
    if (outcome === "pass") return;
    if (outcome === "native") { event.stopPropagation(); return; }
    event.preventDefault();
    event.stopPropagation();
    if (outcome === "swallow") return;
    const value = target.value;
    const unit = indentUnit(value);
    if (outcome === "newline") {
      insertText(target, `\n${lineIndent(value, target.selectionStart)}`);
      return;
    }
    const { selectionStart: start, selectionEnd: end } = target;
    if (outcome === "indent" && !value.slice(start, end).includes("\n")) {
      insertText(target, unit);
      return;
    }
    const shifted = shiftLines(value, start, end, unit, outcome === "outdent");
    target.setSelectionRange(shifted.from, shifted.to);
    insertText(target, shifted.replacement);
    target.setSelectionRange(shifted.start, shifted.end);
  };

  return <div className="files-code" ref={scroller} onClick={() => field.current?.focus()}>
    <div className="files-code-grid">
      <pre className="files-code-gutter" aria-hidden>{gutter}</pre>
      <div className="files-code-body">
        {html !== undefined
          ? <pre className="files-code-text hljs" aria-hidden dangerouslySetInnerHTML={{ __html: html + tail }} />
          : <pre className="files-code-text" aria-hidden>{text + tail}</pre>}
        <textarea
          ref={field}
          className="files-code-input"
          aria-label={label}
          value={text}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          wrap="off"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onKeyUp={reportCaret}
          onMouseUp={reportCaret}
        />
      </div>
    </div>
  </div>;
}
