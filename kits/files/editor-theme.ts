import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

// Every value is a Tau token, so light, dark and theme packages apply without a second theme.
const mix = (token: string, percent: number) => `color-mix(in srgb, var(${token}) ${percent}%, transparent)`;

const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--stage)", color: "var(--ink-code)", fontSize: "12px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "calc(1em + 9px * var(--density, 1))", overflow: "auto" },
  ".cm-content": { padding: "calc(12px * var(--density, 1)) 0", caretColor: "var(--ink)", tabSize: "4" },
  ".cm-line": { padding: "0 24px 0 12px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection": { backgroundColor: mix("--acid", 30) },
  ".cm-selectionBackground": { backgroundColor: mix("--acid", 16) },
  ".cm-activeLine": { backgroundColor: "var(--wash)" },
  ".cm-selectionMatch": { backgroundColor: mix("--acid", 14) },
  ".cm-searchMatch": { backgroundColor: mix("--warn", 22), outline: `1px solid ${mix("--warn", 45)}`, borderRadius: "2px" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: mix("--acid", 42) },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: mix("--acid", 22), outline: "1px solid var(--acid-line)" },
  "&.cm-focused .cm-nonmatchingBracket": { backgroundColor: "var(--danger-bg)", color: "var(--removed)" },
  ".cm-specialChar": { color: "var(--removed)" },

  ".cm-gutters": { backgroundColor: "var(--stage)", color: "var(--fainter)", border: "none", borderRight: "1px solid var(--line-soft)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 16px", minWidth: "28px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink-3)" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 6px 0 2px", color: "var(--faint)", cursor: "pointer" },
  ".cm-foldGutter .cm-gutterElement:hover": { color: "var(--ink-2)" },
  ".cm-foldPlaceholder": {
    margin: "0 4px", padding: "0 6px", border: "1px solid var(--line-control)", borderRadius: "var(--radius-xs)",
    backgroundColor: "var(--raised)", color: "var(--muted)",
  },

  ".cm-panels": { backgroundColor: "var(--chrome)", color: "var(--ink-2)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--line)" },
  ".cm-panel.cm-search": { padding: "calc(6px * var(--density, 1)) 36px calc(6px * var(--density, 1)) 12px", font: "12px var(--sans)" },
  ".cm-panel.cm-search label": { color: "var(--muted)", fontSize: "11px", whiteSpace: "nowrap" },
  ".cm-panel.cm-search input[type=checkbox]": { accentColor: "var(--acid)", verticalAlign: "middle" },
  ".cm-panel.cm-search [name=close]": { top: "50%", right: "10px", transform: "translateY(-50%)", color: "var(--muted)", fontSize: "16px", cursor: "pointer" },
  ".cm-panel.cm-search [name=close]:hover": { color: "var(--ink)" },
  ".cm-textfield": {
    margin: "2px 4px 2px 0", padding: "3px 8px", border: "1px solid var(--line-field)", borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--field)", color: "var(--ink)", font: "12px var(--mono)", outline: "none",
  },
  ".cm-textfield:focus": { borderColor: "var(--focus)" },
  ".cm-button": {
    margin: "2px 4px 2px 0", padding: "3px 9px", backgroundImage: "none", border: "1px solid var(--line-control)",
    borderRadius: "var(--radius-sm)", backgroundColor: "var(--raised)", color: "var(--ink-2)", font: "11px var(--sans)", cursor: "pointer",
  },
  ".cm-button:hover": { backgroundColor: "var(--raised-hover)", color: "var(--ink)" },
  ".cm-button:active": { backgroundImage: "none", backgroundColor: "var(--raised-strong)" },
  ".cm-tooltip": { border: "1px solid var(--line-float)", borderRadius: "var(--radius-sm)", backgroundColor: "var(--float)", color: "var(--ink-2)" },
});

/** The same colours core's highlight.js theme gives each kind of token. */
const tauHighlight = HighlightStyle.define([
  { tag: [t.comment, t.quote], color: "var(--faint)", fontStyle: "italic" },
  { tag: [t.keyword, t.bool, t.null, t.atom, t.self], color: "var(--working)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.inserted, t.character], color: "var(--ready)" },
  { tag: [t.number, t.escape, t.list], color: "var(--cyan)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.className, t.definition(t.className), t.macroName], color: "var(--syntax-fn)" },
  { tag: [t.typeName, t.standard(t.variableName), t.namespace, t.labelName], color: "var(--cyan)" },
  { tag: [t.tagName, t.heading], color: "var(--ink)" },
  { tag: t.heading, fontWeight: "600" },
  { tag: [t.attributeName, t.propertyName, t.variableName], color: "var(--ink-2)" },
  { tag: [t.meta, t.processingInstruction, t.documentMeta, t.annotation], color: "var(--muted)" },
  { tag: [t.deleted, t.invalid], color: "var(--removed)" },
  { tag: [t.link, t.url], color: "var(--cyan)", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.strikethrough, textDecoration: "line-through" },
]);

export const tauEditorTheme = [editorTheme, syntaxHighlighting(tauHighlight)];
