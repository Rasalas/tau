/** Punctuation by position (`KeyboardEvent.code`), so ⇧ or a layout that moves a key still finds `mod+shift+]`. */
export const CODE_KEYS: Readonly<Record<string, string>> = {
  Backquote: "`", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Comma: ",", Equal: "=", Minus: "-",
  Period: ".", Quote: "'", Semicolon: ";", Slash: "/",
};
