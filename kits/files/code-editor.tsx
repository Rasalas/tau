import { useEffect, useRef, useState } from "react";
import type { CodeEditorCallbacks, CodeEditorHandle } from "./editor-view.js";

const isMac = () => typeof navigator !== "undefined" && /mac|iphone|ipad/iu.test(navigator.platform);

/** CodeMirror is evaluated the first time a file opens, not when the kit activates. */
let editorModule: Promise<typeof import("./editor-view.js")> | undefined;
export const loadEditorModule = () => editorModule ??= import("./editor-view.js");

/**
 * CodeMirror 6 over one document: search and replace on `mod+f`, folding,
 * bracket matching, several cursors and a language mode per file type. The
 * view lives as long as the component; the text stays the document's.
 */
export function CodeEditor({ text, path, label, readOnly, wrap, line, reveal, onChange, onCaretLine }: {
  text: string;
  path: string;
  label: string;
  readOnly: boolean;
  wrap: boolean;
  /** 1-based line to put the caret on; `reveal` counts requests so the same line can be asked for again. */
  line?: number;
  reveal?: number;
  onChange(text: string): void;
  onCaretLine?(line: number): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<CodeEditorHandle>();
  const callbacks = useRef<CodeEditorCallbacks>({ onChange, onCaretLine });
  callbacks.current = { onChange, onCaretLine };
  // The first value of each; later ones reach the view through the effects below.
  const initial = useRef({ text, readOnly, wrap, label });

  useEffect(() => {
    let cancelled = false;
    let created: CodeEditorHandle | undefined;
    void loadEditorModule().then(({ createCodeEditor }) => {
      if (cancelled || !host.current) return;
      created = createCodeEditor(host.current, {
        ...initial.current,
        path,
        mac: isMac(),
        callbacks: {
          onChange: (next) => callbacks.current.onChange(next),
          onCaretLine: (next) => callbacks.current.onCaretLine?.(next),
        },
      });
      setEditor(created);
    });
    return () => {
      cancelled = true;
      created?.destroy();
    };
  }, [path]);

  useEffect(() => { editor?.setText(text); }, [editor, text]);
  useEffect(() => { editor?.setReadOnly(readOnly); }, [editor, readOnly]);
  useEffect(() => { editor?.setWrap(wrap); }, [editor, wrap]);
  // Only a new request moves the caret; typing must not.
  useEffect(() => { if (editor && line) editor.reveal(line); }, [editor, line, reveal]);

  return <div className="files-code" ref={host} data-wrap={wrap || undefined} />;
}
