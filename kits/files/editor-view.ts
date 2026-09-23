import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, EditorSelection, EditorState, Prec } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { tauEditorTheme } from "./editor-theme.js";
import { editorKeyOutcome, indentUnit as detectIndentUnit } from "./keys.js";
import { editorLanguageFor } from "./languages.js";

export interface CodeEditorCallbacks {
  onChange(text: string): void;
  onCaretLine?(line: number): void;
}

export interface CodeEditorOptions {
  text: string;
  /** Picks the language mode by file name. */
  path: string;
  /** What a screen reader calls the editor. */
  label: string;
  readOnly: boolean;
  wrap: boolean;
  callbacks: CodeEditorCallbacks;
  mac: boolean;
}

export interface CodeEditorHandle {
  readonly view: EditorView;
  setText(text: string): void;
  setReadOnly(readOnly: boolean): void;
  setWrap(wrap: boolean): void;
  /** Puts the caret on a 1-based line and scrolls it to the middle. */
  reveal(line: number): void;
  destroy(): void;
}

/** Marks text the document handed in, so it is not echoed back as an edit. */
const external = Annotation.define<boolean>();

/** The search panel's labels, in the sentence case Tau's buttons use. */
const phrases = EditorState.phrases.of({
  next: "Next", previous: "Previous", all: "All", "match case": "Match case", regexp: "Regexp",
  "by word": "By word", replace: "Replace", "replace all": "Replace all", close: "Close",
});

/** Swallows an Escape nothing in the editor used, so it never stops the agent. */
const keepEscape = Prec.lowest(keymap.of([{ key: "Escape", run: () => true }]));

export function createCodeEditor(parent: HTMLElement, options: CodeEditorOptions): CodeEditorHandle {
  const language = new Compartment();
  const readOnly = new Compartment();
  const wrap = new Compartment();
  let destroyed = false;

  const state = EditorState.create({
    doc: options.text,
    extensions: [
      lineNumbers(),
      foldGutter(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      EditorState.tabSize.of(4),
      indentUnit.of(detectIndentUnit(options.text)),
      indentOnInput(),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      phrases,
      keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
      keepEscape,
      language.of([]),
      readOnly.of(EditorState.readOnly.of(options.readOnly)),
      wrap.of(options.wrap ? EditorView.lineWrapping : []),
      tauEditorTheme,
      EditorView.contentAttributes.of({ "aria-label": options.label, spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(external))) {
          options.callbacks.onChange(update.state.doc.toString());
        }
        if (update.docChanged || update.selectionSet) {
          options.callbacks.onCaretLine?.(update.state.doc.lineAt(update.state.selection.main.head).number);
        }
      }),
    ],
  });
  const view = new EditorView({ state, parent });

  // After CodeMirror had its turn: what it did not take stays out of the workbench's bindings.
  const onKeyDown = (event: KeyboardEvent) => {
    if (editorKeyOutcome(event, options.mac) === "keep") event.stopPropagation();
  };
  view.dom.addEventListener("keydown", onKeyDown);

  const mode = editorLanguageFor(options.path);
  if (mode) {
    const apply = () => { if (!destroyed && mode.support) view.dispatch({ effects: language.reconfigure(mode.support) }); };
    if (mode.support) apply();
    else void mode.load().then(apply, () => undefined);
  }

  return {
    view,
    setText(text) {
      const current = view.state.doc;
      if (current.length === text.length && current.toString() === text) return;
      const head = Math.min(view.state.selection.main.head, text.length);
      view.dispatch({
        changes: { from: 0, to: current.length, insert: text },
        selection: EditorSelection.cursor(head),
        annotations: external.of(true),
      });
    },
    setReadOnly(value) {
      view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(value)) });
    },
    setWrap(value) {
      view.dispatch({ effects: wrap.reconfigure(value ? EditorView.lineWrapping : []) });
    },
    reveal(line) {
      const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
      view.dispatch({ selection: EditorSelection.cursor(target.from), effects: EditorView.scrollIntoView(target.from, { y: "center" }) });
      view.focus();
    },
    destroy() {
      destroyed = true;
      view.dom.removeEventListener("keydown", onKeyDown);
      view.destroy();
    },
  };
}
